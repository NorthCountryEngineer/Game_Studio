/** Keep legacy embeds at their exact origin while top-level sign-in uses its configured callback origin. */
export function canonicalGameStudioNavigation(currentURL: string, callbackURI: string, framed: boolean): string | undefined {
  const callback = new URL(callbackURI), current = new URL(currentURL);
  if (callback.protocol !== 'https:' || callback.pathname !== '/oauth/callback' || callback.search || callback.hash || callback.username || callback.password) throw new Error('Game Studio requires its exact configured HTTPS callback.');
  if (framed || current.origin === callback.origin || current.pathname.startsWith('/embed/') || current.pathname.startsWith('/sdk/')) return;
  const target = new URL(callback.origin);
  // A callback's one-use code/state belong to storage at its original origin.
  // Restart on the canonical site instead of transferring OAuth credentials.
  if (current.pathname === '/oauth/callback') { target.pathname = '/game-studio'; return target.href; }
  target.pathname = current.pathname;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const query = current.searchParams;
  if (current.pathname === '/game-studio') {
    const keys = [...query.keys()], host = query.get('host'), game = query.get('game');
    if (keys.every(key => ['host', 'login', 'game'].includes(key)) && keys.every(key => query.getAll(key).length === 1)
      && (host === null || /^[a-z][a-z0-9_-]{0,63}$/.test(host)) && (game === null || uuid.test(game))
      && (!query.has('login') || query.get('login') === 'auto' && host !== null)) target.search = current.search;
  }
  if (/^\/games\/[0-9a-f-]{36}$/.test(current.pathname) && uuid.test(current.pathname.slice(7))) {
    if ([...query.keys()].length === 1 && query.getAll('room').length === 1 && uuid.test(query.get('room') || '')) target.search = current.search;
    // Room invitations are the only capability permitted across this navigation;
    // they stay in a fragment and never carry a user/session identity.
    if (/^#coop=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(current.hash)) target.hash = current.hash;
  }
  return target.href;
}
