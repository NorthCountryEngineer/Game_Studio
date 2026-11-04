import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isCooperativeGameSpec, type ArcadeGameSpec, type Game, type GameResult } from '../lib/game-types';
import { isVersusEligible, validateVersusMatch, type VersusMatch } from '../lib/game-versus';
import { cooperativeGameSandboxDocument, validateCooperativeState } from '../lib/game-cooperative';
import { createCooperativeLeaderboardTracker } from '../lib/cooperative-leaderboard';
import { PlayerSurface } from './PlayerSurface';
import { isCore } from '../lib/core';
import { createPublicationBinding } from '../lib/game-scoring';
import { watchMultiplayerLobbyEntry } from '../lib/game-lobby';
import { connectMultiplayer, createMultiplayerInvitation, loadMultiplayerAPI, multiplayerRequest, parseMultiplayerInvitation, sameMultiplayerPublication, sameMultiplayerMatch, watchMultiplayerInvitations, validMultiplayerInput, validMultiplayerSequence, validateMultiplayerRoom, type MultiplayerConnection, type MultiplayerRoom, type MultiplayerStatus } from '../lib/game-multiplayer';

const apiBase = () => {
  const preview = import.meta.env.VITE_MULTIPLAYER_API_URL;
  if (!isCore && !preview) throw new Error('Live multiplayer is unavailable in this offline preview. You can still play solo.');
  return loadMultiplayerAPI(!isCore ? preview : undefined);
};
const statusText: Record<MultiplayerStatus, string> = { connecting: 'Connecting to the live room…', waiting: 'Waiting for the other player. The shared game is paused.', connected: 'Both players are connected. Player 1 controls starting and pausing.', reconnecting: 'Connection interrupted. The game is paused while we reconnect…', ended: 'This live session has ended. You can play solo or create another room.', expired: 'This room expired. Create another room to keep playing.' };
const reasonText: Record<string, string> = { 'publication-changed': 'The creator changed or unpublished this edition. Reload the game before starting a new room.', 'host-disconnected': 'Player 1 left the room.', 'connection-lost': 'The live connection could not be restored. Create a new room to try again.', 'invalid-message': 'The live room sent an unsupported message. Start a new room.', 'invalid-room': 'The room could not be verified. Start a new room.', 'invalid-lease': 'The room could not renew its connection. Start a new room.', rejected: 'The live service ended this connection. Start a new room.' };

/** The parent owns networking. The opaque game frame receives only validated gameplay data. */
export function CooperativePlayer({ spec, room, onStatus, onComplete }: { spec: ArcadeGameSpec; room: MultiplayerRoom; onStatus: (status: MultiplayerStatus, reason?: string) => void; onComplete?: (result: GameResult) => void }) {
  const fingerprint = JSON.stringify([spec, room.match]);
  const instance = useMemo(() => { const nonce = crypto.randomUUID().replaceAll('-', ''); return { nonce, document: cooperativeGameSandboxDocument(nonce) }; }, [fingerprint, room.roomId, room.seat]);
  const frame = useRef<HTMLIFrameElement>(null), connection = useRef<MultiplayerConnection>(), peerConnected = useRef(false), lastSnapshot = useRef<{ seq: number; state: unknown }>(), statusCallback = useRef(onStatus), completeCallback = useRef(onComplete);
  const [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { statusCallback.current = onStatus; }, [onStatus]);
  useEffect(() => { completeCallback.current = onComplete; }, [onComplete]);
  useEffect(() => {
    setLoaded(false); setFailed(false); lastSnapshot.current = undefined; peerConnected.current = false;
    const leaderboard = !room.match && isCooperativeGameSpec(spec) ? createCooperativeLeaderboardTracker(spec, room.seat) : undefined;
    let lastHostSnapshotSeq = 0;
    const complete = (state: unknown) => { const result = leaderboard?.observe(state); if (result) completeCallback.current?.(result); };
    const post = (data: unknown) => frame.current?.contentWindow?.postMessage(data, '*');
    const sendLoad = () => post({ type: 'game-coop-load', nonce: instance.nonce, spec, seat: room.seat, ...(room.match ? { match: room.match } : {}) });
    const sendPeer = () => post({ type: 'game-coop-peer', nonce: instance.nonce, connected: peerConnected.current });
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data) || event.data.nonce !== instance.nonce) return;
      const data = event.data, keys = Object.keys(data);
      if (data.type === 'game-coop-ready' || data.type === 'game-coop-loaded') {
        if (keys.length !== 2 || keys.some(key => !['type', 'nonce'].includes(key))) return;
        if (data.type === 'game-coop-ready') sendLoad();
        else { setLoaded(true); sendPeer(); if (room.seat === 1 && lastSnapshot.current) post({ type: 'game-coop-state', nonce: instance.nonce, ...lastSnapshot.current }); }
      }
      if (data.type === 'game-coop-input' && room.seat === 1 && keys.length === 4 && keys.every(key => ['type', 'nonce', 'seq', 'mask'].includes(key)) && validMultiplayerSequence(data.seq) && validMultiplayerInput(data.mask)) connection.current?.sendInput(data.seq, data.mask);
      if (data.type === 'game-coop-state' && room.seat === 0 && keys.length === 4 && keys.every(key => ['type', 'nonce', 'seq', 'state'].includes(key)) && validMultiplayerSequence(data.seq) && data.seq > lastHostSnapshotSeq && validateCooperativeState(data.state, spec, room.match)) { lastHostSnapshotSeq = data.seq; connection.current?.sendState(data.seq, data.state); complete(data.state); }
    };
    window.addEventListener('message', receive);
    connection.current = connectMultiplayer(room, {
      validateState: value => Boolean(validateCooperativeState(value, spec, room.match)),
      onStatus: (status, reason) => statusCallback.current(status, reason),
      onPeer: connected => { peerConnected.current = connected; sendPeer(); },
      onInput: (seq, mask, pressedMask) => post({ type: 'game-coop-input', nonce: instance.nonce, seq, mask, ...(pressedMask === undefined ? {} : { pressedMask }) }),
      onState: (seq, state) => { lastSnapshot.current = { seq, state }; post({ type: 'game-coop-state', nonce: instance.nonce, seq, state }); complete(state); },
    });
    sendLoad();
    const timeout = window.setTimeout(() => setFailed(true), 12000);
    return () => { window.removeEventListener('message', receive); window.clearTimeout(timeout); connection.current?.close(); connection.current = undefined; };
  }, [instance, room, fingerprint]);
  return <PlayerSurface key={instance.nonce} frame={frame} nonce={instance.nonce} title={`${spec.title} · Player ${room.seat + 1}`} cooperative>
    {!loaded && <p role="status">{failed ? 'The shared game could not load. Leave the room and try again.' : 'Preparing the shared game…'}</p>}
    <iframe key={instance.nonce} ref={frame} title={`${spec.title} — ${room.match ? 'versus' : 'cooperative'} Player ${room.seat + 1}`} srcDoc={instance.document} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'" style={{ display: 'block', width: '100%', height: 'clamp(610px, 75vw, 900px)', border: 0, borderRadius: 12 }} onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'game-coop-load', nonce: instance.nonce, spec, seat: room.seat, ...(room.match ? { match: room.match } : {}) }, '*')} />
    <p className="game-player-note">You are Player {room.seat + 1}. {room.match ? `Face the other ship and fire. Each player starts with ${room.match.lives} lives. Respawning ships are briefly protected and cannot fire until protection ends. The last ship standing wins; at ${room.match.timeLimit} seconds, the player with more lives wins. Equal lives are a draw. This match uses the first saved arena.` : 'Each player controls their own friendly character and keeps their own points, lives and goal progress in one shared world.'} The game pauses when either connection is interrupted.</p>
  </PlayerSurface>;
}

export function CooperativeGame({ game, children, onComplete }: { game: Game & { spec: ArcadeGameSpec }; children: ReactNode; onComplete?: (result: GameResult) => void }) {
  const [room, setRoom] = useState<MultiplayerRoom>(), [invitation, setInvitation] = useState(''), [joinText, setJoinText] = useState(''), [showJoin, setShowJoin] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const canCooperate = isCooperativeGameSpec(game.spec), canVersus = isVersusEligible(game.spec);
  const [mode, setMode] = useState<'cooperative' | 'versus'>(() => canCooperate ? 'cooperative' : 'versus');
  const [lives, setLives] = useState(3), [timeLimit, setTimeLimit] = useState(120);
  const [status, setStatus] = useState<MultiplayerStatus>('connecting'), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const lock = useRef(false), active = useRef(true), currentRoom = useRef<MultiplayerRoom>(), latestJoin = useRef<(fragment: string) => void>(() => {}), latestLobbyJoin = useRef<(roomId: string) => void>(() => {}), roomApi = useRef('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { const base = roomApi.current; return () => { if (room?.seat === 0) void multiplayerRequest(base, `/multiplayer/rooms/${room.roomId}`, 'DELETE', { hostToken: room.token }).catch(() => {}); }; }, [room]);
  async function host(roomVisibility: 'private' | 'public') {
    if (lock.current || currentRoom.current) return; lock.current = true; setBusy(true); setError(''); setCopied(false);
    try {
      if (mode === 'versus' ? !canVersus : !canCooperate) throw new Error('This two-player mode is unavailable for this game.');
      const match: VersusMatch | undefined = mode === 'versus' ? validateVersusMatch({ mode: 'versus', lives, timeLimit }) : undefined;
      if (mode === 'versus' && !match) throw new Error('Choose 1–5 lives and a 30–180 second round.');
      const [base, binding] = await Promise.all([apiBase(), createPublicationBinding(game)]);
      if (!active.current) return;
      const response = await multiplayerRequest(base, '/multiplayer/rooms', 'POST', { gameId: game.id, publishedRevision: game.publishedRevision ?? game.revision, visibility: roomVisibility, ...(match ? { match } : {}) });
      const next = validateMultiplayerRoom(response, 0, !isCore); if (!next) throw new Error('The live service returned an invalid room. Please try again.');
      if (!sameMultiplayerPublication(next, binding) || !sameMultiplayerMatch(next.match, match)) { void multiplayerRequest(base, `/multiplayer/rooms/${next.roomId}`, 'DELETE', { hostToken: next.token }).catch(() => {}); throw new Error('The game edition or match settings changed. Reload before starting a new room.'); }
      if (!active.current) { void multiplayerRequest(base, `/multiplayer/rooms/${next.roomId}`, 'DELETE', { hostToken: next.token }).catch(() => {}); return; }
      roomApi.current = base; setVisibility(roomVisibility); setInvitation(createMultiplayerInvitation(window.location.origin, game.id, { roomId: next.roomId, inviteToken: (response as { inviteToken: string }).inviteToken })); currentRoom.current = next; setRoom(next); setStatus('connecting'); setReason('');
    } catch (value) { if (active.current) setError(value instanceof Error ? value.message : 'The live room could not be created.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function join(value: string) {
    if (lock.current || currentRoom.current) return;
    const parsed = parseMultiplayerInvitation(value, window.location.origin, game.id); if (!parsed) { setError('Paste the invitation link for this game from the other player.'); return; }
    lock.current = true; setBusy(true); setError(''); setJoinText('');
    try {
      const [base, binding] = await Promise.all([apiBase(), createPublicationBinding(game)]);
      if (!active.current) return;
      const response = await multiplayerRequest(base, `/multiplayer/rooms/${parsed.roomId}/join`, 'POST', { inviteToken: parsed.inviteToken, gameId: binding.game_id, publishedRevision: binding.published_revision, specSha256: binding.spec_sha256 });
      const next = validateMultiplayerRoom(response, 1, !isCore); if (!next || next.roomId !== parsed.roomId || !sameMultiplayerPublication(next, binding) || (next.match ? !canVersus : !canCooperate)) throw new Error('The live service returned an invalid room. Please ask for a new invitation.');
      if (active.current) { roomApi.current = base; currentRoom.current = next; setRoom(next); setInvitation(''); setShowJoin(false); setStatus('connecting'); setReason(''); }
    } catch (value) { if (active.current) setError(value instanceof Error ? value.message : 'The invitation could not be opened.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function joinLobby(roomId: string) {
    if (lock.current || currentRoom.current) { setError('Leave your current room before joining another game.'); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      const [base, binding] = await Promise.all([apiBase(), createPublicationBinding(game)]);
      if (!active.current) return;
      const response = await multiplayerRequest(base, `/multiplayer/rooms/${roomId}/lobby-join`, 'POST', { gameId: binding.game_id, publishedRevision: binding.published_revision, specSha256: binding.spec_sha256 });
      const next = validateMultiplayerRoom(response, 1, !isCore);
      if (!next || next.roomId !== roomId || !sameMultiplayerPublication(next, binding) || (next.match ? !canVersus : !canCooperate)) throw new Error('The live room could not be verified.');
      if (active.current) { roomApi.current = base; currentRoom.current = next; setRoom(next); setVisibility('public'); setInvitation(''); setShowJoin(false); setStatus('connecting'); setReason(''); }
    } catch { if (active.current) setError('This open seat is no longer available. It may have filled or the host may have left. Find another room on the Games homepage, or invite a friend.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => {
    latestJoin.current = fragment => {
      if (currentRoom.current) { setError('Leave your current room before opening another invitation.'); return; }
      if (lock.current) { setError('Finish the current room request before opening another invitation.'); return; }
      void join(fragment);
    };
    latestLobbyJoin.current = roomId => void joinLobby(roomId);
  });
  useEffect(() => watchMultiplayerLobbyEntry(window, game.id, roomId => latestLobbyJoin.current(roomId), () => setError('This open-room link is invalid. Choose a room from the Games homepage.')), [game.id]);
  useEffect(() => watchMultiplayerInvitations(window, fragment => latestJoin.current(fragment)), []);
  async function copy() { try { await navigator.clipboard.writeText(invitation); setCopied(true); setError(''); } catch { setError('Copy the invitation from the field and send it privately to the other player.'); } }
  const ended = status === 'ended' || status === 'expired';
  return <>
    <section className="game-cooperative-options" aria-labelledby="game-play-mode-heading">
      <div className="game-section-heading"><div><span className="eyebrow">PLAY YOUR WAY</span><h2 id="game-play-mode-heading">{canVersus ? canCooperate ? 'Solo, together or versus' : 'Solo or versus' : 'Solo or together'}</h2></div>{room && <span className="game-cooperative-seat">Player {room.seat + 1} of 2</span>}</div>
      {!room ? <>
        <p>Play solo, invite a friend privately, or offer an open seat on the homepage. Both players use their own session. No account, name, chat or camera is needed.</p>
        {canVersus && <fieldset disabled={busy} className="game-versus-settings"><legend>Choose your two-player game</legend>
          <label>Two-player mode<select value={mode} onChange={event => setMode(event.target.value as 'cooperative' | 'versus')}>
            {canCooperate && <option value="cooperative">Play together · no friendly fire</option>}
            <option value="versus">Versus · shoot each other</option>
          </select></label>
          {mode === 'versus' && <><div className="game-field-pair">
            <label>Lives per player<select value={lives} onChange={event => setLives(Number(event.target.value))}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} {value === 1 ? 'life' : 'lives'}</option>)}</select></label>
            <label>Round length<select value={timeLimit} onChange={event => setTimeLimit(Number(event.target.value))}>{[30, 60, 90, 120, 150, 180].map(value => <option key={value} value={value}>{value} seconds</option>)}</select></label>
          </div><p className="game-small-note">Face off in the first saved arena. The last ship standing wins. At the time limit, more remaining lives wins; equal lives are a draw. Brief respawn protection gives each ship a safe restart. Your solo game and saved levels stay the same.</p></>}
        </fieldset>}
        <div className="game-cooperative-actions"><button className="button secondary" disabled={busy} aria-pressed={!showJoin} onClick={() => { setShowJoin(false); setError(''); }}>Play solo</button><button className="button primary" disabled={busy} onClick={() => void host('private')}>{busy && !showJoin ? 'Connecting…' : mode === 'versus' ? 'Invite an opponent' : 'Invite a friend'}</button><button className="button secondary" disabled={busy} onClick={() => void host('public')}>{mode === 'versus' ? 'Find an opponent' : 'Find a partner'}</button><button className="button secondary" disabled={busy} aria-expanded={showJoin} onClick={() => setShowJoin(value => !value)}>Join using invitation</button></div>
        {showJoin && <form className="game-cooperative-invitation" onSubmit={event => { event.preventDefault(); void join(joinText); }}><label htmlFor="game-coop-join">Invitation link<input id="game-coop-join" type="text" value={joinText} onChange={event => setJoinText(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={2300} placeholder="Paste the private invitation link" disabled={busy} /></label><button className="button primary" disabled={busy || !joinText.trim()}>{busy ? 'Joining…' : 'Join game'}</button></form>}
      </> : <>
        {room.match && <p className="game-versus-rules"><strong>Versus · {room.match.lives} {room.match.lives === 1 ? 'life' : 'lives'} each · {room.match.timeLimit}-second round.</strong> Shoot the other ship. Last ship standing wins; at the time limit, remaining lives decide. Equal lives are a draw.</p>}
        <p className={`game-cooperative-status ${status}`} role="status">{statusText[status]}{reasonText[reason] && <> {reasonText[reason]}</>}</p>
        {room.seat === 0 && visibility === 'public' && !ended && <p className="game-partner-host-note">{status === 'connected' ? 'Your partner has joined. The room is no longer listed.' : 'You chose an open room. Other players can claim its one open seat from the homepage or invitation. End the room to stop hosting.'}</p>}
        {room.seat === 0 && invitation && !ended && <div className="game-cooperative-invitation"><label htmlFor="game-coop-invitation">{visibility === 'private' ? 'Private invitation for Player 2' : 'Invitation for Player 2'}<input id="game-coop-invitation" value={invitation} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /></label><button className="button secondary" onClick={() => void copy()}>{copied ? 'Invitation copied' : 'Copy invitation'}</button><p className="game-small-note">{visibility === 'private' ? 'Send this link privately to one player. It admits one guest. Share it only with the intended player.' : 'You can also invite a friend with this link. The first player to join takes the open seat.'} Rooms stay open while players remain connected, with no fixed session limit. Leaving the host page ends the room.</p></div>}
        <button className="text-button" onClick={() => { currentRoom.current = undefined; setRoom(undefined); setInvitation(''); setReason(''); setError(''); setShowJoin(false); }}>{ended ? 'Return to solo / create another room' : room.seat === 0 ? 'End room and return to solo' : 'Leave room and return to solo'}</button>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="game-small-note">{room?.match || !room && mode === 'versus' ? 'Versus matches have their own winner and do not submit solo scores or completion results.' : "Each player's completed round can be entered on this edition's leaderboard. These are casual, player-reported results."} Player 1 runs the shared simulation.</p>
    </section>
    {room ? !ended && <CooperativePlayer spec={game.spec} room={room} onComplete={onComplete} onStatus={(next, why) => { setStatus(next); setReason(why ?? ''); }} /> : children}
  </>;
}
