
export const isCore = import.meta.env.VITE_APP_MODE === 'nce';
const files = import.meta.glob('../../nce-config.json', { eager: true, import: 'default' });
export type CoreConfig = { issuer: string; browser_client_id: string; redirect_uri: string; api_url: string; organization_id: string; service_id: string };
export const coreConfig = Object.values(files)[0] as CoreConfig | undefined;
if (isCore && !coreConfig) throw new Error('Missing nce-config.json. Follow deployment/README.md.');
type Tokens = { access_token: string; refresh_token?: string; expires_at: number };
const tokenKey = 'game-studio-core-tokens', flowKey = 'game-studio-core-flow';
let refresh: Promise<Tokens> | undefined;
let callback: Promise<void> | undefined;
let sessionGeneration = 0;
const config = () => { if (!coreConfig) throw new Error('Core is not configured.'); return coreConfig; };
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function readTokens(): Tokens | undefined { try { return JSON.parse(sessionStorage.getItem(tokenKey) || 'null') || undefined; } catch { sessionStorage.removeItem(tokenKey); } }
function authorizationError(code: unknown): string {
  // Display only known error codes, never the provider's arbitrary description
  // or callback URL, which can contain credentials.
  const messages: Record<string, string> = {
    access_denied: 'Core authorization was cancelled or denied.',
    invalid_grant: 'Core could not exchange the sign-in code. Start sign-in again.',
    invalid_client: 'Core does not recognize Game Studio’s browser client. Check its registration.',
    unauthorized_client: 'Core has not enabled Game Studio’s browser client for sign-in.',
    invalid_request: 'Core rejected the sign-in request. Check the browser client and callback configuration.',
    invalid_scope: 'Core rejected Game Studio’s requested sign-in permissions.',
    server_error: 'Core could not complete sign-in. Try again shortly.',
    temporarily_unavailable: 'Core sign-in is temporarily unavailable. Try again shortly.',
  };
  return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : 'Core sign-in failed. Start sign-in again.';
}
async function exchange(fields: Record<string, string>, generation = sessionGeneration): Promise<Tokens> {
  const c = config();
  let r: Response;
  try {
    r = await fetch(`${c.issuer}/oauth/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.browser_client_id, ...fields }), credentials: 'omit', redirect: 'error' });
  } catch { throw new Error('The browser could not reach Core’s token endpoint. Check the connection and Core’s allowed browser origin.'); }
  let t;
  try { t = await r.json(); } catch { throw new Error('Core’s token endpoint returned an unexpected response. Check the Core proxy deployment.'); }
  if (!r.ok) throw new Error(authorizationError(t?.error));
  if (!t || typeof t.access_token !== 'string' || t.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(t.expires_in)) throw new Error('Core’s token endpoint returned an invalid session.');
  // ID tokens are never used to authorize API requests. The backend checks the
  // opaque access token with live, service-bound Core introspection every time.
  const tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  if (generation !== sessionGeneration) {
    await revokeToken(tokens.refresh_token || tokens.access_token);
    throw new Error('This session was signed out. Sign in again to continue.');
  }
  sessionStorage.setItem(tokenKey, JSON.stringify(tokens)); return tokens;
}
function loginReturnPath(value: unknown = '/game-studio'): string {
  if (typeof value === 'string' && (value === '/game-studio' || value === '/settings' || /^\/game-studio\?game=[0-9a-f-]{36}$/i.test(value) || value === '/games' || /^\/games\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return value;
  throw new Error('Choose a Game Studio or game page before starting sign-in.');
}
export async function beginCoreLogin(action: 'login' | 'signup' = 'login', returnTo = '/game-studio') {
  if (typeof window !== 'undefined' && window.top !== window.self) throw new Error('Open Game Studio in a new tab to sign in.');
  const destination = loginReturnPath(returnTo);
  const c = config(), verifier = b64(crypto.getRandomValues(new Uint8Array(48))), state = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(flowKey, JSON.stringify({ verifier, state, at: Date.now(), returnTo: destination }));
  const url = new URL(`${c.issuer}/oauth/authorize/`);
  url.search = new URLSearchParams({ client_id: c.browser_client_id, redirect_uri: c.redirect_uri, response_type: 'code', scope: 'openid authorization', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  if (action === 'signup') {
    const signup = new URL(`${c.issuer}/accounts/app-signup/`);
    signup.searchParams.set('next', url.pathname + url.search);
    location.assign(signup.href);
  } else location.assign(url.href);
}
export function completeCoreLogin(): Promise<void> {
  if (callback) return callback;
  callback = (async () => {
    const c = config(), params = new URLSearchParams(location.search);
    const stored = sessionStorage.getItem(flowKey); sessionStorage.removeItem(flowKey);
    if (!stored) throw new Error('Sign-in state is missing. Start sign-in again.');
    const flow = JSON.parse(stored);
    if (params.get('state') !== flow.state || Date.now() - flow.at > 600000 || flow.at > Date.now()) throw new Error('Sign-in state is invalid or expired. Start sign-in again.');
    const destination = loginReturnPath(flow.returnTo);
    if (params.has('iss') && params.get('iss') !== c.issuer) throw new Error('Unexpected sign-in issuer.');
    if (params.has('error')) throw new Error(authorizationError(params.get('error')));
    if (!params.get('code')) throw new Error('Core did not return a sign-in code. Start sign-in again.');
    await exchange({ grant_type: 'authorization_code', code: params.get('code')!, redirect_uri: c.redirect_uri, code_verifier: flow.verifier });
    history.replaceState({}, '', destination);
  })(); return callback;
}
async function accessToken(): Promise<string> {
  const t = readTokens(); if (!t) throw new Error('Sign in through Core to continue.');
  if (t.expires_at > Date.now() + 15000) return t.access_token;
  if (!t.refresh_token) { sessionStorage.removeItem(tokenKey); throw new Error('Sign in through Core again.'); }
  if (!refresh) {
    const generation = sessionGeneration;
    refresh = exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, generation).catch(e => { if (generation === sessionGeneration) sessionStorage.removeItem(tokenKey); throw e; }).finally(() => { refresh = undefined; });
  }
  return (await refresh).access_token;
}
export async function coreRequest<T>(path: string, method = 'GET', body?: unknown, protectedRequest = true): Promise<T> {
  const c = config(), headers: Record<string, string> = {};
  if (protectedRequest) headers.Authorization = `Bearer ${await accessToken()}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${c.api_url.replace(/\/$/, '')}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', redirect: 'error' });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error || 'The publishing service could not complete the request.'), { status: r.status });
  return data as T;
}
export async function coreSession(): Promise<boolean> {
  if (!readTokens()) return false;
  try { const session = await coreRequest<{ permissions?: unknown }>('/session'); return Array.isArray(session.permissions) && session.permissions.includes('games-create'); }
  catch (e) { throw new Error(`Game Studio access check failed: ${e instanceof Error ? e.message : 'The publishing service could not be reached.'}`); }
}
/** Player identity grants score submission, never access to the editing workspace. */
export async function corePlayerSession(): Promise<{ authenticated: boolean; canEdit: boolean }> {
  if (!readTokens()) return { authenticated: false, canEdit: false };
  const session = await coreRequest<unknown>('/game-scores/session');
  if (!session || typeof session !== 'object' || Array.isArray(session) || Object.keys(session).sort().join(',') !== 'authenticated,canEdit' || (session as { authenticated?: unknown }).authenticated !== true || typeof (session as { canEdit?: unknown }).canEdit !== 'boolean') throw new Error('Core returned an invalid player session. Sign in again to continue.');
  return { authenticated: true, canEdit: (session as { canEdit: boolean }).canEdit };
}
export async function coreAdminSession(): Promise<boolean> {
  if (!readTokens()) return false;
  try {
    const session = await coreRequest<{ permissions?: unknown }>('/session');
    const permissions = session.permissions;
    return Array.isArray(permissions) && permissions.includes('games-manage');
  } catch (e) { throw new Error(`Game Studio admin check failed: ${e instanceof Error ? e.message : 'The publishing service could not be reached.'}`); }
}
export async function coreAccountAdminSession(): Promise<boolean> {
  if (!readTokens()) return false;
  const session = await coreRequest<{ canManageAccounts?: boolean }>('/session');
  return session.canManageAccounts === true;
}
export async function coreAgentAdminSession(): Promise<boolean> {
  if (!readTokens()) return false;
  const session = await coreRequest<{ canConfigureAgents?: boolean }>('/session');
  return session.canConfigureAgents === true;
}
async function revokeToken(token: string) {
  const c = config();
  try { await fetch(`${c.issuer}/oauth/revoke/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.browser_client_id, token }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) }); } catch { /* Credentials are still cleared locally when Core is unreachable. */ }
}
export async function coreLogout() {
  sessionGeneration++;
  const t = readTokens(); sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(flowKey);
  if (t) await revokeToken(t.refresh_token || t.access_token);
}
