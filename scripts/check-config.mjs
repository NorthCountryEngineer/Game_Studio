import { readFileSync, writeFileSync } from 'node:fs';
if (process.env.VITE_APP_MODE !== 'nce') throw new Error('Production requires VITE_APP_MODE=nce. Use npm run build:preview for a free local preview.');
if (process.env.NCE_PUBLIC_CONFIG_JSON) writeFileSync('nce-config.json', process.env.NCE_PUBLIC_CONFIG_JSON);
// Core deployment console supplies the same public values individually.
else if (process.env.VITE_CORE_ISSUER) writeFileSync('nce-config.json',JSON.stringify({issuer:process.env.VITE_CORE_ISSUER,organization_id:process.env.VITE_CORE_ORGANIZATION_ID,service_id:process.env.VITE_CORE_SERVICE_ID,browser_client_id:process.env.VITE_CORE_BROWSER_CLIENT_ID,redirect_uri:process.env.VITE_CORE_REDIRECT_URI || process.env.VITE_APPLICATION_ORIGIN + '/oauth/callback',api_url:process.env.VITE_API_URL}));
const c=JSON.parse(readFileSync('nce-config.json','utf8'));
const keys=['issuer','organization_id','service_id','browser_client_id','redirect_uri','api_url'];
if(Object.keys(c).some(key=>!keys.includes(key)))throw new Error('Unsupported public Core configuration field.');
for(const key of ['issuer','api_url']){const url=new URL(c[key]);if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error(`Invalid ${key}: use an exact HTTPS origin.`);}
const redirect=new URL(c.redirect_uri);if(redirect.protocol!=='https:'||redirect.pathname!=='/oauth/callback'||redirect.search||redirect.hash||redirect.username||redirect.password)throw new Error('Use the registered HTTPS /oauth/callback.');
for(const key of ['organization_id','service_id'])if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c[key]))throw new Error(`Invalid ${key}.`);
if(typeof c.browser_client_id!=='string'||!c.browser_client_id)throw new Error('Missing public browser client.');
console.log('Public Core configuration validated. No resources were provisioned.');
