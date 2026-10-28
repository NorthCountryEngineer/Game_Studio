import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { canonicalGameStudioNavigation } from '../src/lib/canonical-navigation.ts';

const old = 'https://legacy.example.test', canonical = 'https://games.example.test', callback = canonical + '/oauth/callback';
const game = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';

test('old top-level creator navigation preserves only exact public host context before sign-in', () => {
  for (const path of ['/', '/games', '/settings', '/game-studio', `/games/${game}`, '/feedback']) assert.equal(canonicalGameStudioNavigation(old + path, callback, false), canonical + path);
  const path = `/game-studio?host=academy&login=auto&game=${game}`;
  assert.equal(canonicalGameStudioNavigation(old + path, callback, false), canonical + path);
  assert.equal(canonicalGameStudioNavigation(canonical + path, callback, false), undefined);
  for (const query of ['?host=academy&host=other&login=auto', '?host=academy&login=other', '?login=auto', '?game=invalid', '?host=academy&access_token=private', '?next=https://evil.example', '?host=academy&login=auto&state=private']) assert.equal(canonicalGameStudioNavigation(old + '/game-studio' + query, callback, false), canonical + '/game-studio');
});

test('legacy SDK and approved embed pages stay on their origin, and framed pages cannot navigate the parent', () => {
  for (const path of [`/embed/games/${game}?host=academy&channel=synthetic`, '/sdk/game-studio.js']) assert.equal(canonicalGameStudioNavigation(old + path, callback, false), undefined);
  for (const path of ['/game-studio?host=academy&login=auto', `/games/${game}`, '/oauth/callback?code=private&state=private']) assert.equal(canonicalGameStudioNavigation(old + path, callback, true), undefined);
});

test('old callbacks restart safely without forwarding OAuth/session material', () => {
  assert.equal(canonicalGameStudioNavigation(old + '/oauth/callback?code=private&state=private&iss=https://core.example#access_token=private', callback, false), canonical + '/game-studio');
  assert.equal(canonicalGameStudioNavigation(old + '/games?access_token=private#refresh_token=private', callback, false), canonical + '/games');
  for (const invalid of ['http://games.example.test/oauth/callback', canonical + '/other', canonical + '/oauth/callback?next=private', 'https://user:pass@games.example.test/oauth/callback']) assert.throws(() => canonicalGameStudioNavigation(old + '/game-studio', invalid, false));
});

test('valid room hints and invitation fragments survive canonical public-game navigation without query credentials', () => {
  const invite = `#coop=${room}.${'A'.repeat(43)}`;
  assert.equal(canonicalGameStudioNavigation(old + `/games/${game}` + invite, callback, false), canonical + `/games/${game}` + invite);
  assert.equal(canonicalGameStudioNavigation(old + `/games/${game}?room=${room}`, callback, false), canonical + `/games/${game}?room=${room}`);
  for (const suffix of ['?room=invalid', `?room=${room}&room=${room}`, `?room=${room}&token=private`, '#access_token=private', `#coop=${room}.invalid`]) assert.equal(canonicalGameStudioNavigation(old + `/games/${game}` + suffix, callback, false), canonical + `/games/${game}`);
  assert.equal(new URL(canonicalGameStudioNavigation(old + '//evil.example/path?token=private', callback, false)!).origin, canonical);
});

test('the production entry redirects before React mounts, while legacy embeds mount normally', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  function run(path: string) {
    let mounted = 0; const redirects: string[] = [];
    const modules: Record<string, unknown> = { react: { Component: class {}, StrictMode: 'STRICT' }, 'react-dom/client': { createRoot: () => { mounted++; return { render() {} }; } }, './lib/core': { isCore: true, coreConfig: { redirect_uri: callback } }, './lib/canonical-navigation': { canonicalGameStudioNavigation }, 'react/jsx-runtime': { jsx: () => ({}) } };
    const window: any = {}; window.self = window.top = window;
    vm.runInNewContext(js, { exports: {}, require: (name: string) => modules[name] || {}, document: { getElementById: () => ({}) }, location: { href: old + path, replace: (url: string) => redirects.push(url) }, window });
    return { mounted, redirects };
  }
  assert.deepEqual(run('/game-studio?host=academy&login=auto'), { mounted: 0, redirects: [canonical + '/game-studio?host=academy&login=auto'] });
  assert.deepEqual(run(`/embed/games/${game}`), { mounted: 1, redirects: [] });
});
