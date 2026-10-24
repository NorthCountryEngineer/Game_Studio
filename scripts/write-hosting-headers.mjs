/** Generate hosting-only headers. Does not contact AWS or execute a provider. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateHostingConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'branding,hosts,version' || value.version !== 1 || !Array.isArray(value.hosts) || value.hosts.length > 20) throw new Error('Expected version 1 Game Studio configuration and bounded hosts.');
  const plain = text => typeof text === 'string' && text.length >= 1 && text.length <= 80 && text.trim() === text && !/[\u0000-\u001f\u007f-\u009f<>]/.test(text);
  const brand = value.branding;
  if (!brand || typeof brand !== 'object' || Array.isArray(brand) || Object.keys(brand).some(key => !['appName', 'badgeText', 'accentColor', 'logoUrl'].includes(key)) || !plain(brand.appName) || !plain(brand.badgeText) || typeof brand.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(brand.accentColor)) throw new Error('Branding requires plain names and a six-digit color.');
  if (brand.logoUrl !== undefined) {
    const logo = new URL(brand.logoUrl);
    if (typeof brand.logoUrl !== 'string' || brand.logoUrl.length > 2048 || logo.protocol !== 'https:' || logo.username || logo.password || logo.search || logo.hash || /[\\\s<>\u0000-\u001f\u007f-\u009f]/.test(brand.logoUrl)) throw new Error('The optional logo requires a plain HTTPS URL without query or credentials.');
  }
  const ids = new Set();
  const origins = new Set();
  for (const host of value.hosts) {
    if (!host || typeof host !== 'object' || Array.isArray(host) || Object.keys(host).sort().join(',') !== 'id,name,origin,returnPath' || typeof host.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(host.id) || ids.has(host.id) || !plain(host.name)) throw new Error('Embedding hosts require unique IDs and names.');
    const url = new URL(host.origin);
    if (url.protocol !== 'https:' || url.origin !== host.origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-zA-Z0-9.:-]+$/.test(url.host)) throw new Error('Embedding hosts require exact HTTPS origins, without a wildcard or path.');
    if (origins.has(host.origin)) throw new Error('Embedding origins must be unique.');
    if (typeof host.returnPath !== 'string' || !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(host.returnPath) || host.returnPath.length > 500 || host.returnPath.split('/').some(part => part === '.' || part === '..')) throw new Error('A return path must be a simple same-origin absolute path.');
    ids.add(host.id); origins.add(host.origin);
  }
  return value;
}

const headers = pairs => pairs.map(([key, value]) => ({ key, value }));
export function hostingHeaders(config) {
  const value = validateHostingConfig(config);
  // Do not put framing headers on '**': Amplify applies every matching pattern.
  // Do not add a parent script-src: the sandboxed srcDoc player has a per-run nonce.
  const rules = [{ pattern: '**', headers: headers([
    ['Strict-Transport-Security', 'max-age=31536000'], ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'no-referrer'], ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'],
  ]) }];
  for (const pattern of ['/', '/index.html', '/games', '/games/**', '/game-studio', '/game-studio/**', '/studio', '/studio/**', '/oauth/**', '/settings', '/settings/**', '/accounts', '/accounts/**', '/agents', '/agents/**', '/feedback', '/feedback/**']) {
    rules.push({ pattern, headers: headers([
      ['X-Frame-Options', 'DENY'], ['Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"], ['Cache-Control', 'no-store'],
    ]) });
  }
  rules.push({ pattern: '/sdk/**', headers: headers([
    ['Access-Control-Allow-Origin', '*'], ['Cross-Origin-Resource-Policy', 'cross-origin'],
  ]) });
  const ancestors = value.hosts.length ? value.hosts.map(host => host.origin).join(' ') : "'none'";
  rules.push({ pattern: '/embed/games/**', headers: headers([
    ['Content-Security-Policy', `frame-ancestors ${ancestors}; object-src 'none'; base-uri 'self'`], ['Cache-Control', 'no-store'],
  ]) });
  return { customHeaders: rules };
}
export function renderHeaders(config) {
  const quote = value => JSON.stringify(value);
  return 'customHeaders:\n' + hostingHeaders(config).customHeaders.map(rule =>
    `  - pattern: ${quote(rule.pattern)}\n    headers:\n` + rule.headers.map(header =>
      `      - key: ${quote(header.key)}\n        value: ${quote(header.value)}\n`).join('')).join('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : 'customHttp.yml';
  if (outputIndex >= 0) args.splice(outputIndex, 2);
  if (args.length > 1 || !output) throw new Error('Usage: node scripts/write-hosting-headers.mjs [STUDIO_CONFIG.json] [--output PATH]');
  const raw = args[0] ? readFileSync(args[0], 'utf8') : process.env.GAME_STUDIO_CONFIG_JSON;
  if (!raw) throw new Error('Supply a Game Studio config file or GAME_STUDIO_CONFIG_JSON; publishing unbound embeds is blocked.');
  const config = JSON.parse(raw);
  writeFileSync(output, renderHeaders(config));
  console.log(`Wrote ${output} for ${config.hosts.length} exact embedding hosts. No resources were deployed.`);
}
