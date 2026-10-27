const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Public room IDs are navigation hints; only the relay can grant the open seat. */
export function createMultiplayerLobbyPath(gameId: string, roomId: string): string {
  if (!identifier.test(gameId) || !identifier.test(roomId)) throw new Error('This open room is unavailable.');
  return `/games/${gameId}?room=${roomId}`;
}

type LobbySurface = {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'state' | 'replaceState'>;
  addEventListener: (type: 'popstate', listener: () => void) => void;
  removeEventListener: (type: 'popstate', listener: () => void) => void;
};

/** Consume a lobby navigation once. It never carries an invitation or a token. */
export function watchMultiplayerLobbyEntry(surface: LobbySurface, gameId: string, join: (roomId: string) => void, reject: () => void): () => void {
  const consume = () => {
    // A previous game's listener can run before React mounts the destination.
    if (surface.location.pathname !== `/games/${gameId}`) return;
    const query = new URLSearchParams(surface.location.search);
    if (!query.has('room')) return;
    const rooms = query.getAll('room');
    query.delete('room');
    const rest = query.toString();
    surface.history.replaceState(surface.history.state, '', `${surface.location.pathname}${rest ? `?${rest}` : ''}${surface.location.hash}`);
    if (rooms.length !== 1 || !identifier.test(rooms[0]) || surface.location.hash.startsWith('#coop=')) { reject(); return; }
    join(rooms[0]);
  };
  surface.addEventListener('popstate', consume); consume();
  return () => surface.removeEventListener('popstate', consume);
}
