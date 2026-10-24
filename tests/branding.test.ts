import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultIntegrationConfig, parseIntegrationConfig } from '../src/lib/branding.ts';

const configured = () => ({ ...structuredClone(defaultIntegrationConfig), revision: 3, branding: { appName: 'Academy Games', badgeText: 'Made for Academy', accentColor: '#176a63', logoUrl: 'https://academy.example/assets/logo.svg' }, hosts: [{ id: 'academy', name: 'Academy', origin: 'https://academy.example', returnPath: '/lessons/games' }] });

test('branding and connected hosts form a bounded public configuration', () => {
  const input = configured(), result = parseIntegrationConfig(input);
  assert.deepEqual(result, input);
  result.branding.appName = 'Changed copy'; result.hosts[0].name = 'Changed host';
  assert.equal(input.branding.appName, 'Academy Games'); assert.equal(input.hosts[0].name, 'Academy');
  assert.equal(parseIntegrationConfig(defaultIntegrationConfig).branding.appName, 'Game Studio');
});

test('admin labels cannot become markup or inject styling', () => {
  for (const appName of ['', ' Name ', '<script>evil()</script>', 'A\nB', '\u0080', 'x'.repeat(81)]) assert.throws(() => parseIntegrationConfig({ ...configured(), branding: { ...configured().branding, appName } }));
  for (const accentColor of ['red', '#fff', '#176a63;background:url(evil)', 'javascript:alert(1)']) assert.throws(() => parseIntegrationConfig({ ...configured(), branding: { ...configured().branding, accentColor } }));
  assert.throws(() => parseIntegrationConfig({ ...configured(), branding: { ...configured().branding, customCss: 'body{display:none}' } }));
});

test('branding images are public HTTPS resources without credential or temporary query data', () => {
  for (const logoUrl of ['javascript:alert(1)', 'data:image/svg+xml,evil', '//other.example/x', '/assets/logo.svg', 'http://public.example/logo.svg', 'https://user:secret@example.com/logo.svg', 'https://example.com/logo.svg?token=secret', 'https://example.com/logo.svg#fragment', 'https://example.com/lo go.svg']) assert.throws(() => parseIntegrationConfig({ ...configured(), branding: { ...configured().branding, logoUrl } }));
  assert.equal(parseIntegrationConfig({ ...configured(), branding: { ...configured().branding, logoUrl: 'http://localhost:5173/logo.svg' } }).branding.logoUrl, 'http://localhost:5173/logo.svg');
});

test('approved applications require exact origins and local return paths', () => {
  for (const origin of ['https://academy.example/path', 'https://academy.example/', 'https://academy.example?token=x', 'https://user:pass@academy.example', 'http://public.example', 'null', '*']) assert.throws(() => parseIntegrationConfig({ ...configured(), hosts: [{ ...configured().hosts[0], origin }] }));
  for (const returnPath of ['//evil.example/', '/\\evil.example/', '/%2f%2fevil.example', '/lesson/../admin', '/lessons?redirect=https://evil.example']) assert.throws(() => parseIntegrationConfig({ ...configured(), hosts: [{ ...configured().hosts[0], returnPath }] }));
  assert.throws(() => parseIntegrationConfig({ ...configured(), hosts: [configured().hosts[0], configured().hosts[0]] }));
  assert.equal(parseIntegrationConfig({ ...configured(), hosts: [{ ...configured().hosts[0], origin: 'http://127.0.0.1:5174', returnPath: '/' }] }).hosts[0].origin, 'http://127.0.0.1:5174');
});

test('revisions and public routes are validated while credentials are rejected', () => {
  for (const revision of [-1, 0.1, '2', Number.NaN, 1000000001]) assert.throws(() => parseIntegrationConfig({ ...configured(), revision }));
  assert.throws(() => parseIntegrationConfig({ ...configured(), accessToken: 'not-public' }));
  const routes = { games: '/games', game: '/games/{gameId}', embed: '/embed/games/{gameId}', studio: '/game-studio' };
  assert.deepEqual(parseIntegrationConfig({ ...configured(), routes }).routes, routes);
  assert.throws(() => parseIntegrationConfig({ ...configured(), routes: { ...routes, studio: 'https://elsewhere.example/' } }));
});
