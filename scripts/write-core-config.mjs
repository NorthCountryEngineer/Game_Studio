import { readFileSync, writeFileSync } from 'node:fs';
const [registration, apiUrl] = process.argv.slice(2);
if (!registration || !apiUrl) throw new Error('Usage: node scripts/write-core-config.mjs CORE_PUBLIC_CONFIG.json HTTPS_API_URL');
const p = JSON.parse(readFileSync(registration, 'utf8'));
function origin(value) { const u = new URL(value); if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('Use exact HTTPS origins.'); return u.origin; }
const c = { issuer: origin(p.issuer), organization_id: p.organization_id, service_id: p.service_id, browser_client_id: p.browser_client_id, redirect_uri: p.redirect_uri, api_url: origin(apiUrl) };
if (!c.organization_id || !c.service_id || !c.browser_client_id || !c.redirect_uri) throw new Error('Core registration is incomplete.');
writeFileSync('nce-config.json', JSON.stringify(c, null, 2) + '\n');
console.log('Wrote public nce-config.json. Contains no client secret.');
