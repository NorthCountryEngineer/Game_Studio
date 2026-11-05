/** Build the isolated local-file board. This script never reads deployment configuration. */
import { build, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFLINE_HEALTH_HTML = 'Drugs-and-Decision-Making.html';
export const OFFLINE_HEALTH_ZIP = 'Gracies-Health-Game-Mac.zip';
export const OFFLINE_HEALTH_ASSET_PATHS = Object.freeze([
  'branding/health-school-logo.png',
  ...['fox','panda','frog','owl','dragon','penguin','robot','unicorn'].map(name => `pieces/${name}.svg`),
  'templates/quiz-circuit-questions.txt', 'templates/quiz-circuit-questions.json',
  'templates/gracies-questions.txt', 'templates/gracies-questions.json',
]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_PARTY = new Set([
  'src/offline-health.tsx', 'src/offline-health.css', 'src/components/QuestionQuest.tsx', 'src/question-quest.css',
  'src/lib/question-quest.ts', 'src/lib/question-quest-import.ts', 'src/lib/question-quest-sources.ts',
  'src/lib/question-quest-backup.ts', 'src/lib/question-quest-id.ts', 'src/lib/gracie-questions.ts', 'src/data/gracie-questions.json',
]);
const PACKAGES = new Set(['react','react-dom','scheduler']);
const BLOCKED_IDENTIFIERS = new Set(['fetch','XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker','importScripts','sendBeacon','serviceWorker','WebTransport','RTCPeerConnection','eval','Function']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = path => path.split(sep).join('/');
const comparePaths = (a,b) => a < b ? -1 : a > b ? 1 : 0;
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
function packageName(path) { const match = /(?:^|\/)node_modules\/([^/]+)/.exec(path); return match?.[1]; }
function allowedPackage(path) { return path.startsWith('node_modules/') && !path.split('/').includes('..') && PACKAGES.has(packageName(path)); }

export function assertOfflineHealthSource(path, text) {
  if (!/\.[cm]?[jt]sx?$/.test(path) || !path.startsWith('src/')) return;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isIdentifier(node) && BLOCKED_IDENTIFIERS.has(node.text)) throw new Error(`Offline code cannot use ${node.text}: ${path}`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`Offline code cannot use dynamic imports: ${path}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

export async function assertOfflineHealthGraph(metafile, root = ROOT) {
  const inputs = {};
  for (const [rawPath, input] of Object.entries(metafile.inputs)) {
    const path = slash(rawPath);
    if (path === '<define:__OFFLINE_HEALTH_ASSETS__>') {
      requireCondition(input.imports.length === 0, 'The embedded asset definition cannot import resources.');
      continue; // Its exact source files are hashed separately below.
    }
    requireCondition(FIRST_PARTY.has(path) || allowedPackage(path), `Unexpected offline dependency: ${path}`);
    requireCondition(input.imports.every(item => !item.external || item.path === '<define:__OFFLINE_HEALTH_ASSETS__>'), `External dependency in offline bundle: ${path}`);
    const bytes = await readFile(resolve(root, rawPath));
    assertOfflineHealthSource(path, bytes.toString('utf8'));
    inputs[path] = sha256(bytes);
  }
  for (const [path, output] of Object.entries(metafile.outputs)) requireCondition(output.imports.length === 0, `Offline output has an external import: ${path}`);
  return inputs;
}

function mime(path) { return path.endsWith('.png') ? 'image/png' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.json') ? 'application/json' : 'text/plain;charset=utf-8'; }
export function assertOfflineHealthSvg(svg) {
  requireCondition(/<svg\b/.test(svg) && !/<(?:script|foreignObject|iframe|style)|\bon\w+\s*=|\b(?:href|src|style)\s*=|url\s*\(|<!DOCTYPE|<!ENTITY|<\?/i.test(svg), 'Offline SVGs must be static artwork without active content or resource references.');
}
function scriptPolicy(js) {
  const hash = createHash('sha256').update(js).digest('base64');
  return `default-src 'none'; script-src 'sha256-${hash}'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'`;
}

/** Verify the shipped artifact independently of filenames or the source entry graph. */
export async function verifyOfflineHealthArtifacts(files, options = {}) {
  const names = ['Drugs-and-Decision-Making.html','START-HERE.txt','THIRD-PARTY-NOTICES.txt','gracies-questions.txt','gracies-questions.json','MANIFEST.json'];
  requireCondition(Object.keys(files).length === names.length && names.every(name => Object.hasOwn(files,name)), 'The offline package has missing or unexpected files.');
  const manifest = JSON.parse(Buffer.from(files['MANIFEST.json']).toString('utf8'));
  requireCondition(manifest.format === 1 && manifest.build?.format === 'iife', 'Unknown offline manifest format.');
  requireCondition(Object.keys(manifest.artifactSha256).length === names.length - 1, 'Offline manifest artifact inventory differs.');
  for (const name of names.filter(name => name !== 'MANIFEST.json')) requireCondition(sha256(files[name]) === manifest.artifactSha256[name], `Offline artifact hash differs: ${name}`);
  const inputs = Object.fromEntries(Object.entries(manifest.inputSha256).sort(([a],[b]) => comparePaths(a,b)));
  requireCondition(sha256(JSON.stringify({format:1,esbuildVersion:manifest.build.version,inputs})) === manifest.sourceFingerprint, 'Offline source fingerprint differs.');
  for (const [path,hash] of Object.entries(inputs)) {
    const allowed = FIRST_PARTY.has(path) || allowedPackage(path) || ['scripts/build-offline-health.mjs','package.json','package-lock.json','NOTICE.md','node_modules/esbuild/LICENSE.md',...OFFLINE_HEALTH_ASSET_PATHS.map(path => 'public/'+path)].includes(path);
    requireCondition(allowed && !path.startsWith('/') && !path.split('/').includes('..') && /^[0-9a-f]{64}$/.test(hash), 'Unsafe source manifest input.');
    if (options.root) requireCondition(sha256(await readFile(resolve(options.root,path))) === hash, `Offline source input changed: ${path}`);
  }
  const html = Buffer.from(files[OFFLINE_HEALTH_HTML]).toString('utf8');
  const match = /<script>([\s\S]*)<\/script><\/body><\/html>\n$/.exec(html);
  requireCondition(match && !/<\/script/i.test(match[1]), 'The offline HTML must contain one complete inline script.');
  const js = match[1], beforeScript = html.slice(0,match.index);
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(beforeScript)?.[1];
  requireCondition(policy === scriptPolicy(js), 'Offline script hash or network-blocking CSP differs.');
  const cssMatch = /<style>([\s\S]*?)<\/style>/.exec(beforeScript);
  requireCondition(cssMatch && !/@import|url\s*\(/i.test(cssMatch[1]), 'Offline CSS contains an external resource.');
  const structural = beforeScript.replace(cssMatch[0],'').replace(/<noscript>[\s\S]*?<\/noscript>/,'');
  requireCondition(!/<(?:script|link|iframe|object|embed|base|form)\b|\s(?:src|on\w+)\s*=/i.test(structural), 'Offline HTML contains an unexpected resource or active element.');
  assertOfflineHealthSource('src/offline-built-script.js',js);
  const embedded = [...js.matchAll(/"(\/(?:branding|pieces|templates)\/[^"\\]+)":"(data:[^"\\]+)"/g)];
  const found = new Map(embedded.map(([,path,url]) => [path,url]));
  requireCondition(found.size === OFFLINE_HEALTH_ASSET_PATHS.length && embedded.length === found.size, 'Offline embedded asset inventory differs.');
  for (const path of OFFLINE_HEALTH_ASSET_PATHS) {
    const url = found.get('/'+path), prefix = `data:${mime(path)};base64,`;
    requireCondition(url?.startsWith(prefix), `Offline asset is not embedded with the correct type: ${path}`);
    const bytes = Buffer.from(url.slice(prefix.length),'base64');
    requireCondition(bytes.length > 0 && sha256(bytes) === inputs['public/'+path], `Offline embedded asset changed: ${path}`);
  }
  const count = JSON.parse(Buffer.from(files['gracies-questions.json']).toString('utf8')).questions.length;
  requireCondition(count === manifest.questionCount, 'Offline question count differs from its template.');
  return {sourceFingerprint:manifest.sourceFingerprint,htmlSha256:sha256(files[OFFLINE_HEALTH_HTML]),questionCount:count};
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

/** Standard ZIP with stored entries and a fixed date; no platform-specific archiver is needed. */
export function deterministicOfflineZip(files) {
  const local = [], central = []; let offset = 0;
  for (const name of Object.keys(files).sort()) {
    requireCondition(/^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('/') && !name.split('/').includes('..'), 'Unsafe ZIP member.');
    const filename = Buffer.from(name), bytes = Buffer.from(files[name]), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x5c21,12); header.writeUInt32LE(crc,14); header.writeUInt32LE(bytes.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(filename.length,26);
    local.push(header,filename,bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6); directory.writeUInt16LE(0x5c21,14); directory.writeUInt32LE(crc,16); directory.writeUInt32LE(bytes.length,20); directory.writeUInt32LE(bytes.length,24); directory.writeUInt16LE(filename.length,28); directory.writeUInt32LE(offset,42);
    central.push(directory,filename); offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count,8); end.writeUInt16LE(count,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

const START_HERE = `DRUGS AND DECISION-MAKING
10th Grade Health - Mac offline copy

PLAY WITHOUT AN INTERNET CONNECTION
1. Double-click Drugs-and-Decision-Making.html.
   If it opens as text, Control-click it, choose Open With, then Safari or Firefox.
2. Click Use Gracie's Questions to load the reviewed 19-question bank.
   You can also upload a question TXT/JSON file or enter questions one at a time.
3. Set up the four teams and use Full screen when projecting the board.

No installation, terminal commands, account, internet connection, local server,
Node, Python, Docker or Kubernetes is required to play. Safari comes with the Mac.
This HTML file contains the game, styles, school logo, all eight pieces, question
templates, the reviewed question bank, citations and explanations. You can copy
just the HTML file to another Mac and it will still open.

SAVE YOUR GAME
Use Save game backup before closing the browser or moving to another computer.
Keep the downloaded JSON file. On the other Mac, open the game and choose Restore
game backup, review the summary, then choose Restore this game.
Browser saves for local files vary. Moving or renaming the HTML file, changing
browsers, private browsing or clearing browser data may not preserve that save.
The backup file carries your questions, sources, teams, points, dice and progress.
Keep private question banks and backups on devices you control.

QUESTION FILES
gracies-questions.txt and gracies-questions.json contain the same 19 questions.
Edit either format offline and upload one file, not both. Importing appends to
the existing bank; the prepared button skips exact questions already present.

SOURCES
The included source addresses, citations and explanations are readable offline.
Links labelled Read source (requires internet) open the original publisher only
when you choose them. Opening a publisher's website requires a connection.

This package contains only the shared-screen health board. It does not include
online Game Studio accounts, multiplayer rooms, leaderboards or AI services.
MANIFEST.json records the source fingerprint and exact file hashes for this copy.
THIRD-PARTY-NOTICES.txt contains bundled library notices.
`;

export async function buildOfflineHealth(options = {}) {
  const root = options.root ?? ROOT, outputDirectory = options.outputDirectory ?? resolve(root,'offline/mac'), releaseDirectory = options.releaseDirectory ?? resolve(root,'dist/offline-health');
  const assets = {}, sourceInputs = {};
  for (const path of OFFLINE_HEALTH_ASSET_PATHS) {
    const bytes = await readFile(resolve(root,'public',path)); requireCondition(bytes.length > 0, `Empty offline asset: ${path}`);
    if (path.endsWith('.svg')) {
      assertOfflineHealthSvg(bytes.toString('utf8'));
    }
    assets['/'+path] = `data:${mime(path)};base64,${bytes.toString('base64')}`;
    sourceInputs['public/'+path] = sha256(bytes);
  }
  const result = await build({ absWorkingDir: root, entryPoints:['src/offline-health.tsx'], bundle:true, write:false, metafile:true, minify:true, format:'iife', platform:'browser', target:['safari16.4','firefox115'], jsx:'automatic', charset:'ascii', legalComments:'none', preserveSymlinks:true, outfile:'offline-health.js', define:{'process.env.NODE_ENV':'"production"','__OFFLINE_HEALTH_ASSETS__':JSON.stringify(assets)}, logLevel:'silent' });
  const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text, css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  requireCondition(js && css, 'The offline JavaScript and CSS must both be bundled.');
  requireCondition(!/<\/script/i.test(js), 'Unsafe script closing sequence in offline bundle.');
  requireCondition(!/@import|url\s*\(|<\/style/i.test(css), 'Offline CSS cannot load other resources.');
  Object.assign(sourceInputs, await assertOfflineHealthGraph(result.metafile,root));
  const licenseInputs = [['React','node_modules/react/LICENSE'],['React DOM','node_modules/react-dom/LICENSE'],['Scheduler','node_modules/scheduler/LICENSE'],['esbuild build tool','node_modules/esbuild/LICENSE.md']];
  let notices = 'OFFLINE HEALTH BOARD\n\nGame Studio is maintained by NorthCountryEngineer. The supplied school logo and\noriginal game artwork retain their owners\' rights. Question-source citations are\nincluded in the game and question files. This package does not change ownership\nof that material. System fonts are used; no font files are downloaded.\n\n';
  for (const [name,path] of licenseInputs) { const bytes = await readFile(resolve(root,path)); sourceInputs[path] = sha256(bytes); notices += `${name}\n${'='.repeat(name.length)}\n${bytes.toString('utf8').trim()}\n\n`; }
  for (const path of ['scripts/build-offline-health.mjs','package.json','package-lock.json','NOTICE.md']) { const bytes = await readFile(resolve(root,path)); sourceInputs[path] = sha256(bytes); }
  const sortedInputs = Object.fromEntries(Object.entries(sourceInputs).sort(([a],[b]) => comparePaths(a,b)));
  const sourceFingerprint = sha256(JSON.stringify({format:1,esbuildVersion,inputs:sortedInputs}));
  const policy = scriptPolicy(js);
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><title>10th Grade Health: Drugs &amp; Decision-Making</title><style>${css}</style></head><body><div id="offline-health-root"></div><noscript><p class="offline-noscript">Enable JavaScript in this browser to play the offline health game. No installation or internet connection is required.</p></noscript><script>${js}</script></body></html>\n`;
  const files = {[OFFLINE_HEALTH_HTML]:Buffer.from(html),'START-HERE.txt':Buffer.from(START_HERE),'THIRD-PARTY-NOTICES.txt':Buffer.from(notices),'gracies-questions.txt':await readFile(resolve(root,'public/templates/gracies-questions.txt')),'gracies-questions.json':await readFile(resolve(root,'public/templates/gracies-questions.json'))};
  const questionCount = JSON.parse(await readFile(resolve(root,'src/data/gracie-questions.json'),'utf8')).questions.length;
  const manifest = {format:1,product:'10th Grade Health: Drugs & Decision-Making',target:'Mac local HTML in Safari or Firefox; Intel and Apple silicon',sourceFingerprint,build:{bundler:'esbuild',version:esbuildVersion,format:'iife',networkRequestsRequired:false,productionConfigurationRead:false},questionCount,embeddedAssets:OFFLINE_HEALTH_ASSET_PATHS.map(path => '/'+path).sort(),inputSha256:sortedInputs,artifactSha256:Object.fromEntries(Object.entries(files).sort(([a],[b]) => comparePaths(a,b)).map(([name,bytes]) => [name,sha256(bytes)])),runtime:{installationRequired:false,serverRequired:false,accountRequired:false,externalExecutableResources:false,networkConnections:'blocked by CSP',persistence:'Browser storage plus explicit portable JSON backups'}};
  files['MANIFEST.json'] = Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  await verifyOfflineHealthArtifacts(files,{root});
  await mkdir(outputDirectory,{recursive:true});
  for (const [name,bytes] of Object.entries(files)) await writeFile(resolve(outputDirectory,name),bytes);
  const zipFiles = Object.fromEntries(Object.entries(files).map(([name,bytes]) => [`Gracies-Health-Game-Mac/${name}`,bytes])), zip = deterministicOfflineZip(zipFiles);
  await mkdir(releaseDirectory,{recursive:true}); await writeFile(resolve(releaseDirectory,OFFLINE_HEALTH_ZIP),zip); await writeFile(resolve(releaseDirectory,'ZIP_SHA256.txt'),`${sha256(zip)}  ${OFFLINE_HEALTH_ZIP}\n`);
  return {sourceFingerprint,htmlSha256:sha256(files[OFFLINE_HEALTH_HTML]),zipSha256:sha256(zip),questionCount,outputDirectory,zipPath:resolve(releaseDirectory,OFFLINE_HEALTH_ZIP),files,manifest};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildOfflineHealth();
  console.log(JSON.stringify({html:slash(relative(ROOT,resolve(built.outputDirectory,OFFLINE_HEALTH_HTML))),zip:slash(relative(ROOT,built.zipPath)),sourceFingerprint:built.sourceFingerprint,htmlSha256:built.htmlSha256,zipSha256:built.zipSha256,questionCount:built.questionCount},null,2));
}
