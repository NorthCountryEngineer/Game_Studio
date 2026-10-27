import { useEffect, useState } from 'react';
import { isCore } from '../lib/core';
import { createMultiplayerLobbyPath } from '../lib/game-lobby';
import { loadMultiplayerAPI, multiplayerRequest, validateMultiplayerLobby, type MultiplayerLobbyRoom } from '../lib/game-multiplayer';

export function MultiplayerLobby({ navigate }: { navigate: (path: string) => Promise<void> }) {
  const [rooms, setRooms] = useState<MultiplayerLobbyRoom[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true, running = false;
    const reload = async () => {
      if (running || document.hidden) return;
      running = true; setLoading(true);
      try {
        // A normal offline preview must never fall through to the deployed relay.
        const preview = import.meta.env.VITE_MULTIPLAYER_API_URL;
        if (!isCore && !preview) throw new Error('Live rooms are unavailable. You can still play solo.');
        const base = await loadMultiplayerAPI(!isCore ? preview : undefined);
        const next = validateMultiplayerLobby(await multiplayerRequest(base, '/multiplayer/lobby', 'GET'));
        if (!next) throw new Error('The open rooms could not be verified. Try refreshing.');
        if (active) { setRooms(next); setError(''); }
      } catch {
        if (active) { setRooms([]); setError('Live rooms are unavailable right now. You can still play solo or try again.'); }
      } finally { running = false; if (active) setLoading(false); }
    };
    void reload();
    const interval = window.setInterval(() => void reload(), 20000);
    const visible = () => { if (!document.hidden) void reload(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  const openRooms = rooms.filter(room => room.expiresAt * 1000 > Date.now());
  return <section className="game-partner-lobby" aria-labelledby="game-partner-heading">
    <div className="game-section-heading"><div><span className="eyebrow">BETTER TOGETHER</span><h2 id="game-partner-heading">Looking for a partner</h2></div><button className="text-button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? 'Checking rooms…' : 'Refresh rooms'}</button></div>
    <p>Pick an open seat in a live two-player game, or open a game and choose <strong>Find a partner</strong> to offer yours.</p>
    {error ? <p className="game-small-note" role="status">{error}</p> : loading && !openRooms.length ? <p role="status">Finding open seats…</p> : openRooms.length ? <ul className="game-partner-list" aria-label="Games with an open seat">{openRooms.map(room => <li key={room.roomId}><div><span className="game-partner-live">Live · 1 of 2 players</span><h3>{room.title}</h3></div><a className="button primary" href={createMultiplayerLobbyPath(room.gameId, room.roomId)} onClick={event => { event.preventDefault(); void navigate(createMultiplayerLobbyPath(room.gameId, room.roomId)); }}>Join game</a></li>)}</ul> : <p className="game-partner-empty" role="status">No open seats right now. Your next teammate could be waiting for you to host!</p>}
    <p className="game-small-note">Only rooms whose hosts choose Find a partner appear here. Private invitations still work. No names or chat are shared.</p>
  </section>;
}
