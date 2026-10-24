import test from 'node:test';
import assert from 'node:assert/strict';
// Deployment tooling is plain JS and runs independently of the application.
// @ts-expect-error the CLI helper intentionally has no application declaration
import { hostingHeaders } from '../scripts/write-hosting-headers.mjs';
const config = { version: 1, branding: { appName: 'Test', badgeText: 'Test', accentColor: '#245f57' }, hosts: [{ id: 'academy', name: 'Academy', origin: 'https://academy.example.com', returnPath: '/lessons' }] };

test('embedding headers permit only deployment-bound exact hosts', () => {
  const rules = hostingHeaders(config).customHeaders;
  const embed = rules.find((r: {pattern: string}) => r.pattern === '/embed/games/**');
  assert.equal(embed.headers.find((h: {key: string}) => h.key === 'X-Frame-Options'), undefined);
  assert.match(embed.headers.find((h: {key: string}) => h.key === 'Content-Security-Policy').value, /^frame-ancestors https:\/\/academy\.example\.com;/);
  const global = rules.find((r: {pattern: string}) => r.pattern === '**');
  assert.equal(global.headers.some((h: {key: string}) => ['X-Frame-Options', 'Content-Security-Policy'].includes(h.key)), false);
});

test('creator OAuth and settings responses explicitly deny framing', () => {
  const rules = hostingHeaders(config).customHeaders;
  for (const pattern of ['/game-studio', '/game-studio/**', '/oauth/**', '/settings', '/settings/**']) {
    const rule = rules.find((r: {pattern: string}) => r.pattern === pattern);
    assert.equal(rule.headers.find((h: {key: string}) => h.key === 'X-Frame-Options').value, 'DENY');
    assert.match(rule.headers.find((h: {key: string}) => h.key === 'Content-Security-Policy').value, /frame-ancestors 'none'/);
  }
});

test('no configured hosts produces non-frameable embed responses', () => {
  const embed = hostingHeaders({...config, hosts: []}).customHeaders.find((r: {pattern: string}) => r.pattern === '/embed/games/**');
  assert.match(embed.headers[0].value, /^frame-ancestors 'none';/);
});

test('wildcard origins, duplicate hosts and open redirects are rejected', () => {
  for (const changes of [{origin: 'https://*.example.com'}, {origin: 'https://example.com/path'}, {returnPath: '//evil.example'}, {returnPath: '/safe/../evil'}]) {
    assert.throws(() => hostingHeaders({...config, hosts: [{...config.hosts[0], ...changes}]}));
  }
  assert.throws(() => hostingHeaders({...config, hosts: [config.hosts[0], config.hosts[0]]}));
});

test('public SDK modules support cross-origin import without widening API CORS', () => {
  const rules = hostingHeaders(config).customHeaders;
  const sdk = rules.find((r: {pattern: string}) => r.pattern === '/sdk/**');
  assert.equal(sdk.headers.find((h: {key: string}) => h.key === 'Access-Control-Allow-Origin').value, '*');
  assert.equal(rules.filter((r: {headers: Array<{key: string}>}) => r.headers.some(h => h.key === 'Access-Control-Allow-Origin')).length, 1);
});
