/** Anonymous two-seat room capabilities live only in the current page's memory. */
export type MultiplayerSeat = 0 | 1;
export type MultiplayerRoom = { gameId: string; publishedRevision: number; specSha256: string; roomId: string; token: string; expiresAt: number; socketUrl: string; seat: MultiplayerSeat };
export type MultiplayerLobbyRoom = { roomId: string; gameId: string; publishedRevision: number; specSha256: string; title: string; expiresAt: number };
export type MultiplayerInvitation = { roomId: string; inviteToken: string };
export type MultiplayerStatus = 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'ended' | 'expired';
export type MultiplayerServerMessage =
  | { type: 'ready'; gameId: string; publishedRevision: number; specSha256: string; roomId: string; seat: MultiplayerSeat; expiresAt: number }
  | { type: 'peer'; connected: boolean }
  | { type: 'input'; seq: number; mask: number }
  | { type: 'state'; seq: number; state: unknown }
  | { type: 'pong' }
  | { type: 'lease'; expiresAt: number }
  | { type: 'closed'; reason: 'expired' | 'host-disconnected' | 'publication-changed' | 'closed' }
  | { type: 'error'; message: string };
const roomPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const maxMessageBytes = 25600;
function publication(value: Record<string, unknown>): boolean { return typeof value.gameId === 'string' && roomPattern.test(value.gameId) && Number.isSafeInteger(value.publishedRevision) && Number(value.publishedRevision) >= 1 && Number(value.publishedRevision) <= 1000000000 && typeof value.specSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.specSha256); }
export function sameMultiplayerPublication(room: Pick<MultiplayerRoom, 'gameId' | 'publishedRevision' | 'specSha256'>, binding: { game_id: string; published_revision: number; spec_sha256: string }): boolean { return room.gameId === binding.game_id && room.publishedRevision === binding.published_revision && room.specSha256 === binding.spec_sha256; }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export function validMultiplayerSequence(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10000000; }
export function validMultiplayerInput(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 63; }
export function parseMultiplayerInvitation(value: string, origin: string, gameId: string): MultiplayerInvitation | undefined {
  // Full invitation links are accepted only for this game and this installation.
  if (value.length > 2300) return;
  let fragment = value.trim();
  if (fragment.startsWith('http://') || fragment.startsWith('https://')) {
    try { const url = new URL(fragment); if (url.origin !== origin || url.pathname !== `/games/${gameId}` || url.search || url.username || url.password) return; fragment = url.hash; } catch { return; }
  }
  if (fragment.startsWith('#coop=')) fragment = fragment.slice(6);
  const parts = fragment.split('.');
  if (parts.length !== 2 || !roomPattern.test(parts[0]) || !tokenPattern.test(parts[1])) return;
  return { roomId: parts[0], inviteToken: parts[1] };
}
export type MultiplayerInvitationSurface = {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'state' | 'replaceState'>;
  addEventListener: (type: 'hashchange', listener: () => void) => void;
  removeEventListener: (type: 'hashchange', listener: () => void) => void;
};
/** Consume every arriving capability before callbacks, including same-page navigation. */
export function watchMultiplayerInvitations(surface: MultiplayerInvitationSurface, onInvitation: (fragment: string) => void): () => void {
  const consume = () => {
    const fragment = surface.location.hash;
    if (!fragment.startsWith('#coop=')) return;
    surface.history.replaceState(surface.history.state, '', `${surface.location.pathname}${surface.location.search}`);
    onInvitation(fragment);
  };
  surface.addEventListener('hashchange', consume); consume();
  return () => surface.removeEventListener('hashchange', consume);
}
export function createMultiplayerInvitation(origin: string, gameId: string, invitation: MultiplayerInvitation): string {
  if (!roomPattern.test(gameId) || !roomPattern.test(invitation.roomId) || !tokenPattern.test(invitation.inviteToken)) throw new Error('The game invitation is invalid.');
  const url = new URL(`/games/${gameId}`, origin); url.hash = `coop=${invitation.roomId}.${invitation.inviteToken}`; return url.href;
}
export function validateMultiplayerSocketURL(value: unknown, localPreview = false): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try { const url = new URL(value); if (url.username || url.password || url.search || url.hash || !url.hostname || !url.pathname || (url.protocol !== 'wss:' && !(localPreview && url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) return; return url.href; } catch { return; }
}
function expiry(value: unknown, now: number): value is number { return Number.isSafeInteger(value) && Number(value) > Math.floor(now / 1000) && Number(value) <= Math.floor(now / 1000) + 1860; }
/** The public lobby carries publication bindings, never an invitation or seat capability. */
export function validateMultiplayerLobby(value: unknown, now = Date.now()): MultiplayerLobbyRoom[] | undefined {
  if (!object(value) || !exact(value, ['rooms']) || !Array.isArray(value.rooms) || value.rooms.length > 20) return;
  const ids = new Set<string>(), rooms: MultiplayerLobbyRoom[] = [];
  for (const room of value.rooms) {
    if (!object(room) || !exact(room, ['roomId', 'gameId', 'publishedRevision', 'specSha256', 'title', 'expiresAt']) || typeof room.roomId !== 'string' || !roomPattern.test(room.roomId) || ids.has(room.roomId) || !publication(room) || !expiry(room.expiresAt, now) || typeof room.title !== 'string' || !room.title || room.title !== room.title.trim() || room.title.length > 80 || /[<>\u0000-\u001f\u007f-\u009f]/u.test(room.title)) return;
    ids.add(room.roomId);
    rooms.push({ roomId: room.roomId, gameId: room.gameId as string, publishedRevision: room.publishedRevision as number, specSha256: room.specSha256 as string, title: room.title, expiresAt: room.expiresAt });
  }
  return rooms;
}
export function validateMultiplayerRoom(value: unknown, seat: MultiplayerSeat, localPreview = false, now = Date.now()): MultiplayerRoom | undefined {
  if (!object(value) || !exact(value, ['roomId', seat === 0 ? 'hostToken' : 'guestToken', ...(seat === 0 ? ['inviteToken'] : []), 'expiresAt', 'socketUrl', 'gameId', 'publishedRevision', 'specSha256']) || typeof value.roomId !== 'string' || !roomPattern.test(value.roomId) || !expiry(value.expiresAt, now) || !publication(value)) return;
  const token = value[seat === 0 ? 'hostToken' : 'guestToken'];
  if (typeof token !== 'string' || !tokenPattern.test(token) || (seat === 0 && (typeof value.inviteToken !== 'string' || !tokenPattern.test(value.inviteToken)))) return;
  const socketUrl = validateMultiplayerSocketURL(value.socketUrl, localPreview); if (!socketUrl) return;
  return { roomId: value.roomId, token, expiresAt: value.expiresAt, socketUrl, seat, gameId: value.gameId as string, publishedRevision: value.publishedRevision as number, specSha256: value.specSha256 as string };
}
export function validateMultiplayerServerMessage(raw: unknown, validateState: (state: unknown) => boolean): MultiplayerServerMessage | undefined {
  if (typeof raw !== 'string' || raw.length > maxMessageBytes || new TextEncoder().encode(raw).length > maxMessageBytes) return;
  let value: unknown; try { value = JSON.parse(raw); } catch { return; }
  if (!object(value)) return;
  if (value.type === 'ready' && exact(value, ['type', 'roomId', 'seat', 'expiresAt', 'gameId', 'publishedRevision', 'specSha256']) && typeof value.roomId === 'string' && roomPattern.test(value.roomId) && (value.seat === 0 || value.seat === 1) && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > 0 && publication(value)) return value as MultiplayerServerMessage;
  if (value.type === 'peer' && exact(value, ['type', 'connected']) && typeof value.connected === 'boolean') return value as MultiplayerServerMessage;
  if (value.type === 'input' && exact(value, ['type', 'seq', 'mask']) && validMultiplayerSequence(value.seq) && validMultiplayerInput(value.mask)) return value as MultiplayerServerMessage;
  if (value.type === 'state' && exact(value, ['type', 'seq', 'state']) && validMultiplayerSequence(value.seq) && validateState(value.state)) return value as MultiplayerServerMessage;
  if (value.type === 'lease' && exact(value, ['type', 'expiresAt']) && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > 0) return value as MultiplayerServerMessage;
  if (value.type === 'pong' && exact(value, ['type'])) return { type: 'pong' };
  if (value.type === 'closed' && exact(value, ['type', 'reason']) && typeof value.reason === 'string' && ['expired', 'host-disconnected', 'publication-changed', 'closed'].includes(value.reason)) return value as MultiplayerServerMessage;
  if (value.type === 'error' && exact(value, ['type', 'message']) && typeof value.message === 'string' && value.message.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.message)) return value as MultiplayerServerMessage;
}
export type MultiplayerSocket = Pick<WebSocket, 'send' | 'close' | 'readyState' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>;
export type MultiplayerConnection = { sendInput: (seq: number, mask: number) => void; sendState: (seq: number, state: unknown) => void; close: () => void };
/** Transport owns its reconnect timers; no capability is stored or appended to a URL. */
export function connectMultiplayer(room: MultiplayerRoom, options: {
  validateState: (value: unknown) => boolean;
  onStatus: (status: MultiplayerStatus, reason?: string) => void;
  onPeer: (connected: boolean) => void;
  onInput: (seq: number, mask: number) => void;
  onState: (seq: number, state: unknown) => void;
  socketFactory?: (url: string) => MultiplayerSocket;
  now?: () => number;
  reconnectWindowMs?: number;
}): MultiplayerConnection {
  const now = options.now ?? Date.now;
  let socket: MultiplayerSocket | undefined, stopped = false, ready = false, hasPeer = false, peerDelivered = false, retryStarted = 0, retries = 0, inputSeq = 0, stateSeq = 0, sentInputSeq = 0, sentStateSeq = 0, lastPong = now();
  let retry: ReturnType<typeof setTimeout> | undefined, handshake: ReturnType<typeof setTimeout> | undefined, expiration: ReturnType<typeof setTimeout> | undefined;
  let expiresAt = room.expiresAt;
  const factory = options.socketFactory ?? (url => new WebSocket(url));
  function clearHandshake() { if (handshake) clearTimeout(handshake); handshake = undefined; }
  function status(value: MultiplayerStatus, reason?: string) { options.onStatus(value, reason); }
  function peer(connected: boolean) { if (!peerDelivered || hasPeer !== connected) { hasPeer = connected; peerDelivered = true; options.onPeer(connected); } }
  function end(value: 'ended' | 'expired', reason?: string) { if (stopped) return; stopped = true; clearHandshake(); if (retry) clearTimeout(retry); clearInterval(heartbeat); clearTimeout(expiration); ready = false; peer(false); socket?.close(1000); status(value, reason); }
  function armExpiration() {
    if (expiration) clearTimeout(expiration);
    expiration = setTimeout(() => { if (now() >= expiresAt * 1000) end('expired'); else armExpiration(); }, Math.max(0, expiresAt * 1000 - now()));
  }
  function renew(value: number): boolean {
    if (!expiry(value, now())) return false;
    // Concurrent server callbacks may arrive out of order; a valid older lease
    // proves liveness but can never shorten or extend the newest accepted lease.
    if (value > expiresAt) { expiresAt = value; armExpiration(); }
    return true;
  }
  function send(value: unknown) { if (ready && !stopped && socket?.readyState === 1) { try { socket.send(JSON.stringify(value)); } catch { socket.close(1000); } } }
  function open() {
    if (stopped) return;
    if (now() >= expiresAt * 1000) { end('expired'); return; }
    ready = false; peer(false); status(retryStarted ? 'reconnecting' : 'connecting');
    let current: MultiplayerSocket;
    try { current = factory(room.socketUrl); } catch { schedule(); return; }
    socket = current;
    handshake = setTimeout(() => { if (!stopped && socket === current && !ready) current.close(1000); }, 10000);
    current.onopen = () => { if (!stopped && socket === current) current.send(JSON.stringify({ type: 'join', roomId: room.roomId, token: room.token, leaseVersion: 1 })); };
    current.onmessage = event => {
      if (stopped || socket !== current) return;
      const message = validateMultiplayerServerMessage(event.data, options.validateState); if (!message) { end('ended', 'invalid-message'); return; }
      if (message.type === 'ready') {
        if (ready || message.roomId !== room.roomId || message.seat !== room.seat || message.gameId !== room.gameId || message.publishedRevision !== room.publishedRevision || message.specSha256 !== room.specSha256 || !renew(message.expiresAt)) { end('ended', 'invalid-room'); return; }
        clearHandshake(); ready = true; retryStarted = 0; retries = 0; lastPong = now(); status('waiting'); return;
      }
      if (!ready) { end('ended', 'invalid-message'); return; }
      if (message.type === 'closed') { end(message.reason === 'expired' ? 'expired' : 'ended', message.reason); return; }
      if (message.type === 'error') { end('ended', 'rejected'); return; }
      if (message.type === 'lease') { if (!renew(message.expiresAt)) { end('ended', 'invalid-lease'); return; } lastPong = now(); return; }
      if (message.type === 'pong') { lastPong = now(); return; }
      if (message.type === 'peer') { peer(message.connected); status(message.connected ? 'connected' : 'waiting'); return; }
      if (message.type === 'input') { if (room.seat !== 0 || message.seq <= inputSeq) return; inputSeq = message.seq; options.onInput(message.seq, message.mask); }
      if (message.type === 'state') { if (room.seat !== 1 || message.seq <= stateSeq) return; stateSeq = message.seq; options.onState(message.seq, message.state); }
    };
    current.onclose = () => { if (!stopped && socket === current) { clearHandshake(); ready = false; peer(false); schedule(); } };
    current.onerror = () => { /* onclose starts the bounded reconnect. Never display a token-bearing request. */ };
  }
  function schedule() {
    if (stopped) return;
    if (!retryStarted) retryStarted = now();
    const elapsed = now() - retryStarted, budget = Math.min(45000, Math.max(0, options.reconnectWindowMs ?? 45000));
    if (elapsed >= budget) { end('ended', 'connection-lost'); return; }
    status('reconnecting'); retry = setTimeout(open, Math.min(500 * 2 ** Math.min(retries++, 3), budget - elapsed));
  }
  const heartbeat = setInterval(() => { if (!ready || stopped) return; if (now() - lastPong > 30000) { socket?.close(1000); return; } send({ type: 'ping' }); }, 10000);
  if (!expiry(expiresAt, now())) end('expired');
  else { armExpiration(); open(); }
  return {
    sendInput(seq, mask) { if (room.seat !== 1 || !hasPeer || !validMultiplayerSequence(seq) || !validMultiplayerInput(mask) || seq <= sentInputSeq) return; sentInputSeq = seq; send({ type: 'input', seq, mask }); },
    sendState(seq, state) { if (room.seat !== 0 || !hasPeer || !validMultiplayerSequence(seq) || seq <= sentStateSeq || !options.validateState(state)) return; const envelope = { type: 'state', seq, state }; if (new TextEncoder().encode(JSON.stringify(envelope)).length > maxMessageBytes) return; sentStateSeq = seq; send(envelope); },
    close() { end('ended', 'closed'); },
  };
}
export async function multiplayerRequest(apiBase: string, path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<unknown> {
  let url: URL; try { url = new URL(apiBase); } catch { throw new Error('Live multiplayer needs the connected Game Studio service.'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Live multiplayer needs a secure Game Studio service.');
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('The game room request is invalid.');
  const roomPath = /^\/multiplayer\/rooms\/([0-9a-f-]{36})(?:\/(join|lobby-join))?$/.exec(path);
  const validRoomPath = !!roomPath && roomPattern.test(roomPath[1]);
  if (method === 'GET' ? path !== '/multiplayer/lobby' || body !== undefined : body === undefined || (method === 'POST' ? path !== '/multiplayer/rooms' && !(validRoomPath && roomPath[2]) : !(validRoomPath && !roomPath[2]))) throw new Error('The game room request is invalid.');
  try {
    const response = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, { method, ...(method === 'GET' ? { cache: 'no-store' as const } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), keepalive: method === 'DELETE', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      if (response.status === 409) throw new Error('This room is full, or the published game has changed. Ask for a new invitation.');
      if ([404, 410, 401, 403].includes(response.status)) throw new Error('This invitation is unavailable or expired. Ask for a new invitation.');
      if (response.status === 429) throw new Error('Too many room requests. Wait a moment before trying again.');
      throw new Error('The live game service could not complete this request.');
    }
    return await response.json();
  } catch (error) { if (error instanceof Error && ['This ', 'Too many ', 'The live '].some(prefix => error.message.startsWith(prefix))) throw error; throw new Error('The live game service could not be reached. Please try again.'); }
}

/** The relay is an explicit installation setting, separate from the Core API. */
export function validateMultiplayerAPIConfig(value: unknown): string | undefined {
  if (!object(value) || !exact(value, ['version', 'apiUrl']) || value.version !== 1 || typeof value.apiUrl !== 'string') return;
  if (!value.apiUrl) return '';
  try { const url = new URL(value.apiUrl); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || url.href.length > 2048) return; return url.href.replace(/\/$/, ''); } catch { return; }
}
export async function loadMultiplayerAPI(localPreviewURL?: string): Promise<string> {
  if (localPreviewURL) {
    try { const url = new URL(localPreviewURL); if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash) return url.href.replace(/\/$/, ''); } catch { /* Invalid preview configuration stays disabled. */ }
    throw new Error('Local multiplayer requires a loopback relay URL.');
  }
  let config: unknown;
  try { const response = await fetch('/multiplayer-config.json', { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error(); config = await response.json(); } catch { throw new Error('Live multiplayer is not configured for this installation yet. Solo play is available.'); }
  const base = validateMultiplayerAPIConfig(config);
  if (!base) throw new Error('Live multiplayer is not configured for this installation yet. Solo play is available.');
  return base;
}
