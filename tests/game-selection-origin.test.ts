import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostSelectionLink } from '../src/components/HostSelectionLink.tsx';
import { gameStudioSelectionOrigin, loadMultiplayerConfig, parseMultiplayerAPIConfig, validateMultiplayerAPIConfig } from '../src/lib/game-multiplayer.ts';
import { createHostSelectionURL, readGameSelection } from '../src/lib/integration.ts';

const actual = 'https://games.example.test', legacy = 'https://legacy.example.test';
const base = { version: 1, apiUrl: 'https://relay.example.test' };
test('public compatibility configuration accepts one exact HTTPS alias without weakening existing relay settings', () => {
  assert.deepEqual(parseMultiplayerAPIConfig(base), base);
  assert.deepEqual(parseMultiplayerAPIConfig({ ...base, legacyApplicationOrigin: legacy }), { ...base, legacyApplicationOrigin: legacy });
  assert.equal(validateMultiplayerAPIConfig({ ...base, legacyApplicationOrigin: legacy }), base.apiUrl);
  for (const value of [undefined, '', null, 1, legacy + '/', legacy + ':443', 'http://legacy.example.test', 'https://*.example.test', 'https://Legacy.example.test', 'https://user:pass@legacy.example.test', legacy + '?token=private', legacy + '#private', 'x'.repeat(256)]) {
    const invalid = { ...base, legacyApplicationOrigin: value };
    if (value === undefined) assert.equal(parseMultiplayerAPIConfig(invalid), undefined, 'explicit undefined is not a serializable configured alias');
    else assert.equal(parseMultiplayerAPIConfig(invalid), undefined);
    assert.equal(gameStudioSelectionOrigin(actual, invalid), actual);
  }
  for (const invalid of [{ ...base, token: 'private', legacyApplicationOrigin: legacy }, { ...base, role: 'admin' }, { ...base, legacyApplicationOrigin: [legacy] }]) assert.equal(parseMultiplayerAPIConfig(invalid), undefined);
});

test('existing user-clicked selection can preserve the approved legacy source without changing publication or SDK semantics', () => {
  const game = '11111111-1111-4111-8111-111111111111';
  const source = gameStudioSelectionOrigin(actual, { ...base, legacyApplicationOrigin: legacy });
  const link = createHostSelectionURL('https://academy.example.test', '/', source, game, 4);
  assert.deepEqual(readGameSelection(link, legacy), { gameId: game, publishedRevision: 4 });
  assert.equal(readGameSelection(link, actual), undefined);
  assert.equal(new URL(link).searchParams.size, 3);
  assert.equal(gameStudioSelectionOrigin(actual, base), actual);
  assert.equal(gameStudioSelectionOrigin(actual, { ...base, search: '?legacyApplicationOrigin=https://untrusted.example.test' }), actual);
});

test('selection configuration comes only from the same-origin public file with no credentials or redirects', async () => {
  const original = globalThis.fetch; const calls: { url: string; options?: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url, options) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify({ ...base, legacyApplicationOrigin: legacy })); }) as typeof fetch;
    const value = await loadMultiplayerConfig(); assert.equal(gameStudioSelectionOrigin(actual, value), legacy);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/multiplayer-config.json');
    assert.equal(calls[0].options?.credentials, 'omit'); assert.equal(calls[0].options?.redirect, 'error'); assert.equal(calls[0].options?.referrerPolicy, 'no-referrer');
    assert.equal(calls[0].options?.body, undefined); assert.equal(calls[0].options?.headers, undefined);
  } finally { globalThis.fetch = original; }
});

test('pending or unavailable connection checks expose no fallback selection link; verified aliases remain public-only', () => {
  const props = { host: { origin: 'https://academy.example.test', returnPath: '/', name: 'Academy' }, gameId: '11111111-1111-4111-8111-111111111111', publishedRevision: 4, retry() {} };
  for (const status of ['loading', 'error'] as const) {
    const html = renderToStaticMarkup(createElement(HostSelectionLink, { ...props, connection: { status } }));
    assert.doesNotMatch(html, /href=/); assert.doesNotMatch(html, /gameStudioOrigin/);
    assert.match(html, status === 'loading' ? /Checking the application connection/ : /Retry connection check/);
  }
  for (const origin of [legacy, actual]) {
    const html = renderToStaticMarkup(createElement(HostSelectionLink, { ...props, connection: { status: 'ready', origin } }));
    assert.match(html, /href=/); assert.ok(html.includes(encodeURIComponent(origin)));
    assert.doesNotMatch(html, /token|password|role=/);
  }
});
