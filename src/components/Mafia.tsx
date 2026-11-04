import { PartyInstructions } from './PartyInstructions';
import { PartyPlayerName, partyPlayerLabel } from './PartyPlayerName';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAFIA_AVATARS, MafiaAPIError, avatarFor, clearMafiaAdmission, createMafiaSecret, forgetMafiaSession, mafiaInvitation, mafiaRequest, parseMafiaConfig, parseMafiaEnvelope, parseMafiaInvitation, readMafiaAdmission, readMafiaSession, saveMafiaAdmission, saveMafiaSession, validateMafiaName, type MafiaAction, type MafiaAdmission, type MafiaAvatar, type MafiaChat, type MafiaConfig, type MafiaEnvelope, type MafiaPlayer, type MafiaRole, type MafiaRoom, type MafiaSession, type MafiaSettings } from '../lib/mafia';
import '../mafia.css';

export const mafiaRoleLabel = (role: MafiaRole) => ({ mafia: 'Mafia', detective: 'Detective', doctor: 'Doctor', civilian: 'Civilian' })[role];
const roleIcon: Record<MafiaRole, string> = { mafia: '🎭', detective: '🔎', doctor: '🩺', civilian: '🏡' };
const roleHelp: Record<MafiaRole, string> = {
  mafia: 'Work with your secret team. Each night, choose someone outside the Mafia to eliminate. Win when the Mafia equal or outnumber the town.',
  detective: 'Each night, investigate one other player. Only you learn whether they are Mafia. Use what you know to help the town.',
  doctor: 'Each night, protect one living player, including yourself. If the Mafia choose that person, they survive the night.',
  civilian: 'Listen carefully, compare stories and vote during the day. Help the town find every Mafia member.',
};
export const mafiaPhaseLabel = (room: Pick<MafiaRoom, 'phase' | 'day'>) => ({ lobby: 'The town is gathering', night: `Night ${room.day}`, discussion: `Day ${room.day} · Discussion`, voting: `Day ${room.day} · Voting`, finished: 'The story is complete', closed: 'This room is closed' })[room.phase];
export function mafiaEligibleTargets(room: MafiaRoom): MafiaPlayer[] {
  const living = room.players.filter(player => player.alive && !player.left && !player.isNarrator);
  if (room.phase === 'voting') return living;
  if (room.phase !== 'night' || !room.self.alive || room.self.isNarrator || room.self.left) return [];
  if (room.self.role === 'doctor') return living;
  if (room.self.role === 'detective') return living.filter(player => player.id !== room.self.id);
  if (room.self.role === 'mafia') return living.filter(player => player.id !== room.self.id && !room.self.allies.includes(player.id));
  return [];
}
const errorText = (error: unknown) => error instanceof MafiaAPIError ? error.message : error instanceof Error && error.name !== 'TypeError' ? error.message : 'The live room could not be reached. Your seat is saved; try again shortly.';
const defaultSettings: MafiaSettings = { maxPlayers: 12, nightSeconds: 75, discussionSeconds: 90, votingSeconds: 45 };
type PendingAction = MafiaAction & { requestId: string; phaseId: number; sequence: number };

export function MafiaPage({ roomId, navigate }: { roomId?: string; navigate: (path: string) => unknown }) {
  const [session, setSession] = useState<MafiaSession>(), [room, setRoom] = useState<MafiaRoom>(), [config, setConfig] = useState<MafiaConfig>();
  const [name, setName] = useState(''), [avatar, setAvatar] = useState<MafiaAvatar>('fox'), [narratorMode, setNarratorMode] = useState<'human' | 'automatic' | 'ai'>('human'), [settings, setSettings] = useState(defaultSettings);
  const [inviteInput, setInviteInput] = useState(''), [invitation, setInvitation] = useState(''), [joinToken, setJoinToken] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(Boolean(roomId)), [showPrivate, setShowPrivate] = useState(false), [confirmClose, setConfirmClose] = useState(false), [now, setNow] = useState(Date.now());
  const [pendingAdmission, setPendingAdmission] = useState<MafiaAdmission>(), [uncertainAction, setUncertainAction] = useState<PendingAction>();
  const active = useRef(true), generation = useRef(0), locked = useRef(false), tail = useRef<Promise<void>>(Promise.resolve()), controller = useRef<AbortController>(), currentSession = useRef(session), currentRoom = useRef(room), actionRetry = useRef<PendingAction>();
  currentSession.current = session; currentRoom.current = room;
  useEffect(() => {
    active.current = true; generation.current++; locked.current = false; actionRetry.current = undefined;
    setSession(roomId ? readMafiaSession(roomId) : undefined); setRoom(undefined); setError(''); setNotice(''); setShowPrivate(false); setConfirmClose(false); setUncertainAction(undefined); setBusy(false); setLoading(Boolean(roomId)); setInvitation('');
    const key = roomId ?? 'create', pending = readMafiaAdmission(key); setPendingAdmission(pending);
    if (pending) { setName(pending.body.name); setAvatar(pending.body.avatar); if (pending.path === '/mafia/rooms') { setNarratorMode(pending.body.narratorMode ?? 'human'); setSettings({ maxPlayers: pending.body.maxPlayers!, nightSeconds: pending.body.nightSeconds!, discussionSeconds: pending.body.discussionSeconds!, votingSeconds: pending.body.votingSeconds! }); } }
    const parsed = roomId ? parseMafiaInvitation(window.location.href, window.location.origin) : undefined;
    setJoinToken(parsed && parsed.roomId === roomId ? parsed.inviteToken : pending?.body.inviteToken ?? '');
    return () => { active.current = false; generation.current++; controller.current?.abort(); };
  }, [roomId]);
  useEffect(() => { if (room?.phase === 'lobby') setShowPrivate(false); }, [room?.phase]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  /** One bounded HTTP request at a time, including polls, so a crowded room doesn't multiply outstanding work. */
  async function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, token?: string, expectedGeneration = generation.current) {
    const previous = tail.current; let release!: () => void; tail.current = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => {});
    try {
      if (!active.current || expectedGeneration !== generation.current) throw new DOMException('This room changed.', 'AbortError');
      const next = new AbortController(); controller.current = next;
      return await mafiaRequest(path, method, body, token, next.signal);
    } finally { release(); }
  }
  function accept(envelope: MafiaEnvelope, admission = false) {
    const acceptedSeat = admission ? envelope.session : currentSession.current;
    if (!acceptedSeat || acceptedSeat.roomId !== envelope.room.roomId || acceptedSeat.playerId !== envelope.room.self.id) throw new Error('The live room response does not match your saved seat. Reconnect before acting.');
    const prior = currentRoom.current, incoming = envelope.room;
    if (!prior || prior.roomId !== incoming.roomId || prior.self.role !== incoming.self.role || prior.self.isNarrator !== incoming.self.isNarrator || incoming.phase === 'lobby' || incoming.phase === 'night' && incoming.day <= prior.day && incoming.phaseId > prior.phaseId) setShowPrivate(false);
    if (incoming.self.left) {
      try { forgetMafiaSession(incoming.roomId); } catch { /* The in-memory seat is still cleared. */ }
      setSession(undefined); currentSession.current = undefined; setRoom(undefined); currentRoom.current = undefined; actionRetry.current = undefined; setUncertainAction(undefined); setLoading(false); setNotice('You left the room. Open a fresh invitation to join another town.'); void navigate('/mafia'); return;
    }
    setRoom(envelope.room); currentRoom.current = envelope.room; setLoading(false);
    const next = acceptedSeat;
    if (next) {
      setSession(next); currentSession.current = next;
      try { saveMafiaSession(next); } catch { setNotice('Your browser cannot save this seat. Keep this tab open while playing.'); }
      if (next.inviteToken) setInvitation(mafiaInvitation(window.location.origin, next));
    }
    if (actionRetry.current && (envelope.room.self.actionSequence >= actionRetry.current.sequence || envelope.room.phaseId !== actionRetry.current.phaseId)) { actionRetry.current = undefined; setUncertainAction(undefined); setError(''); }
  }
  useEffect(() => {
    let stopped = false; const expected = generation.current;
    void request('/mafia/config', 'GET', undefined, undefined, expected).then(value => { if (!stopped && active.current && expected === generation.current) setConfig(parseMafiaConfig(value)); }).catch(() => { if (!stopped && active.current && expected === generation.current) setConfig({ aiAvailable: false, minPlayers: 5, maxPlayers: 24 }); });
    return () => { stopped = true; };
  }, [roomId]);
  useEffect(() => {
    if (!session) { setLoading(false); return; }
    let stopped = false, timer: number | undefined; const expected = generation.current;
    const poll = async () => {
      try {
        const value = await request(`/mafia/rooms/${session.roomId}`, 'GET', undefined, session.token, expected);
        if (!stopped && active.current && expected === generation.current) { const next = parseMafiaEnvelope(value); if (next.room.roomId !== session.roomId || next.room.self.id !== session.playerId) throw new Error('This saved seat does not match the live room.'); accept(next); if (!actionRetry.current) setError(''); }
      } catch (value) { if (!stopped && active.current && expected === generation.current && !(value instanceof DOMException && value.name === 'AbortError')) { setError(errorText(value)); setLoading(false); } }
      finally { if (!stopped) timer = window.setTimeout(() => void poll(), document.visibilityState === 'hidden' ? 4000 : 1800); }
    };
    void poll();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [session?.roomId, session?.token]);
  async function refresh() {
    const seat = currentSession.current; if (!seat) return; const expected = generation.current;
    try { const next = parseMafiaEnvelope(await request(`/mafia/rooms/${seat.roomId}`, 'GET', undefined, seat.token, expected)); if (active.current && expected === generation.current) { accept(next); if (!actionRetry.current) setError(''); } } catch (value) { if (active.current && expected === generation.current) setError(errorText(value)); }
  }
  async function admit(event?: FormEvent) {
    event?.preventDefault(); if (locked.current) return;
    let admission = pendingAdmission;
    try {
      if (!admission) {
        const chosenName = validateMafiaName(name), requestId = crypto.randomUUID(), playerToken = createMafiaSecret();
        if (roomId && !joinToken) throw new Error('Open the private invitation from your narrator to join this room.');
        admission = { path: roomId ? `/mafia/rooms/${roomId}/join` : '/mafia/rooms', body: { requestId, name: chosenName, avatar, playerToken, inviteToken: roomId ? joinToken : createMafiaSecret(), ...(!roomId ? { ...settings, narratorMode } : {}) } };
        setPendingAdmission(admission); try { saveMafiaAdmission(roomId ?? 'create', admission); } catch { /* The in-memory retry remains stable when storage is unavailable. */ }
      }
    } catch (value) { setError(errorText(value)); return; }
    locked.current = true; setBusy(true); setError(''); const expected = generation.current;
    try {
      const next = parseMafiaEnvelope(await request(admission.path, 'POST', admission.body, undefined, expected), true);
      if (!active.current || expected !== generation.current) return;
      if (next.room.roomId !== (roomId ?? admission.body.requestId) || next.room.self.id !== admission.body.requestId || next.session?.token !== admission.body.playerToken || !roomId && next.session?.inviteToken !== admission.body.inviteToken) throw new Error('The room response did not match your requested seat. Retry the same request.');
      accept(next, true); try { clearMafiaAdmission(roomId ?? 'create'); } catch { /* Seat state is retained in memory. */ } setPendingAdmission(undefined);
      void navigate(`/mafia/${next.room.roomId}`);
    } catch (value) {
      if (active.current && expected === generation.current) {
        setError(errorText(value));
        if (value instanceof MafiaAPIError && value.status >= 400 && value.status < 500 && ![408, 429].includes(value.status)) { setPendingAdmission(undefined); try { clearMafiaAdmission(roomId ?? 'create'); } catch { /* Keep the UI available. */ } }
      }
    } finally { if (active.current && expected === generation.current) { locked.current = false; setBusy(false); } }
  }
  async function act(action: MafiaAction): Promise<boolean> {
    const seat = currentSession.current, state = currentRoom.current;
    if (!seat || !state || locked.current) return false;
    if (actionRetry.current && action !== actionRetry.current) { setError('Confirm the previous action with Retry action before making another choice.'); return false; }
    const payload: PendingAction = actionRetry.current ?? { ...action, requestId: crypto.randomUUID(), phaseId: state.phaseId, sequence: state.self.actionSequence + 1 };
    actionRetry.current = payload; locked.current = true; setBusy(true); setError(''); const expected = generation.current;
    try {
      const next = parseMafiaEnvelope(await request(`/mafia/rooms/${seat.roomId}/actions`, 'POST', payload, seat.token, expected));
      if (!active.current || expected !== generation.current) return false;
      accept(next); actionRetry.current = undefined; setUncertainAction(undefined); setError('');
      return true;
    } catch (value) {
      if (active.current && expected === generation.current) {
        setError(errorText(value));
        if (value instanceof MafiaAPIError && value.status === 409) {
          try { const next = parseMafiaEnvelope(await request(`/mafia/rooms/${seat.roomId}`, 'GET', undefined, seat.token, expected)); if (active.current && expected === generation.current) { accept(next); actionRetry.current = undefined; setUncertainAction(undefined); setNotice('The room moved on. Your current choices are shown below.'); } } catch { setUncertainAction(payload); }
        } else if (value instanceof MafiaAPIError && value.status >= 400 && value.status < 500 && ![408, 429].includes(value.status)) { actionRetry.current = undefined; setUncertainAction(undefined); }
        else setUncertainAction(payload);
      }
      return false;
    } finally { if (active.current && expected === generation.current) { locked.current = false; setBusy(false); } }
  }
  function openInvitation(event: FormEvent) {
    event.preventDefault(); const parsed = parseMafiaInvitation(inviteInput.trim(), window.location.origin);
    if (!parsed) { setError('Paste a complete private Mafia invitation from this Game Studio.'); return; }
    void navigate(`/mafia/${parsed.roomId}#join=${parsed.inviteToken}`);
  }
  async function copyInvitation() { try { await navigator.clipboard.writeText(invitation); setNotice('Invitation copied. Send it privately to your group.'); } catch { setNotice('Select the invitation field and copy it to invite your group.'); } }
  const disabled = busy || Boolean(uncertainAction), activePlayers = room?.players.filter(player => !player.isNarrator && !player.left) ?? [], remaining = room?.deadlineAt ? Math.max(0, Math.ceil(room.deadlineAt - now / 1000)) : 0;
  const own = room?.players.find(player => player.id === room.self.id), narrator = room?.players.find(player => player.id === room.narratorId);
  return <main id="main" className={`mafia-page${room?.phase === 'night' ? ' mafia-night' : ''}`}>
    {!roomId && !room && <p className="mafia-in-person"><button className="text-button" onClick={() => void navigate('/party/mafia/host')}>Playing together in person? Host on one screen →</button></p>}
    <div className="mafia-breadcrumb"><button className="text-button" onClick={() => void navigate('/games')}>← Back to Games</button><span>Social deduction · Live party</span></div>
    <PartyInstructions kind="mafia"/>
    {!room ? <>
      <header className="mafia-hero"><div><span className="eyebrow">A LITTLE MYSTERY. A LOT OF FRIENDS.</span><h1>Mafia<span>A town full of secrets.</span></h1><p>A secret team. A watchful detective. A doctor who might save the night. Gather your group and decide who you can trust.</p><div className="mafia-hero-tags"><span>5–24 players</span><span>Text & click voting</span><span>No sign-in to play</span></div></div><div className="mafia-town-art" aria-hidden="true"><span className="mafia-art-moon">☾</span><span className="mafia-art-cloud">✦</span><div className="mafia-art-roofs"><i/><i/><i/><i/><i/></div><div className="mafia-art-friends">🦊 🐸 🐼</div><span className="mafia-art-note">EVERYONE HAS A STORY.<br/>SOME HAVE A SECRET.</span></div></header>
      <div className="mafia-entry-grid"><section className="mafia-panel mafia-entry"><span className="eyebrow">{roomId ? 'YOUR INVITATION IS WAITING' : 'START THE STORY'}</span><h2>{roomId ? 'Join the town.' : 'Bring your people.'}</h2>{loading ? <p role="status">Finding your saved seat…</p> : session ? <><p>Your seat is saved in this browser. We’re reconnecting to the room.</p><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Try reconnecting</button><button className="text-button" onClick={() => { forgetMafiaSession(session.roomId); setSession(undefined); currentSession.current = undefined; setError(''); }}>Use an invitation instead</button></> : <form onSubmit={event => void admit(event)}>{!roomId && <p>Invite friends or add AI players after creating a room.</p>}
        <label htmlFor="mafia-player-name">Your game name<input id="mafia-player-name" autoComplete="off" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Nova" disabled={busy || Boolean(pendingAdmission)} aria-describedby="mafia-name-help" /></label><small id="mafia-name-help">1–16 characters. Pick a nickname your group will recognize.</small>
        <fieldset className="mafia-avatar-picker" disabled={busy || Boolean(pendingAdmission)}><legend>Choose your avatar</legend><div>{MAFIA_AVATARS.map(([id, emoji, label]) => <button key={id} type="button" className={avatar === id ? 'selected' : ''} aria-label={label} aria-pressed={avatar === id} onClick={() => setAvatar(id)}><span aria-hidden="true">{emoji}</span></button>)}</div></fieldset>
        {!roomId && <><fieldset className="mafia-mode-picker" disabled={busy || Boolean(pendingAdmission)}><legend>Who tells the story?</legend><label className={narratorMode === 'human' ? 'selected' : ''}><input type="radio" name="mafia-mode" value="human" checked={narratorMode === 'human'} onChange={() => setNarratorMode('human')}/><span><strong>One of us</strong><small>You start as narrator. Hand it to someone else before play.</small></span><span aria-hidden="true">✍️</span></label><label className={narratorMode === 'automatic' ? 'selected' : ''}><input type="radio" name="mafia-mode" value="automatic" checked={narratorMode === 'automatic'} onChange={() => setNarratorMode('automatic')}/><span><strong>Automatic narrator</strong><small>The game guides every phase. Everyone gets to play.</small></span><span aria-hidden="true">↻</span></label><label className={narratorMode === 'ai' ? 'selected' : ''}><input type="radio" name="mafia-mode" value="ai" checked={narratorMode === 'ai'} onChange={() => setNarratorMode('ai')} disabled={!config?.aiAvailable}/><span><strong>AI narrator</strong><small>{config?.aiAvailable ? 'Automatic rounds and AI-written narration. Everyone gets to play.' : 'The host is preparing this option. Human narration is ready now.'}</small></span><span aria-hidden="true">✨</span></label></fieldset><label htmlFor="mafia-capacity">Room size<select id="mafia-capacity" value={settings.maxPlayers} onChange={event => setSettings(value => ({ ...value, maxPlayers: Number(event.target.value) }))} disabled={busy || Boolean(pendingAdmission)}>{Array.from({ length: 20 }, (_, index) => index + 5).map(count => <option key={count} value={count}>Up to {count} players{narratorMode === 'human' ? ' + narrator' : ''}</option>)}</select></label></>}
        {roomId && !joinToken && <p className="mafia-inline-note">You’ll need the private invitation link from the host to join this room.</p>}
        <button className="button primary mafia-entry-submit" disabled={busy || !name.trim() || Boolean(roomId && !joinToken) || !pendingAdmission && narratorMode === 'ai' && !config?.aiAvailable}>{busy ? 'Opening your seat…' : pendingAdmission ? 'Retry the same request' : roomId ? 'Join the town →' : 'Create a private room →'}</button>
      </form>}
      </section><aside className="mafia-entry-aside">{!roomId && <section className="mafia-panel mafia-join-card"><span className="eyebrow">INVITED BY A FRIEND?</span><h2>There’s a seat for you.</h2><form onSubmit={openInvitation}><label htmlFor="mafia-invite-paste">Private invitation link<input id="mafia-invite-paste" value={inviteInput} onChange={event => setInviteInput(event.target.value)} placeholder="Paste the host’s invitation" autoComplete="off" autoCapitalize="none" spellCheck={false}/></label><button className="button secondary" disabled={!inviteInput.trim()}>Open invitation →</button></form></section>}<section className="mafia-rules"><span className="eyebrow">THE SHORT VERSION</span><h2>Keep your secret.<br/>Find your team.</h2><ol><li><strong>Night falls.</strong> Mafia choose a target, the Doctor protects someone, and the Detective investigates.</li><li><strong>The town wakes.</strong> Share theories in the town chat. Anyone can bluff.</li><li><strong>Cast your vote.</strong> Choose who leaves, or skip. Tied votes eliminate no one.</li></ol><p>The town wins by finding all Mafia. The Mafia win when they equal or outnumber the town. A human narrator sits out; automatic narration lets everyone play.</p></section></aside></div>
      <section className="mafia-role-guide" aria-label="The four roles">{(['mafia', 'detective', 'doctor', 'civilian'] as const).map(role => <article key={role}><span aria-hidden="true">{roleIcon[role]}</span><h3>{mafiaRoleLabel(role)}</h3><p>{roleHelp[role]}</p></article>)}</section>
    </> : <>
      <header className="mafia-room-heading"><div><span className="eyebrow">MAFIA · YOUR PRIVATE TOWN</span><h1>{mafiaPhaseLabel(room)}</h1><p>{room.narratorMode === 'human' ? `✍️ ${narrator?.name ?? 'Your narrator'} tells the story` : room.narratorMode === 'ai' ? '✨ AI story narrator · automatic rounds' : '↻ Automatic narrator · everyone plays'}</p></div><div className="mafia-phase-badge"><span aria-hidden="true">{room.phase === 'night' ? '☾' : room.phase === 'voting' ? '🗳️' : room.phase === 'finished' ? '✦' : '☀'}</span><strong>{room.deadlineAt ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : `${activePlayers.length} / ${room.settings.maxPlayers}`}</strong><small>{room.deadlineAt ? remaining ? 'phase time' : room.narratorMode !== 'human' ? 'syncing the next phase' : 'narrator can resolve' : 'players in the town'}</small></div></header>
      {room.phase === 'lobby' ? <>
        <div className="mafia-lobby-banner"><span aria-hidden="true">✉</span><div><strong>Good mysteries start with good company.</strong><p>Gather at least five players, including friends or AI players{room.narratorMode === 'human' ? ', plus a narrator' : ''}. Names and avatars are visible to this room. Roles stay secret until the game begins.</p></div></div>
        {invitation && <div className="mafia-invitation"><label htmlFor="mafia-room-invite">Private invitation<input id="mafia-room-invite" value={invitation} readOnly onFocus={event => event.target.select()} autoComplete="off" spellCheck={false}/></label><button className="button secondary" onClick={() => void copyInvitation()}>Copy invitation</button><small>Share only with your group. Anyone with the link can join before the game starts.</small></div>}
        <div className="mafia-lobby-grid"><section className="mafia-panel"><div className="mafia-section-title"><div><span className="eyebrow">THE CAST</span><h2>Your town is gathering.</h2></div><span>{activePlayers.length} players</span></div><PlayerGrid room={room}/><p className="mafia-small-note">You are {own?.name ?? 'in the room'} {own ? avatarFor(own.avatar)[1] : ''}. Keep this browser tab to return to your seat after a refresh.</p></section><aside className="mafia-panel mafia-lobby-controls"><span className="eyebrow">BEFORE THE FIRST NIGHT</span><h2>{room.self.isOwner ? 'Set the scene.' : 'Make yourself at home.'}</h2>{room.self.isOwner ? <>
          <label htmlFor="mafia-room-narration">Narration<select id="mafia-room-narration" value={room.narratorMode} disabled={disabled} onChange={event => void act({ type: 'configure', narratorMode: event.target.value as 'human' | 'automatic' | 'ai' })}><option value="human">A person in this room</option><option value="automatic">Automatic narrator · everyone plays</option><option value="ai" disabled={!config?.aiAvailable}>AI story narrator · everyone plays</option></select></label>
          {room.narratorMode === 'human' && <label htmlFor="mafia-narrator-seat">Narrator<select id="mafia-narrator-seat" value={room.narratorId ?? ''} disabled={disabled} onChange={event => void act({ type: 'reassign-narrator', targetId: event.target.value })}>{room.players.filter(player => !player.left && !player.isAI).map(player => <option key={player.id} value={player.id}>{player.name}{player.id === room.self.id ? ' (you)' : ''}</option>)}</select><small>The narrator sees every role and guides the game. They don’t play a secret role.</small></label>}
          <LobbySettings room={room} disabled={disabled} onSave={next => act({ type: 'configure', settings: next })}/>
          <div className="mafia-ai-controls" style={{ marginBlock: '1rem' }}><strong>Play with AI</strong><p>Mix friends and AI players. Add one keeps your current narrator. Fill uses automatic narration so everyone can play.</p><div className="mafia-ai-buttons" style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginBlock: '.75rem' }}><button className="button secondary" disabled={disabled || activePlayers.length >= room.settings.maxPlayers} onClick={() => void act({ type: 'add-ai' })}>Add AI player</button><button className="button secondary" disabled={disabled || room.players.filter(player => !player.left).length > room.settings.maxPlayers || room.narratorMode === 'automatic' && activePlayers.length >= 5} onClick={() => void act({ type: 'fill-ai' })}>{room.narratorMode !== 'automatic' ? 'Fill with AI & use automatic narrator' : 'Fill to 5 players'}</button></div><small>Adds only the AI players needed for five. Start the game when you’re ready.</small>{room.narratorMode === 'human' && room.players.filter(player => !player.left).length > room.settings.maxPlayers && <small>Increase room size or remove a seat before switching everyone into play.</small>}</div>
          <button className="button primary mafia-entry-submit" disabled={disabled || activePlayers.length < 5} onClick={() => void act({ type: 'start' })}>Start the first night →</button><p className="mafia-small-note">{activePlayers.length < 5 ? `${5 - activePlayers.length} more player${5 - activePlayers.length === 1 ? '' : 's'} needed to begin.` : 'Everyone is here. Start when your group is ready.'} No one can join after the first night starts.</p>
          <details className="mafia-manage-seats"><summary>Manage seats</summary>{room.players.filter(player => player.id !== room.self.id && !player.left).map(player => <div key={player.id}><span>{avatarFor(player.avatar)[1]} <PartyPlayerName player={player}/></span><button className="text-button" disabled={disabled || player.isNarrator} onClick={() => void act({ type: 'kick', targetId: player.id })} aria-label={`Remove ${partyPlayerLabel(player)}`}>Remove</button></div>)}</details>
        </> : <p>{room.narratorMode === 'human' ? `${narrator?.name ?? 'The narrator'} will guide the story.` : room.narratorMode === 'ai' ? 'The AI narrator will guide every round.' : 'The automatic narrator will guide every round.'} The host will begin when everyone has arrived. Keep your role private, listen closely and have fun.</p>}</aside></div>
      </> : room.phase === 'closed' ? <section className="mafia-panel mafia-ended"><span aria-hidden="true">☾</span><h2>The town has gone home.</h2><p>The host closed this room. You can gather your group in a fresh room whenever you’re ready.</p><button className="button primary" onClick={() => void navigate('/mafia')}>Create another room →</button></section> : <>
        {room.events.length > 0 && <section className="mafia-narration" aria-label="Latest narration" aria-live="polite"><span className="eyebrow">{room.narratorMode === 'ai' ? 'YOUR AI NARRATOR' : room.narratorMode === 'automatic' ? 'AUTOMATIC NARRATOR' : 'THE NARRATOR'}</span><p>{room.events.at(-1)?.text}</p></section>}
        {room.phase === 'finished' && <section className={`mafia-finale mafia-winner-${room.winner}`}><span aria-hidden="true">{room.winner === 'town' ? '☀️' : '🎭'}</span><div><span className="eyebrow">THE SECRET IS OUT</span><h2>{room.winner === 'town' ? 'The town wins!' : 'The Mafia win!'}</h2><p>{room.winner === 'town' ? 'The town found every Mafia member. The mystery is solved.' : 'The Mafia now equal or outnumber the town. What a story.'}</p></div>{room.self.isOwner ? <button className="button primary" disabled={disabled} onClick={() => void act({ type: 'restart' })}>Play again with this group →</button> : <p className="mafia-small-note">The host can start another round with this group.</p>}</section>}
        <div className="mafia-play-grid"><section className="mafia-main-stage"><section className="mafia-panel"><div className="mafia-section-title"><div><span className="eyebrow">THE TOWN</span><h2>{room.phase === 'voting' ? 'Every vote tells a story.' : room.phase === 'night' ? 'The town is asleep.' : room.phase === 'finished' ? 'Meet the whole cast.' : 'Who do you believe?'}</h2></div><span>{activePlayers.filter(player => player.alive).length} still playing</span></div><PlayerGrid room={room}/>{!room.self.alive && !room.self.isNarrator && room.phase !== 'finished' && <p className="mafia-inline-note">You’re watching from the sidelines. Read along and keep the town’s secrets until the game ends.</p>}
          {room.phase === 'discussion' && room.self.alive && !room.self.isNarrator && <div className="mafia-ready"><p>Talk it through in the town chat. When you’re ready to vote, let the group know.</p><button className="button secondary" aria-pressed={room.self.ready} disabled={disabled || room.self.ready} onClick={() => void act({ type: 'ready' })}>{room.self.ready ? '✓ Ready to vote' : 'I’m ready to vote'}</button></div>}
          {room.phase === 'voting' && room.self.alive && !room.self.isNarrator && <ChoicePanel key={`${room.phaseId}-vote`} room={room} disabled={disabled} onChoose={targetId => act({ type: 'vote', targetId })}/>}
        </section>
        <ChatPanel title="Town square" subtitle={room.phase === 'night' ? 'The square is quiet until morning.' : 'Share theories. Make your case. Be kind.'} messages={room.chat} players={room.players} disabled={disabled} canSend={['discussion', 'voting'].includes(room.phase) && room.self.alive && !room.self.isNarrator} onSend={text => act({ type: 'chat', channel: 'public', text })}/>
        <details className="mafia-story"><summary>The town’s story</summary><ol>{room.events.map(event => <li key={event.id}><span>{event.day ? `Round ${event.day}` : 'The beginning'}</span><p>{event.text}</p></li>)}</ol></details>
        </section><aside className="mafia-private-stage"><section className={`mafia-panel mafia-secret-card${showPrivate ? ' open' : ''}`}><span className="eyebrow">FOR YOUR EYES ONLY</span><div className="mafia-secret-mark" aria-hidden="true">{showPrivate ? room.self.isNarrator ? '✍️' : room.self.role ? roleIcon[room.self.role] : '✦' : '?'}</div><h2>{showPrivate ? room.self.isNarrator ? 'You are the narrator.' : room.self.role ? `You are ${room.self.role === 'mafia' ? 'Mafia' : `the ${mafiaRoleLabel(room.self.role)}`}.` : 'Your seat in the story.' : room.self.isNarrator ? 'Narrator’s notes' : 'Your secret role'}</h2><p>{showPrivate ? room.self.isNarrator ? 'Guide the phases and keep private roles out of public narration.' : room.self.role ? roleHelp[room.self.role] : 'The story will begin when the host starts the room.' : 'Make sure nobody is looking over your shoulder.'}</p><button className="button secondary" aria-expanded={showPrivate} onClick={() => setShowPrivate(value => !value)}>{showPrivate ? 'Hide private information' : room.self.isNarrator ? 'Open narrator notes' : 'Reveal my role'}</button>
          {showPrivate && room.self.role === 'mafia' && room.self.allies.length > 0 && <div className="mafia-allies"><strong>Your Mafia team</strong><ul>{room.self.allies.map(id => { const ally = room.players.find(player => player.id === id); return <li key={id}>{ally && avatarFor(ally.avatar)[1]} <PartyPlayerName player={ally} fallback="A teammate"/>{ally && !ally.alive ? ' · out' : ''}</li>; })}</ul></div>}
          {showPrivate && room.self.role === 'detective' && room.self.checks.length > 0 && <div className="mafia-checks"><strong>Your investigations</strong><ul>{room.self.checks.map(check => <li key={`${check.day}-${check.targetId}`}><span>Night {check.day} · <PartyPlayerName player={room.players.find(player => player.id === check.targetId)}/></span><strong>{check.isMafia ? 'Mafia' : 'Not Mafia'}</strong></li>)}</ul></div>}
          {room.phase === 'night' && room.self.alive && !room.self.isNarrator && !showPrivate && <p className="mafia-small-note">Open your role card to see whether you have a night action.</p>}
          {showPrivate && room.phase === 'night' && room.self.alive && !room.self.isNarrator && <ChoicePanel key={`${room.phaseId}-night`} room={room} disabled={disabled} onChoose={targetId => act({ type: 'night-action', targetId })}/>}
          {showPrivate && room.self.isNarrator && room.narratorInfo && <div className="mafia-narrator-notes"><strong>Private role list</strong><ul>{room.narratorInfo.roles.map(item => { const player = room.players.find(p => p.id === item.playerId); return <li key={item.playerId}><span><PartyPlayerName player={player}/>{player && !player.alive ? ' · out' : ''}</span><strong>{mafiaRoleLabel(item.role)}</strong></li>; })}</ul>{room.phase === 'night' && <><p>{room.narratorInfo.submitted} of {room.narratorInfo.required} secret choices submitted.</p><ul>{Object.entries(room.narratorInfo.nightActions).map(([id, targetId]) => <li key={id}><span><PartyPlayerName player={room.players.find(p => p.id === id)}/></span><strong>→ <PartyPlayerName player={room.players.find(p => p.id === targetId)}/></strong></li>)}</ul></>}</div>}
        </section>
        {showPrivate && (room.self.role === 'mafia' && room.self.alive || room.self.isNarrator) && room.phase !== 'finished' && <ChatPanel title="Mafia whispers" subtitle="Only living Mafia and the human narrator can read this." messages={room.mafiaChat} players={room.players} disabled={disabled} canSend={room.phase === 'night' && room.self.role === 'mafia' && room.self.alive} onSend={text => act({ type: 'chat', channel: 'mafia', text })} privateChannel/>}
        {room.self.isNarrator && ['night', 'discussion', 'voting'].includes(room.phase) && <section className="mafia-panel mafia-narrator-controls"><span className="eyebrow">GUIDE THE STORY</span><h2>Your next cue.</h2><p>{room.phase === 'night' ? 'Wait for the secret choices, then wake the town.' : room.phase === 'discussion' ? 'Give everyone time to talk, then open the vote.' : 'Wait for the ballots, then reveal the result.'}</p><button className="button primary" disabled={disabled || !(room.narratorInfo?.readyToAdvance || room.phase === 'discussion' || room.deadlineAt && remaining === 0)} onClick={() => void act({ type: 'advance', ...(room.deadlineAt && remaining === 0 && !room.narratorInfo?.readyToAdvance ? { force: true } : {}) })}>{room.phase === 'night' ? 'Wake the town →' : room.phase === 'discussion' ? 'Open the vote →' : 'Resolve the vote →'}</button>{room.deadlineAt && remaining === 0 && !room.narratorInfo?.readyToAdvance && <p className="mafia-small-note">Time is up. Missing choices count as a skip.</p>}<ChatComposer label="A message from the narrator" disabled={disabled} onSend={text => act({ type: 'announce', text })}/></section>}
        </aside></div>
      </>}
      <div className="mafia-room-footer"><span>Your seat stays saved when you leave this page.</span><div>{room.self.isOwner && room.phase !== 'closed' ? confirmClose ? <div className="mafia-close-confirm"><span>Close this room for everyone?</span><button className="text-button" disabled={disabled} onClick={() => { setConfirmClose(false); void act({ type: 'close' }); }}>Yes, close room</button><button className="text-button" onClick={() => setConfirmClose(false)}>Keep playing</button></div> : <button className="text-button" onClick={() => setConfirmClose(true)}>Close room</button> : !room.self.isNarrator && !['closed', 'finished'].includes(room.phase) && <button className="text-button" disabled={disabled} onClick={() => void act({ type: 'leave' })}>Leave this room</button>}<button className="text-button" onClick={() => void navigate('/games')}>Return to Games</button></div></div>
    </>}
    {(error || notice || uncertainAction) && <div className="mafia-feedback">{error && <p className="error" role="alert">{error}</p>}{notice && <p className="mafia-notice" role="status">{notice}</p>}{uncertainAction && <button className="button secondary" disabled={busy} onClick={() => { if (actionRetry.current) void act(actionRetry.current); }}>{busy ? 'Confirming…' : 'Retry the same action'}</button>}</div>}
  </main>;
}

function PlayerGrid({ room }: { room: MafiaRoom }) {
  return <ul className="mafia-player-grid" aria-label="Players in this room">{room.players.filter(player => !player.left).map(player => <li key={player.id} className={`${player.isNarrator ? 'narrator' : ''}${!player.alive && room.phase !== 'lobby' && !player.isNarrator ? ' eliminated' : ''}${player.id === room.self.id ? ' self' : ''}`}><span className="mafia-player-avatar" aria-hidden="true">{avatarFor(player.avatar)[1]}</span><strong><PartyPlayerName player={player}/><small>{player.id === room.self.id ? 'You' : player.isAI ? 'AI player' : player.id === room.ownerId ? 'Host' : player.isNarrator ? 'Narrator' : player.alive || room.phase === 'lobby' ? 'In the town' : 'Watching'}</small></strong><span className="mafia-player-tag">{player.isNarrator ? '✍️ Narrator' : room.phase === 'finished' && player.role ? `${roleIcon[player.role]} ${mafiaRoleLabel(player.role)}` : room.phase !== 'lobby' && !player.alive ? 'Out' : ''}</span></li>)}</ul>;
}
function LobbySettings({ room, disabled, onSave }: { room: MafiaRoom; disabled: boolean; onSave: (value: MafiaSettings) => Promise<boolean> }) {
  const [settings, setSettings] = useState(room.settings);
  useEffect(() => setSettings(room.settings), [JSON.stringify(room.settings)]);
  const changed = JSON.stringify(settings) !== JSON.stringify(room.settings);
  return <details className="mafia-timing"><summary>Room size & phase timing</summary><div>{([['maxPlayers', 'Players', 5, 24], ['nightSeconds', 'Night · seconds', 30, 300], ['discussionSeconds', 'Discussion · seconds', 30, 300], ['votingSeconds', 'Voting · seconds', 30, 300]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} step={1} value={settings[key]} disabled={disabled} onChange={event => setSettings(previous => ({ ...previous, [key]: Number(event.target.value) }))}/></label>)}</div><button className="button secondary" disabled={disabled || !changed || Object.entries(settings).some(([key, value]) => !Number.isInteger(value) || value < (key === 'maxPlayers' ? 5 : 30) || value > (key === 'maxPlayers' ? 24 : 300))} onClick={() => void onSave(settings)}>Save room settings</button></details>;
}
function ChoicePanel({ room, disabled, onChoose }: { room: MafiaRoom; disabled: boolean; onChoose: (targetId: string) => Promise<boolean> }) {
  const voting = room.phase === 'voting', saved = voting ? room.self.voteTargetId : room.self.nightTargetId, [choice, setChoice] = useState(saved ?? '');
  useEffect(() => setChoice(saved ?? ''), [saved]);
  const eligible = mafiaEligibleTargets(room);
  if (!voting && room.self.role === 'civilian') return <p className="mafia-inline-note">You have no night action. Rest easy and watch for the morning.</p>;
  if (!eligible.length) return null;
  return <div className="mafia-choice"><h3>{voting ? 'Who should leave the town?' : room.self.role === 'doctor' ? 'Who will you protect?' : room.self.role === 'detective' ? 'Who will you investigate?' : 'Choose the Mafia’s target.'}</h3><p>{voting ? 'Ballots stay secret until the result. You can change your vote until the phase ends.' : 'Your choice stays private. Confirm it before the night ends.'}</p><div className="mafia-targets">{eligible.map(player => <button key={player.id} type="button" className={choice === player.id ? 'selected' : ''} aria-pressed={choice === player.id} disabled={disabled} onClick={() => setChoice(player.id)}><span aria-hidden="true">{avatarFor(player.avatar)[1]}</span><strong><PartyPlayerName player={player}/></strong>{player.id === room.self.id && <small>You</small>}</button>)}{voting && <button type="button" className={choice === 'skip' ? 'selected' : ''} aria-pressed={choice === 'skip'} disabled={disabled} onClick={() => setChoice('skip')}><span aria-hidden="true">↷</span><strong>Skip</strong><small>Eliminate no one</small></button>}</div><button className="button primary" disabled={disabled || !choice || choice === saved} onClick={() => void onChoose(choice)}>{choice === saved ? '✓ Choice confirmed' : saved ? 'Change my choice' : voting ? 'Confirm my vote' : 'Confirm secret choice'}</button>{saved && <p className="mafia-small-note">Confirmed: {saved === 'skip' ? 'skip' : <PartyPlayerName player={room.players.find(player => player.id === saved)}/>}. {room.narratorMode !== 'human' ? 'The phase can end as soon as everyone has chosen.' : 'Your narrator will guide the next phase.'}</p>}</div>;
}
function ChatPanel({ title, subtitle, messages, players, disabled, canSend, onSend, privateChannel = false }: { title: string; subtitle: string; messages: MafiaChat[]; players: MafiaPlayer[]; disabled: boolean; canSend: boolean; onSend: (text: string) => Promise<boolean>; privateChannel?: boolean }) {
  const log = useRef<HTMLOListElement>(null), following = useRef(true);
  useEffect(() => { if (log.current && following.current) log.current.scrollTop = log.current.scrollHeight; }, [messages.at(-1)?.id]);
  return <section className={`mafia-panel mafia-chat${privateChannel ? ' mafia-chat-private' : ''}`}><span className="eyebrow">{privateChannel ? 'A SECRET CONVERSATION' : 'THE CONVERSATION'}</span><h2>{title}</h2><p className="mafia-chat-subtitle">{subtitle}</p><ol ref={log} onScroll={() => { if (log.current) following.current = log.current.scrollHeight - log.current.clientHeight - log.current.scrollTop < 60; }} className="mafia-chat-log" role="log" aria-label={title} aria-live="polite" aria-relevant="additions">{messages.length ? messages.map(message => { const player = players.find(item => item.id === message.playerId); return <li key={message.id}><span aria-hidden="true">{player ? avatarFor(player.avatar)[1] : '✦'}</span><div><strong><PartyPlayerName player={player} fallback="A player"/></strong><p>{message.text}</p></div></li>; }) : <li className="mafia-chat-empty">{privateChannel ? 'Plan quietly with your team when night falls.' : 'The first theory is yours to tell.'}</li>}</ol>{canSend ? <ChatComposer label={privateChannel ? 'Whisper to the Mafia' : 'Message the town'} disabled={disabled} onSend={onSend}/> : <p className="mafia-small-note">{privateChannel ? 'Private whispers open at night.' : 'Messages open for living players during discussion and voting.'}</p>}</section>;
}
function ChatComposer({ label, disabled, onSend }: { label: string; disabled: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(''), count = [...text].length;
  async function send(event: FormEvent) { event.preventDefault(); const snapshot = text; if (!text.trim() || count > 240) return; if (await onSend(text.trim())) setText(current => current === snapshot ? '' : current); }
  return <form className="mafia-chat-compose" onSubmit={event => void send(event)}><label>{label}<textarea rows={2} value={text} onChange={event => setText(event.target.value)} disabled={disabled} maxLength={480} placeholder="Write a short message…"/></label><div><small>{count}/240 characters</small><button className="button secondary" disabled={disabled || !text.trim() || count > 240}>Send →</button></div></form>;
}
