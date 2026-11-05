import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildOfflineHealth, verifyOfflineHealthArtifacts, assertOfflineHealthGraph, assertOfflineHealthSource, assertOfflineHealthSvg, deterministicOfflineZip } from '../scripts/build-offline-health.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const built = (async () => {
  const directory = await mkdtemp(resolve(tmpdir(),'offline-health-package-'));
  try { return await buildOfflineHealth({outputDirectory:resolve(directory,'mac'),releaseDirectory:resolve(directory,'release')}); }
  finally { await rm(directory,{recursive:true,force:true}); }
})();
function copy(files: Record<string,Buffer>) { return Object.fromEntries(Object.entries(files).map(([name,bytes]) => [name,Buffer.from(bytes)])); }
function change(files: Record<string,Buffer>,name: string,text: string) {
  files[name] = Buffer.from(text);
  const manifest = JSON.parse(files['MANIFEST.json'].toString()); manifest.artifactSha256[name] = hash(files[name]); files['MANIFEST.json'] = Buffer.from(JSON.stringify(manifest));
}
function changeScript(files: Record<string,Buffer>,mutate: (script:string)=>string) {
  let html = files['Drugs-and-Decision-Making.html'].toString();
  html = html.replace(/<script>([\s\S]*)<\/script><\/body>/,(_all,script)=>`<script>${mutate(script)}</script></body>`);
  const script = /<script>([\s\S]*)<\/script><\/body>/.exec(html)![1], hash = createHash('sha256').update(script).digest('base64');
  html = html.replace(/'sha256-[^']+'/g,`'sha256-${hash}'`); change(files,'Drugs-and-Decision-Making.html',html);
}

test('the actual standalone package includes the complete bank and embedded resources without Core or an external runtime', async () => {
  const result = await built, checked = await verifyOfflineHealthArtifacts(result.files,{root});
  assert.equal(checked.questionCount,19); assert.equal(checked.htmlSha256,result.htmlSha256);
  const html = result.files['Drugs-and-Decision-Making.html'].toString();
  assert.match(html,/connect-src 'none'/); assert.doesNotMatch(html,/script-src[^;]*(?:unsafe-inline|unsafe-eval)/);
  assert.doesNotMatch(html,/<script\s+src=|<script[^>]*type="module"|<link\b/);
  assert.ok(result.manifest.inputSha256['src/components/QuestionQuest.tsx']);
  assert.ok(!Object.keys(result.manifest.inputSha256).some(path => /App\.tsx|core-auth|api-client|nce-config|\.env/.test(path)));
  assert.equal(result.manifest.embeddedAssets.length,13);
  assert.match(result.files['START-HERE.txt'].toString(),/No installation/);
  assert.match(result.files['THIRD-PARTY-NOTICES.txt'].toString(),/Permission is hereby granted/);
});

test('rebuilding the same exact inputs produces identical HTML manifest and complete ZIP bytes', async () => {
  const first = await built, directory = await mkdtemp(resolve(tmpdir(),'offline-health-repeat-'));
  const environment = {VITE_APP_MODE:'nce',NCE_PUBLIC_CONFIG_JSON:'SYNTHETIC_CONFIGURATION_MUST_NOT_BE_EMBEDDED',GAME_STUDIO_CONFIG_JSON:'SYNTHETIC_SERVICE_CONFIGURATION_MUST_NOT_BE_EMBEDDED'};
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key,process.env[key]]));
  try {
    Object.assign(process.env,environment);
    const second = await buildOfflineHealth({outputDirectory:resolve(directory,'mac'),releaseDirectory:resolve(directory,'release')});
    assert.deepEqual(first.files,second.files); assert.equal(first.sourceFingerprint,second.sourceFingerprint); assert.equal(first.zipSha256,second.zipSha256);
    assert.doesNotMatch(second.files['Drugs-and-Decision-Making.html'].toString(),/SYNTHETIC_.*CONFIGURATION_MUST_NOT_BE_EMBEDDED/);
  } finally {
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory,{recursive:true,force:true});
  }
});

test('resource dependency and runtime capability checks reject service imports even before browser execution', async () => {
  for (const dependency of ['src/App.tsx','src/lib/core-auth.ts','node_modules/@aws-sdk/client-bedrock/index.js','../node_modules/react/hidden.js']) await assert.rejects(assertOfflineHealthGraph({inputs:{[dependency]:{imports:[]}},outputs:{}},root),/Unexpected offline dependency/);
  await assert.rejects(assertOfflineHealthGraph({inputs:{'src/offline-health.tsx':{imports:[{external:true,path:'https://example.invalid/runtime.js'}]}},outputs:{}},root),/External dependency/);
  await assert.rejects(assertOfflineHealthGraph({inputs:{},outputs:{'offline.js':{imports:[{path:'runtime.js'}]}}},root),/external import/);
  for (const code of ['fetch("https://example.invalid")','new WebSocket("wss://example.invalid")','navigator.sendBeacon("https://example.invalid", "x")','import("./service.js")','new Function("return 1")']) assert.throws(()=>assertOfflineHealthSource('src/synthetic.ts',code),/Offline code cannot/);
});

test('artifact and source fingerprints detect byte tampering and changed source bindings', async () => {
  const result = await built;
  const corrupted = copy(result.files); corrupted['START-HERE.txt'] = Buffer.from('Replaced instructions'); await assert.rejects(verifyOfflineHealthArtifacts(corrupted),/artifact hash differs/);
  const stale = copy(result.files), manifest = JSON.parse(stale['MANIFEST.json'].toString()); manifest.inputSha256['src/components/QuestionQuest.tsx'] = '0'.repeat(64); stale['MANIFEST.json'] = Buffer.from(JSON.stringify(manifest));
  await assert.rejects(verifyOfflineHealthArtifacts(stale),/source fingerprint differs/);
  manifest.sourceFingerprint = hash(JSON.stringify({format:1,esbuildVersion:manifest.build.version,inputs:Object.fromEntries(Object.entries(manifest.inputSha256).sort(([a],[b])=>a<b?-1:a>b?1:0))})); stale['MANIFEST.json'] = Buffer.from(JSON.stringify(manifest));
  await assert.rejects(verifyOfflineHealthArtifacts(stale,{root}),/source input changed/);
  manifest.inputSha256['nce-config.json'] = '0'.repeat(64); manifest.sourceFingerprint = hash(JSON.stringify({format:1,esbuildVersion:manifest.build.version,inputs:Object.fromEntries(Object.entries(manifest.inputSha256).sort(([a],[b])=>a<b?-1:a>b?1:0))})); stale['MANIFEST.json'] = Buffer.from(JSON.stringify(manifest));
  await assert.rejects(verifyOfflineHealthArtifacts(stale),/Unsafe source manifest input/);
});

test('rewriting file hashes does not permit a relaxed CSP external resources or new network code', async () => {
  const result = await built;
  for (const mutation of [(html:string)=>html.replace("connect-src 'none'","connect-src https:"),(html:string)=>html.replace('<style>','<style>@import "https://example.invalid/style.css";'),(html:string)=>html.replace('</head>','<script src="https://example.invalid/runtime.js"></script></head>')]) {
    const files = copy(result.files); change(files,'Drugs-and-Decision-Making.html',mutation(files['Drugs-and-Decision-Making.html'].toString())); await assert.rejects(verifyOfflineHealthArtifacts(files),/CSP differs|external resource|unexpected resource/);
  }
  const script = copy(result.files); changeScript(script,js=>'fetch("https://example.invalid");'+js); await assert.rejects(verifyOfflineHealthArtifacts(script),/Offline code cannot use fetch/);
  const assets = copy(result.files); changeScript(assets,js=>js.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/,'data:image/png;base64,Y2hhbmdlZA==')); await assert.rejects(verifyOfflineHealthArtifacts(assets),/embedded asset changed/);
});

test('static artwork checks reject active SVGs and all resource references; ZIP names cannot escape the game folder', () => {
  assert.doesNotThrow(()=>assertOfflineHealthSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'));
  for (const svg of ['<svg><script>alert(1)</script></svg>','<svg onload="alert(1)"></svg>','<svg><image href="https://example.invalid/x"/></svg>','<svg><image href="file:///private/x"/></svg>','<svg style="fill:url(https://example.invalid/x)"></svg>','<!DOCTYPE svg><svg/>']) assert.throws(()=>assertOfflineHealthSvg(svg),/static artwork/);
  assert.throws(()=>deterministicOfflineZip({'../outside.html':Buffer.from('x')}),/Unsafe ZIP member/);
  assert.throws(()=>deterministicOfflineZip({'/absolute.html':Buffer.from('x')}),/Unsafe ZIP member/);
});
