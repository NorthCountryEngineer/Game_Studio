/** Syntax alone can hide stale authority; it can never authorize a redirect. */
export function hostLoginCandidate(path: string, framed: boolean): { hostId: string; destination: string; consumedPath: string } | undefined {
  if (framed) return;
  let url: URL;
  try { url = new URL(path, 'https://game-studio.invalid'); } catch { return; }
  const query = url.searchParams;
  if (url.origin !== 'https://game-studio.invalid' || url.pathname !== '/game-studio' || url.hash ||
      query.getAll('login').length !== 1 || query.get('login') !== 'auto' ||
      query.getAll('host').length !== 1 || !/^[a-z][a-z0-9_-]{0,63}$/.test(query.get('host') || '') ||
      [...query.keys()].some(key => !['login', 'host', 'game'].includes(key)) ||
      query.getAll('game').length > 1) return;
  const game = query.get('game');
  if (game !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(game)) return;
  query.delete('login');
  return { hostId: query.get('host')!, destination: game ? `/game-studio?game=${game}` : '/game-studio', consumedPath: url.pathname + url.search };
}

/** A host link requests navigation only; Core independently grants access. */
export function hostLoginLaunch(path: string, hostIds: readonly string[], state: {
  configured: boolean; checking: boolean; authenticated: boolean; framed: boolean; failed: boolean;
}): ReturnType<typeof hostLoginCandidate> {
  if (!state.configured || state.checking || state.failed) return;
  const candidate = hostLoginCandidate(path,state.framed);
  return candidate && hostIds.includes(candidate.hostId) ? candidate : undefined;
}
