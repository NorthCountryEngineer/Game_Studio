import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { connectMultiplayer, createMultiplayerInvitation, loadMultiplayerAPI, multiplayerRequest, parseMultiplayerInvitation, sameMultiplayerPublication, watchMultiplayerInvitations, validateMultiplayerAPIConfig, validateMultiplayerRoom, validateMultiplayerLobby, validateMultiplayerServerMessage, isTransientMultiplayerServiceError, validateMultiplayerSocketURL, type MultiplayerRoom, type MultiplayerSocket } from '../src/lib/game-multiplayer.ts';
import { setCooperativeMode, updateArcadeLevelPlan } from '../src/lib/game-multiplayer-design.ts';
import { defaultGameSpec, planGameLevels, validateGameSpec } from '../src/lib/game-design.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';

const id = '11111111-1111-4111-8111-111111111111', gameId = '22222222-2222-4222-8222-222222222222', token = 'A'.repeat(43), inviteToken = 'B'.repeat(43), now = 1793102400000;
const publication = { gameId, publishedRevision: 1, specSha256: 'c'.repeat(64) };
const room: MultiplayerRoom = { ...publication, roomId: id, token, expiresAt: Math.floor(now / 1000) + 1800, socketUrl: 'wss://relay.execute-api.us-east-1.amazonaws.com/production', seat: 0 };
const activeState = (paused = false) => ({ tick: 1, running: !paused, paused, outcome: 'playing' });
const strictState = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { tick?: unknown }).tick !== 1) return false;
  const state = value as Record<string, unknown>;
  return Object.keys(state).length === 1 || (Object.keys(state).length === 4 && typeof state.running === 'boolean' && typeof state.paused === 'boolean' && state.outcome === 'playing');
};
class FakeSocket implements MultiplayerSocket {
  readyState = 0;
  onopen: WebSocket['onopen'] = null; onmessage: WebSocket['onmessage'] = null; onclose: WebSocket['onclose'] = null; onerror: WebSocket['onerror'] = null;
  sent: unknown[] = []; closes = 0; onSend?: (value: Record<string, unknown>) => void;
  constructor(readonly url: string) {}
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) { const parsed = JSON.parse(String(value)); this.sent.push(parsed); this.onSend?.(parsed); }
  close() { this.readyState = 3; this.closes++; }
  open() { this.readyState = 1; this.onopen?.call(this as unknown as WebSocket, {} as Event); }
  message(value: unknown) { this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent); }
  disconnect() { this.readyState = 3; this.onclose?.call(this as unknown as WebSocket, {} as CloseEvent); }
}
function connection(seat: 0 | 1 = 0, reconnectWindowMs = 45000, clock = () => now) {
  const sockets: FakeSocket[] = [], statuses: string[] = [], peers: boolean[] = [], inputs: unknown[] = [], inputEdges: number[] = [], states: unknown[] = [];
  const client = connectMultiplayer({ ...room, seat }, { now: clock, reconnectWindowMs, validateState: strictState, onStatus: (status, reason) => statuses.push(reason ? `${status}:${reason}` : status), onPeer: peer => peers.push(peer), onInput: (seq, mask, pressedMask) => { inputs.push({ seq, mask }); inputEdges.push(pressedMask ?? 0); }, onState: (seq, state) => states.push({ seq, state }), socketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; } });
  const socket = sockets[0];
  const ready = () => { socket.open(); socket.message({ type: 'ready', ...publication, roomId: id, seat, expiresAt: room.expiresAt }); socket.message({ type: 'peer', connected: true }); };
  return { client, socket, sockets, statuses, peers, inputs, inputEdges, states, ready };
}
function advance(t: TestContext, milliseconds: number) { for (let elapsed = 0; elapsed < milliseconds; elapsed += 10) t.mock.timers.tick(Math.min(10, milliseconds - elapsed)); }

test('cooperative authoring is optional and preserves every authored level, seed and rule when toggled or reordered', () => {
  const original = planGameLevels(defaultGameSpec(), 3, 'multiplayer edit preservation');
  original.levels![1].title = 'My middle chapter'; original.levels![1].rules.goal = 7;
  const encoded = JSON.stringify(original), enabled = setCooperativeMode(original, true);
  assert.equal(enabled.version, 4); assert.deepEqual(enabled.multiplayer, { mode: 'cooperative', maxPlayers: 2 });
  assert.deepEqual(enabled.levels, original.levels); assert.equal(JSON.stringify(original), encoded); validateGameSpec(enabled);
  const reordered = updateArcadeLevelPlan(enabled, [...enabled.levels!].reverse(), 'Keep both friendly players.');
  assert.equal(reordered.version, 4); assert.deepEqual(reordered.multiplayer, enabled.multiplayer); assert.equal(reordered.levels![0].seed, original.levels![2].seed);
  const disabled = setCooperativeMode(reordered, false);
  assert.equal(disabled.version, 2); assert.equal(Object.hasOwn(disabled, 'multiplayer'), false); assert.deepEqual(disabled.levels, reordered.levels); validateGameSpec(disabled);
  const fromV1 = setCooperativeMode(defaultGameSpec(), true); assert.equal(fromV1.levels?.length, 1); assert.equal(fromV1.levels?.[0].id, 'level-1'); validateGameSpec(fromV1);
  assert.throws(() => setCooperativeMode(defaultWordGameSpec('crossword'), true));
});

test('invitation capabilities stay in a fragment and bind the exact game and installation', () => {
  const url = createMultiplayerInvitation('https://games.example', gameId, { roomId: id, inviteToken });
  assert.equal(new URL(url).search, ''); assert.equal(new URL(url).hash, `#coop=${id}.${inviteToken}`);
  const expected = { roomId: id, inviteToken };
  assert.deepEqual(parseMultiplayerInvitation(url, 'https://games.example', gameId), expected);
  assert.deepEqual(parseMultiplayerInvitation(new URL(url).hash, 'https://games.example', gameId), expected);
  for (const invalid of [url.replace('games.example', 'evil.example'), url.replace(gameId, id), url.replace('#coop=', '?token=secret#coop='), `${url}.extra`, `#coop=${id}.${token.slice(1)}`, `#coop=${id}.<script>`, 'javascript:alert(1)', `#coop=${id.replace(/^1/, 'A')}.${inviteToken}`]) assert.equal(parseMultiplayerInvitation(invalid, 'https://games.example', gameId), undefined);
});

test('room responses require exact roles, bounded expiry and secure token-free socket addresses', () => {
  const hosted = { ...publication, roomId: id, hostToken: token, inviteToken, expiresAt: room.expiresAt, socketUrl: room.socketUrl };
  assert.deepEqual(validateMultiplayerRoom(hosted, 0, false, now), room);
  assert.equal(sameMultiplayerPublication(room, { game_id: gameId, published_revision: 1, spec_sha256: publication.specSha256 }), true);
  assert.equal(sameMultiplayerPublication(room, { game_id: id, published_revision: 1, spec_sha256: publication.specSha256 }), false);
  assert.equal(validateMultiplayerRoom({ ...publication, roomId: id, guestToken: token, expiresAt: room.expiresAt, socketUrl: room.socketUrl }, 1, false, now)?.seat, 1);
  for (const invalid of [{ ...hosted, seat: 1 }, { ...hosted, guestToken: token }, { ...hosted, hostToken: token.slice(1) }, { ...hosted, expiresAt: now / 1000 }, { ...hosted, expiresAt: now / 1000 + 3601 }, { ...hosted, socketUrl: `${room.socketUrl}?token=${token}` }, { ...hosted, socketUrl: 'ws://relay.example/' }]) assert.equal(validateMultiplayerRoom(invalid, 0, false, now), undefined);
  for (const invalid of ['https://relay.example/', 'wss://user:pass@relay.example/', 'wss://relay.example/#secret', 'ws://127.0.0.1:9999/']) assert.equal(validateMultiplayerSocketURL(invalid), undefined);
  assert.equal(validateMultiplayerSocketURL('ws://127.0.0.1:9999/live', true), 'ws://127.0.0.1:9999/live');
  assert.equal(validateMultiplayerSocketURL('ws://evil.example/live', true), undefined);
});

test('wire protocol rejects extra fields, executable/text payloads, oversized snapshots and invalid controls', () => {
  const valid = [{ type: 'input', seq: 1, mask: 63 }, { type: 'state', seq: 1, state: { tick: 1 } }, { type: 'peer', connected: false }, { type: 'pong' }, { type: 'lease', expiresAt: room.expiresAt }, { type: 'closed', reason: 'publication-changed' }];
  for (const value of valid) assert.deepEqual(validateMultiplayerServerMessage(JSON.stringify(value), strictState), value);
  const invalid = [{ type: 'input', seq: 0, mask: 1 }, { type: 'input', seq: 1, mask: 64 }, { type: 'input', seq: 1.2, mask: 1 }, { type: 'input', seq: 1, mask: 1, studentName: 'Private' }, { type: 'state', seq: 1, state: { tick: 1, script: 'anything' } }, { type: 'state', seq: 1, state: { tick: 1, data: 'x'.repeat(30000) } }, { type: 'pong', token }, { type: 'lease', expiresAt: room.expiresAt, token }, { type: 'lease', expiresAt: true }, { type: 'lease', expiresAt: 1.2 }, { type: 'closed', reason: '<script>' }, { type: 'closed', reason: ['expired'] }, { type: 'peer', connected: 'true' }];
  for (const value of invalid) assert.equal(validateMultiplayerServerMessage(JSON.stringify(value), strictState), undefined);
  for (const value of [null, '[]', '{}', 'invalid json']) assert.equal(validateMultiplayerServerMessage(value, strictState), undefined);
});

test('the relay is explicitly configured independently of the Core API', () => {
  assert.equal(validateMultiplayerAPIConfig({ version: 1, apiUrl: '' }), '');
  assert.equal(validateMultiplayerAPIConfig({ version: 1, apiUrl: 'https://relay.example/' }), 'https://relay.example');
  for (const value of [{ version: 2, apiUrl: 'https://relay.example/' }, { version: 1, apiUrl: 'http://relay.example/' }, { version: 1, apiUrl: 'https://relay.example/?token=private' }, { version: 1, apiUrl: 'https://user:pass@relay.example/' }, { version: 1, apiUrl: 'https://relay.example/', coreToken: token }, []]) assert.equal(validateMultiplayerAPIConfig(value), undefined);
});

test('host authenticates in the first body and accepts only monotonic guest controls', () => {
  const t = connection();
  try {
    t.ready(); assert.equal(t.socket.url.includes(token), false); assert.deepEqual(t.socket.sent[0], { type: 'join', roomId: id, token, leaseVersion: 1, flowVersion: 3 });
    assert.equal(t.statuses.at(-1), 'connected');
    const beforeHeartbeat = t.peers.length; t.socket.message({ type: 'peer', connected: true }); assert.equal(t.peers.length, beforeHeartbeat, 'heartbeat must not clear held controls');
    t.socket.message({ type: 'input', seq: 2, mask: 32 }); t.socket.message({ type: 'input', seq: 1, mask: 1 }); t.socket.message({ type: 'input', seq: 2, mask: 2 });
    assert.deepEqual(t.inputs, [{ seq: 2, mask: 32 }]);
    t.client.sendInput(1, 3); assert.equal(t.socket.sent.length, 1);
    t.client.sendState(1, { tick: 1 }); t.client.sendState(1, { tick: 1 }); t.client.sendState(2, { tick: 1, unknown: true });
    assert.deepEqual(t.socket.sent[1], { type: 'state', seq: 1, state: { tick: 1 } }); assert.equal(t.socket.sent.length, 2);
    t.socket.message({ type: 'peer', connected: false }); t.client.sendState(3, { tick: 1 }); assert.equal(t.socket.sent.length, 2); assert.equal(t.statuses.at(-1), 'waiting');
  } finally { t.client.close(); }
});

test('guest sends only bounded controls and renders only monotonic validated host snapshots', () => {
  const t = connection(1);
  try {
    t.ready(); t.client.sendState(1, { tick: 1 }); t.client.sendInput(1, 63); t.client.sendInput(1, 1); t.client.sendInput(2, 64);
    assert.deepEqual(t.socket.sent.slice(1), [{ type: 'input', seq: 1, mask: 63, history: [{ seq: 1, mask: 63 }] }]);
    t.socket.message({ type: 'state', seq: 5, state: { tick: 1 } }); t.socket.message({ type: 'state', seq: 4, state: { tick: 1 } });
    assert.deepEqual(t.states, [{ seq: 5, state: { tick: 1 } }]);
    t.socket.message({ type: 'state', seq: 6, state: { tick: 1, private: 'no' } });
    assert.equal(t.statuses.at(-1), 'ended:invalid-message'); assert.equal(t.peers.at(-1), false);
  } finally { t.client.close(); }
});

test('wrong seats and stale editions close without leaking server text or silently changing games', () => {
  const t = connection();
  try { t.socket.open(); t.socket.message({ type: 'ready', ...publication, roomId: id, seat: 1, expiresAt: room.expiresAt }); assert.equal(t.statuses.at(-1), 'ended:invalid-room'); }
  finally { t.client.close(); }
  const edition = connection();
  try { edition.ready(); edition.socket.message({ type: 'closed', reason: 'publication-changed' }); assert.equal(edition.statuses.at(-1), 'ended:publication-changed'); assert.equal(edition.sockets.length, 1); }
  finally { edition.client.close(); }
});

test('disconnects clear peer controls and obey the reconnect budget; explicit leave never reconnects', () => {
  const t = connection(0, 0);
  t.ready(); t.socket.disconnect(); assert.equal(t.peers.at(-1), false); assert.equal(t.statuses.at(-1), 'ended:connection-lost'); assert.equal(t.sockets.length, 1); t.client.close();
  const leaving = connection(); leaving.ready(); leaving.client.close(); leaving.socket.disconnect(); assert.equal(leaving.statuses.at(-1), 'ended:closed'); assert.equal(leaving.sockets.length, 1);
});


test('a ready handshake cannot change the admitted game, edition or definition', () => {
  for (const changed of [{ gameId: id }, { publishedRevision: 2 }, { specSha256: 'd'.repeat(64) }]) {
    const t = connection();
    try { t.socket.open(); t.socket.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt: room.expiresAt, ...changed }); assert.equal(t.statuses.at(-1), 'ended:invalid-room'); assert.equal(t.inputs.length, 0); assert.equal(t.states.length, 0); }
    finally { t.client.close(); }
  }
});

test('room HTTP capabilities are in bounded request bodies with no identity or browser credentials', async () => {
  const original = globalThis.fetch; const requests: { url: string; options: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url, options) => { requests.push({ url: String(url), options: options! }); return new Response(JSON.stringify({ closed: true }), { status: 200 }); }) as typeof fetch;
    await multiplayerRequest('https://relay.example', `/multiplayer/rooms/${id}`, 'DELETE', { hostToken: token });
    const request = requests[0]; assert.equal(request.url, `https://relay.example/multiplayer/rooms/${id}`); assert.equal(request.url.includes(token), false);
    assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.referrerPolicy, 'no-referrer'); assert.equal(request.options.keepalive, true);
    assert.deepEqual(request.options.headers, { 'Content-Type': 'application/json' }); assert.deepEqual(JSON.parse(String(request.options.body)), { hostToken: token });
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: `private:${token}` }), { status: 403 })) as typeof fetch;
    await assert.rejects(() => multiplayerRequest('https://relay.example', '/multiplayer/rooms', 'POST', {}), error => error instanceof Error && !error.message.includes(token) && error.message.includes('unavailable'));
    await assert.rejects(() => multiplayerRequest('http://external.example', '/multiplayer/rooms', 'POST', {}));
  } finally { globalThis.fetch = original; }
});

test('configuration loads only its same-origin public file and missing settings never fall back to Core', async () => {
  const original = globalThis.fetch; const requests: string[] = [];
  try {
    globalThis.fetch = (async (url, options) => { requests.push(String(url)); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error'); return new Response(JSON.stringify({ version: 1, apiUrl: '' }), { status: 200 }); }) as typeof fetch;
    await assert.rejects(() => loadMultiplayerAPI(), /not configured/); assert.deepEqual(requests, ['/multiplayer-config.json']);
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: 1, apiUrl: 'https://relay.example/' }), { status: 200 })) as typeof fetch;
    assert.equal(await loadMultiplayerAPI(), 'https://relay.example');
    assert.equal(await loadMultiplayerAPI('http://127.0.0.1:8097'), 'http://127.0.0.1:8097');
    await assert.rejects(() => loadMultiplayerAPI('https://external.example'), /loopback/);
  } finally { globalThis.fetch = original; }
});


test('reconnect reuses the in-memory seat and capability, preserving sequence ordering', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(1, 45000, () => Date.now());
  try {
    c.ready(); c.socket.message({ type: 'state', seq: 5, state: { tick: 1 } }); c.socket.disconnect();
    assert.equal(c.statuses.at(-1), 'reconnecting'); t.mock.timers.tick(500); assert.equal(c.sockets.length, 2);
    const resumed = c.sockets[1]; resumed.open(); assert.deepEqual(resumed.sent[0], { type: 'join', roomId: id, token, leaseVersion: 1, flowVersion: 3 }); assert.equal(resumed.url.includes(token), false);
    resumed.message({ type: 'ready', ...publication, roomId: id, seat: 1, expiresAt: room.expiresAt }); resumed.message({ type: 'peer', connected: true });
    resumed.message({ type: 'state', seq: 4, state: { tick: 1 } }); resumed.message({ type: 'state', seq: 6, state: { tick: 1 } });
    assert.deepEqual(c.states, [{ seq: 5, state: { tick: 1 } }, { seq: 6, state: { tick: 1 } }]);
    assert.equal(c.statuses.at(-1), 'connected');
  } finally { c.client.close(); }
});

test('repeated transport failures stop at the hard 45-second reconnect ceiling', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  let attempts = 0; const statuses: string[] = [];
  const c = connectMultiplayer(room, { now: () => Date.now(), reconnectWindowMs: 999999, socketFactory: () => { attempts++; throw new Error('synthetic unavailable relay'); }, validateState: strictState, onStatus: (status, reason) => statuses.push(reason ? `${status}:${reason}` : status), onPeer: () => {}, onInput: () => {}, onState: () => {} });
  try {
    for (let tick = 0; tick < 90; tick++) t.mock.timers.tick(500);
    assert.equal(Date.now() - now, 45000); assert.equal(statuses.at(-1), 'ended:connection-lost');
    assert.ok(attempts > 1 && attempts < 20); const stopped = attempts; t.mock.timers.tick(60000); assert.equal(attempts, stopped);
  } finally { c.close(); }
});


test('same-page invitation navigation is consumed before joining, including invalid and currently blocked invitations', () => {
  const events = new Map<string, () => void>(), calls: string[] = [];
  const location = { pathname: `/games/${gameId}`, search: '?view=practice', hash: '' };
  let roomActive = false, requestPending = false;
  const surface = { location, history: { state: { route: 'saved' }, replaceState(state: unknown, title: string, path?: string | URL | null) {
    assert.deepEqual(state, { route: 'saved' }); assert.equal(title, ''); assert.equal(path, `/games/${gameId}?view=practice`);
    calls.push('cleared'); location.hash = '';
  } }, addEventListener(type: 'hashchange', callback: () => void) { events.set(type, callback); }, removeEventListener(type: 'hashchange', callback: () => void) { if (events.get(type) === callback) events.delete(type); } };
  const stop = watchMultiplayerInvitations(surface, fragment => {
    assert.equal(location.hash, '', 'capability must be absent before any join or rejection');
    if (roomActive || requestPending) { calls.push('blocked'); return; }
    const parsed = parseMultiplayerInvitation(fragment, 'https://games.example', gameId); calls.push(parsed ? 'join' : 'invalid');
  });
  assert.deepEqual(calls, []);
  location.hash = `#coop=${id}.${inviteToken}`; events.get('hashchange')!(); assert.deepEqual(calls, ['cleared', 'join']);
  roomActive = true; location.hash = `#coop=${id}.${inviteToken}`; events.get('hashchange')!(); assert.deepEqual(calls.slice(-2), ['cleared', 'blocked']);
  roomActive = false; requestPending = true; location.hash = `#coop=${id}.${inviteToken}`; events.get('hashchange')!(); assert.deepEqual(calls.slice(-2), ['cleared', 'blocked']);
  requestPending = false; location.hash = '#coop=invalid'; events.get('hashchange')!(); assert.deepEqual(calls.slice(-2), ['cleared', 'invalid']);
  location.hash = '#how-to-play'; const before = calls.length; events.get('hashchange')!(); assert.equal(calls.length, before); assert.equal(location.hash, '#how-to-play');
  stop(); assert.equal(events.size, 0);
});

test('an invitation already present on initial page load is cleared and delivered exactly once', () => {
  const events = new Map<string, () => void>(), delivered: string[] = [];
  const location = { pathname: `/games/${gameId}`, search: '', hash: `#coop=${id}.${inviteToken}` };
  const fragment = location.hash;
  const surface = { location, history: { state: null, replaceState() { location.hash = ''; } }, addEventListener(type: 'hashchange', callback: () => void) { events.set(type, callback); }, removeEventListener(type: 'hashchange') { events.delete(type); } };
  const stop = watchMultiplayerInvitations(surface, value => { assert.equal(location.hash, ''); delivered.push(value); });
  events.get('hashchange')!(); assert.deepEqual(delivered, [fragment]); stop();
});


test('authoritative rolling leases keep the same room connected for two hours and through reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(1, 45000, () => Date.now());
  const renewOnPing = (socket: FakeSocket) => {
    socket.onSend = value => { if (value.type === 'ping') { socket.message({ type: 'lease', expiresAt: Math.floor(Date.now() / 1000) + 1800 }); socket.message({ type: 'pong' }); } };
  };
  try {
    c.ready(); renewOnPing(c.socket);
    for (let tick = 0; tick < 720; tick++) t.mock.timers.tick(10000);
    assert.equal(Date.now() - now, 7200000); assert.ok(Date.now() > room.expiresAt * 1000);
    assert.equal(c.statuses.at(-1), 'connected'); assert.equal(c.socket.closes, 0);
    assert.equal(c.sockets.length, 1); assert.ok(c.socket.sent.filter((value: any) => value.type === 'ping').length >= 720);
    c.socket.message({ type: 'state', seq: 10, state: { tick: 1 } });
    c.socket.disconnect(); t.mock.timers.tick(500);
    assert.equal(c.sockets.length, 2);
    const resumed = c.sockets[1]; resumed.open();
    assert.deepEqual(resumed.sent[0], { type: 'join', roomId: id, token, leaseVersion: 1, flowVersion: 3 });
    // A ready message can reflect a slightly earlier admitted lease without rolling back the timer.
    resumed.message({ type: 'ready', ...publication, roomId: id, seat: 1, expiresAt: Math.floor(Date.now() / 1000) + 1790 });
    resumed.message({ type: 'lease', expiresAt: Math.floor(Date.now() / 1000) + 1800 });
    resumed.message({ type: 'peer', connected: true }); renewOnPing(resumed);
    c.socket.message({ type: 'lease', expiresAt: Math.floor(Date.now() / 1000) + 90000 });
    c.socket.message({ type: 'closed', reason: 'expired' });
    resumed.message({ type: 'state', seq: 9, state: { tick: 1 } }); resumed.message({ type: 'state', seq: 11, state: { tick: 1 } });
    assert.deepEqual(c.states, [{ seq: 10, state: { tick: 1 } }, { seq: 11, state: { tick: 1 } }]);
    assert.equal(c.statuses.at(-1), 'connected');
    for (let tick = 0; tick < 181; tick++) t.mock.timers.tick(10000);
    assert.equal(c.statuses.at(-1), 'connected'); assert.equal(resumed.closes, 0);
    assert.equal(room.expiresAt, Math.floor(now / 1000) + 1800, 'the caller descriptor remains immutable');
  } finally { c.client.close(); }
});

test('ready can extend the descriptor and valid out-of-order leases never lower its deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.socket.open(); c.socket.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt: room.expiresAt + 30 });
    assert.equal(c.statuses.at(-1), 'waiting');
    c.socket.message({ type: 'lease', expiresAt: room.expiresAt + 30 }); assert.equal(c.statuses.at(-1), 'waiting', 'equal lease is valid');
    c.socket.message({ type: 'lease', expiresAt: room.expiresAt + 29 });
    assert.equal(c.statuses.at(-1), 'waiting'); assert.equal(c.socket.closes, 0, 'an older bounded callback is harmless');
  } finally { c.client.close(); }
  for (const invalid of [Math.floor(now / 1000), Math.floor(now / 1000) - 1, Math.floor(now / 1000) + 1861, Infinity, true, '1800', 1.2]) {
    const c = connection(0, 45000, () => Date.now());
    try { c.ready(); c.socket.message({ type: 'lease', expiresAt: invalid }); assert.match(c.statuses.at(-1)!, /^ended:invalid-(?:lease|message)$/); assert.equal(c.socket.closes, 1); }
    finally { c.client.close(); }
  }
  const pending = connection();
  try { pending.socket.open(); pending.socket.message({ type: 'lease', expiresAt: room.expiresAt }); assert.equal(pending.statuses.at(-1), 'ended:invalid-message'); }
  finally { pending.client.close(); }
  for (const expiresAt of [Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 1861]) {
    const c = connection(0, 45000, () => Date.now());
    try { c.socket.open(); c.socket.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt }); assert.equal(c.statuses.at(-1), 'ended:invalid-room'); }
    finally { c.client.close(); }
  }
});

test('only a lease can renew expiry; pongs and stale ready cannot silently prolong it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.ready(); c.socket.onSend = value => { if (value.type === 'ping') c.socket.message({ type: 'pong' }); };
    for (let tick = 0; tick < 180; tick++) t.mock.timers.tick(10000);
    assert.equal(c.statuses.at(-1), 'expired'); assert.equal(c.socket.closes, 1);
    c.socket.message({ type: 'lease', expiresAt: Math.floor(Date.now() / 1000) + 1800 });
    assert.equal(c.statuses.at(-1), 'expired');
  } finally { c.client.close(); }
});

test('public lobby responses are bounded exact publication bindings without capabilities', () => {
  const listing = { ...publication, roomId: id, title: 'Space friends', expiresAt: room.expiresAt };
  assert.deepEqual(validateMultiplayerLobby({ rooms: [listing] }, now), [listing]);
  assert.equal(sameMultiplayerPublication(listing, { game_id: gameId, published_revision: 1, spec_sha256: publication.specSha256 }), true);
  assert.deepEqual(validateMultiplayerLobby({ rooms: [] }, now), []);
  for (const invalid of [null, [], { rooms: [], token }, { rooms: 'none' }, { rooms: Array(21).fill(listing) }, { rooms: [listing, listing] },
    ...[{ token }, { inviteToken }, { hostToken: token }, { guestToken: token }, { roomId: 'not-a-uuid' }, { gameId: id.toUpperCase().replace('1', 'A') }, { publishedRevision: 0 }, { specSha256: 'g'.repeat(64) }, { expiresAt: Math.floor(now / 1000) }, { expiresAt: Math.floor(now / 1000) + 1861 }, { title: ' private ' }, { title: '<script>' }, { title: 'x'.repeat(81) }, { title: 'Hidden\u0000title' }].map(change => ({ rooms: [{ ...listing, ...change }] }))]) assert.equal(validateMultiplayerLobby(invalid, now), undefined);
  const mutable = { rooms: [structuredClone(listing)] }, copy = validateMultiplayerLobby(mutable, now)!;
  mutable.rooms[0].title = 'Changed'; assert.equal(copy[0].title, 'Space friends');
});

test('public lobby discovery uses GET without credentials, body, tokens or JSON preflight headers', async () => {
  const original = globalThis.fetch, requests: { url: string; options: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url, options) => { requests.push({ url: String(url), options: options! }); return new Response(JSON.stringify({ rooms: [] }), { status: 200 }); }) as typeof fetch;
    await multiplayerRequest('https://relay.example', '/multiplayer/lobby', 'GET');
    assert.deepEqual(requests[0].url, 'https://relay.example/multiplayer/lobby');
    const options = requests[0].options;
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(Object.hasOwn(options, 'body'), false); assert.equal(Object.hasOwn(options, 'headers'), false);
    const binding = { ...publication };
    await multiplayerRequest('https://relay.example', `/multiplayer/rooms/${id}/lobby-join`, 'POST', binding);
    assert.deepEqual(JSON.parse(String(requests[1].options.body)), binding); assert.equal(requests[1].url.includes(token), false);
    for (const [path, method, body] of [
      ['/multiplayer/lobby', 'GET', { token }], ['/multiplayer/lobby?token=secret', 'GET', undefined],
      ['/multiplayer/lobby', 'POST', {}], [`/multiplayer/rooms/${id}`, 'GET', undefined],
      [`/multiplayer/rooms/${id}/lobby-join`, 'DELETE', {}], ['/multiplayer/rooms/not-a-uuid/lobby-join', 'POST', {}],
    ] as const) await assert.rejects(() => multiplayerRequest('https://relay.example', path, method, body));
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = original; }
});


test('a stale reconnect ready preserves the newer accepted lease without admitting a changed binding', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.ready(); t.mock.timers.tick(10000);
    c.socket.message({ type: 'lease', expiresAt: room.expiresAt + 10 });
    c.socket.message({ type: 'lease', expiresAt: room.expiresAt });
    assert.equal(c.statuses.at(-1), 'connected', 'an out-of-order earlier callback does not disconnect the room');
    c.socket.disconnect(); t.mock.timers.tick(500);
    const resumed = c.sockets[1]; resumed.open();
    resumed.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt: room.expiresAt });
    resumed.message({ type: 'peer', connected: true });
    resumed.onSend = value => { if (value.type === 'ping') resumed.message({ type: 'pong' }); };
    for (let tick = 0; tick < 179; tick++) t.mock.timers.tick(10000);
    assert.equal(Date.now() - now, 1800500);
    assert.equal(c.statuses.at(-1), 'connected', 'the descriptor/ready deadline cannot replace an accepted newer lease');
    t.mock.timers.tick(9500); assert.equal(c.statuses.at(-1), 'expired', 'pongs cannot further extend the newest lease');
  } finally { c.client.close(); }
});

test('flow control starts at one, bounds the host at three and retains superseded capacity without trusting bogus ACKs', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.ready();
    c.client.sendState(1, activeState()); advance(t, 50); c.client.sendState(2, activeState());
    assert.equal(c.socket.sent.length, 2, 'cold admission permits only one data request');
    for (const invalid of [{ type: 'ack', kind: 'input', seq: 1 }, { type: 'ack', kind: 'state', seq: 999 }]) c.socket.message(invalid);
    assert.equal(c.socket.sent.length, 2, 'an unrelated ACK cannot free or grow the window');
    advance(t, 50); c.socket.message({ type: 'ack', kind: 'state', seq: 1 });
    advance(t, 50); c.client.sendState(3, activeState());
    advance(t, 50); c.client.sendState(4, activeState());
    assert.equal(c.socket.sent.length, 4, 'a timely busy ACK expands to two');
    advance(t, 50); c.socket.message({ type: 'ack', kind: 'state', seq: 3 });
    advance(t, 50); c.client.sendState(5, activeState());
    advance(t, 50);
    const snapshot = activeState();
    for (let seq = 6; seq <= 1000; seq++) c.client.sendState(seq, snapshot);
    snapshot.paused = true;
    assert.equal(c.socket.sent.length, 6, 'host has three credits: seq2, seq4 and seq5');
    c.socket.message({ type: 'ack', kind: 'state', seq: 3 });
    assert.equal(c.socket.sent.length, 6, 'a duplicate cumulative ACK cannot free retained capacity');
    c.socket.message({ type: 'ack', kind: 'state', seq: 5 });
    assert.deepEqual(c.socket.sent.at(-1), { type: 'state', seq: 1000, state: activeState() }, 'only the newest immutable snapshot replaces the exact acknowledged credit');
    advance(t, 50); c.client.sendState(1001, activeState());
    assert.equal(c.socket.sent.length, 7, 'older superseded requests still occupy both other slots');
    c.socket.message({ type: 'ack', kind: 'state', seq: 2 });
    assert.deepEqual(c.socket.sent.at(-1), { type: 'state', seq: 1001, state: activeState() }, 'an older exact ACK releases its retained capacity');
  } finally { c.client.close(); }
});

test('guest controls retain bounded recent transitions while paced coalescing and synchronous ACKs stay safe', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(1, 45000, () => Date.now());
  try {
    c.ready(); c.client.sendInput(1, 1);
    for (let seq = 2; seq <= 1000; seq++) c.client.sendInput(seq, seq === 1000 ? 0 : 32);
    assert.deepEqual(c.socket.sent.slice(1), [{ type: 'input', seq: 1, mask: 1, history: [{ seq: 1, mask: 1 }] }]);
    c.socket.message({ type: 'ack', kind: 'input', seq: 1 });
    assert.equal(c.socket.sent.length, 2, 'ACK does not bypass send pacing');
    t.mock.timers.tick(40);
    assert.deepEqual(c.socket.sent.at(-1), { type: 'input', seq: 1000, mask: 0, history: [{ seq: 1, mask: 1 }, { seq: 2, mask: 32 }, { seq: 1000, mask: 0 }] });
    c.socket.message({ type: 'ack', kind: 'input', seq: 1000 });
    c.socket.onSend = value => { if (value.type === 'input') c.socket.message({ type: 'ack', kind: 'input', seq: value.seq }); };
    t.mock.timers.tick(40); c.client.sendInput(1001, 4); c.client.sendInput(1002, 0); t.mock.timers.tick(40);
    const sent = c.socket.sent.slice(-2) as { seq: number; mask: number; history: unknown[] }[];
    assert.deepEqual(sent.map(({ seq, mask }) => ({ seq, mask })), [{ seq: 1001, mask: 4 }, { seq: 1002, mask: 0 }]);
    assert.ok(sent.every(packet => packet.history.length <= 8));
  } finally { c.client.close(); }
});

test('400 ms ACK latency sustains 7.5 Hz after slow start with at most three actual host handlers', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const host = connection(0, 45000, () => Date.now()), sentAt: number[] = [], outstanding = new Set<number>();
  let maximumOutstanding = 0;
  try {
    host.ready();
    host.socket.onSend = packet => {
      if (packet.type !== 'state') return;
      sentAt.push(Date.now() - now); outstanding.add(packet.seq as number);
      maximumOutstanding = Math.max(maximumOutstanding, outstanding.size);
      setTimeout(() => { outstanding.delete(packet.seq as number); host.socket.message({ type: 'ack', kind: 'state', seq: packet.seq }); }, 400);
    };
    for (let seq = 1; seq <= 100; seq++) { host.client.sendState(seq, activeState()); advance(t, 100); }
    assert.equal(sentAt.filter(time => time >= 2000 && time < 10000).length, 60, '60 snapshots over eight steady seconds, versus 20 with stop-and-wait');
    assert.equal(maximumOutstanding, 3);
    assert.equal(host.sockets.length, 1); assert.equal(host.statuses.at(-1), 'connected');
  } finally { host.client.close(); }
});

test('180 ms warm ACKs preserve 10 Hz snapshots and paused or zero-input traffic cannot grow a window', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const host = connection(0, 45000, () => Date.now()), idleHost = connection(0, 45000, () => Date.now()), idleGuest = connection(1, 45000, () => Date.now());
  const times: number[][] = [[], [], []], outstanding = [0, 0, 0], maximum = [0, 0, 0];
  try {
    for (const [index, client] of [host, idleHost, idleGuest].entries()) {
      client.ready();
      client.socket.onSend = packet => {
        if (packet.type !== 'state' && packet.type !== 'input') return;
        times[index].push(Date.now() - now); maximum[index] = Math.max(maximum[index], ++outstanding[index]);
        setTimeout(() => { outstanding[index]--; client.socket.message({ type: 'ack', kind: packet.type, seq: packet.seq }); }, index ? 400 : 180);
      };
    }
    for (let seq = 1; seq <= 40; seq++) {
      host.client.sendState(seq, activeState()); idleHost.client.sendState(seq, activeState(true)); idleGuest.client.sendInput(seq, 0); advance(t, 100);
    }
    assert.equal(times[0].filter(time => time >= 1000 && time < 4000).length, 30, 'healthy warm gameplay retains its 10 Hz production rate');
    assert.deepEqual(maximum.slice(1), [1, 1], 'idle packets receive ACKs and have queued updates, but never expand');
    assert.deepEqual(times[1], Array.from({ length: 11 }, (_, index) => index * 400));
    assert.deepEqual(times[2], times[1]);
  } finally { host.client.close(); idleHost.client.close(); idleGuest.client.close(); }
});

test('four-second cold ACKs and out-of-order physical handler tails fit the ten-slot account fixture', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const clients = [connection(0, 45000, () => Date.now()), connection(1, 45000, () => Date.now())];
  const active = new Map<string, number>(), sent = [0, 0], maximumData = [0, 0];
  let maximumAccount = 0, maximumPings = 0, hostTail = false, guestTail = false;
  // Three independent background/control handlers reserve explicit headroom.
  const accountCount = () => active.size + 3;
  try {
    for (const [seat, client] of clients.entries()) {
      client.ready();
      client.socket.onSend = packet => {
        if (!['state', 'input', 'ping'].includes(String(packet.type))) return;
        const kind = String(packet.type), isData = kind !== 'ping';
        const key = `${seat}:${kind}:${packet.seq ?? Date.now()}`;
        active.set(key, seat);
        if (isData) sent[seat]++;
        for (const index of [0, 1]) maximumData[index] = Math.max(maximumData[index], [...active.keys()].filter(value => value.startsWith(`${index}:`) && !value.includes(':ping:')).length);
        maximumPings = Math.max(maximumPings, [...active.keys()].filter(value => value.includes(':ping:')).length);
        maximumAccount = Math.max(maximumAccount, accountCount());
        let duration = isData && sent[seat] === 1 ? 4000 : kind === 'ping' ? 4000 : 180;
        // A newer ACK arrives while these older Lambda handlers keep running.
        if (isData && Date.now() - now >= 9000 && !(seat === 0 ? hostTail : guestTail)) {
          if (seat === 0) hostTail = true; else guestTail = true;
          duration = 8000;
        }
        setTimeout(() => {
          active.delete(key);
          client.socket.message(kind === 'ping' ? { type: 'pong' } : { type: 'ack', kind, seq: packet.seq });
        }, duration);
      };
    }
    for (let seq = 1; seq <= 200; seq++) {
      clients[0].client.sendState(seq, activeState()); clients[1].client.sendInput(seq, 32);
      if (seq === 40) {
        assert.deepEqual(sent, [1, 1], 'each cold seat has one outstanding call before its first ACK');
        assert.equal(active.size, 2);
      }
      if (seq === 42) assert.deepEqual(sent, [2, 2], 'a four-second ACK does not expand either window');
      advance(t, 100);
    }
    assert.deepEqual(maximumData, [3, 2], 'capacity counts actual handlers until completion, including superseded tails');
    assert.equal(maximumPings, 2, 'both real heartbeat handlers overlap the running game');
    assert.equal(maximumAccount, 10, 'five data handlers, two pings and three unrelated/control handlers fit the fixture');
    assert.equal(hostTail && guestTail, true);
    for (const client of clients) { assert.equal(client.sockets.length, 1); assert.equal(client.statuses.at(-1), 'connected'); }
  } finally { for (const client of clients) client.client.close(); }
});

test('lost older ACKs retain capacity until the exact fifteen-second deadline without a false pause', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const host = connection(0, 45000, () => Date.now());
  try {
    host.ready();
    host.socket.onSend = packet => { if (packet.type === 'ping') host.socket.message({ type: 'pong' }); };
    host.client.sendState(1, activeState()); advance(t, 50); host.client.sendState(2, activeState());
    advance(t, 50); host.socket.message({ type: 'ack', kind: 'state', seq: 1 }); // Seq2 sent at100.
    advance(t, 50); host.client.sendState(3, activeState());
    advance(t, 50); host.client.sendState(4, activeState());
    advance(t, 50); host.socket.message({ type: 'ack', kind: 'state', seq: 3 }); // Seq4 sent at250.
    advance(t, 50); host.client.sendState(5, activeState());
    advance(t, 50); host.socket.message({ type: 'ack', kind: 'state', seq: 5 });
    host.client.sendState(6, activeState()); advance(t, 150); host.socket.message({ type: 'ack', kind: 'state', seq: 6 });
    advance(t, 14500); host.client.sendState(7, activeState()); advance(t, 99);
    assert.equal(Date.now() - now, 15099);
    assert.equal(host.sockets.length, 1, 'newer exact ACKs superseded both missing five-second failure timers');
    host.client.sendState(8, activeState());
    assert.equal(host.socket.sent.filter((packet: any) => packet.type === 'state').length, 7, 'two missing older ACKs still retain credits after14999ms');
    advance(t, 1);
    assert.deepEqual(host.socket.sent.at(-1), { type: 'state', seq: 8, state: activeState() }, 'the seq2 capacity credit expires at send+15000ms');
    assert.equal(host.sockets.length, 1); assert.equal(host.statuses.at(-1), 'connected');
  } finally { host.client.close(); }
});

test('peer loss and reconnect reset a healthy expanded guest window to one', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const guest = connection(1, 45000, () => Date.now());
  try {
    guest.ready(); guest.client.sendInput(1, 32); advance(t, 50); guest.client.sendInput(2, 32);
    guest.socket.message({ type: 'ack', kind: 'input', seq: 1 }); advance(t, 50); guest.client.sendInput(3, 32);
    assert.equal(guest.socket.sent.length, 4, 'healthy demand expanded the guest window to two');
    guest.socket.message({ type: 'peer', connected: false }); guest.socket.message({ type: 'peer', connected: true });
    advance(t, 50); guest.client.sendInput(4, 0); advance(t, 50); guest.client.sendInput(5, 32);
    assert.equal(guest.socket.sent.length, 5, 'fresh peer has only one data credit');
    guest.socket.message({ type: 'ack', kind: 'input', seq: 3 });
    assert.equal(guest.socket.sent.length, 5, 'a cleared old ACK cannot grow or release the fresh window');
    guest.socket.disconnect(); advance(t, 500);
    const resumed = guest.sockets[1]; resumed.open(); resumed.message({ type: 'ready', ...publication, roomId: id, seat: 1, expiresAt: room.expiresAt }); resumed.message({ type: 'peer', connected: true });
    guest.client.sendInput(6, 32); advance(t, 50); guest.client.sendInput(7, 32);
    assert.equal(resumed.sent.length, 2, 'socket replacement also starts at one');
  } finally { guest.client.close(); }
});

test('a 60 ms tap behind a cold 180 ms ACK survives in the coalesced release and cannot replay', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const guest = connection(1, 45000, () => Date.now()), host = connection(0, 45000, () => Date.now());
  const sentAt: { seq: number; mask: number; time: number; history: { seq: number; mask: number }[] }[] = [];
  try {
    guest.ready(); host.ready();
    guest.socket.onSend = packet => {
      if (packet.type !== 'input') return;
      sentAt.push({ seq: packet.seq as number, mask: packet.mask as number, time: Date.now() - now, history: packet.history as { seq: number; mask: number }[] });
      setTimeout(() => guest.socket.message({ type: 'ack', kind: 'input', seq: packet.seq }), 180);
    };
    guest.client.sendInput(1, 0); advance(t, 20);
    guest.client.sendInput(2, 18); advance(t, 60); // Right + jump held from 20 to 80 ms.
    guest.client.sendInput(3, 0);
    assert.deepEqual(sentAt.map(({ seq, mask, time }) => ({ seq, mask, time })), [{ seq: 1, mask: 0, time: 0 }]);
    advance(t, 100);
    assert.deepEqual(sentAt.map(({ seq, mask, time }) => ({ seq, mask, time })), [{ seq: 1, mask: 0, time: 0 }, { seq: 3, mask: 0, time: 180 }]);
    const release = sentAt[1];
    host.socket.message({ type: 'input', seq: release.seq, mask: release.mask, history: release.history });
    host.socket.message({ type: 'input', seq: 2, mask: 18, history: [{ seq: 1, mask: 0 }, { seq: 2, mask: 18 }] });
    assert.deepEqual(host.inputs, [{ seq: 3, mask: 0 }]);
    assert.deepEqual(host.inputEdges, [18], 'newest packet preserves both press edges once; stale callbacks cannot replay them');
    advance(t, 200);
    guest.client.sendInput(4, 0);
    const repeated = sentAt.at(-1)!;
    assert.ok(repeated.history.some(sample => sample.seq === 2 && sample.mask === 18), 'ACKs do not erase recent transition recovery');
    host.socket.message({ type: 'input', seq: repeated.seq, mask: repeated.mask, history: repeated.history });
    assert.deepEqual(host.inputEdges, [18, 0], 'repeated history cannot retrigger a jump, shot or movement tap');
    assert.equal(guest.sockets.length, 1);
  } finally { guest.client.close(); host.client.close(); }
});

test('bursty queues and out-of-order ACKs respect state/input rates, byte bounds and finite history', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const host = connection(0, 45000, () => Date.now()), guest = connection(1, 45000, () => Date.now());
  const stateTimes: number[] = [], inputTimes: number[] = [];
  try {
    host.ready(); guest.ready();
    for (const [client, kind, times] of [[host, 'state', stateTimes], [guest, 'input', inputTimes]] as const) client.socket.onSend = packet => {
      if (packet.type !== kind) return;
      times.push(Date.now() - now);
      assert.ok(new TextEncoder().encode(JSON.stringify(packet)).length <= 25600);
      if (kind === 'input') {
        assert.ok(Array.isArray(packet.history) && packet.history.length <= 8);
        assert.ok(validateMultiplayerServerMessage(JSON.stringify(packet), strictState));
      }
      setTimeout(() => client.socket.message({ type: 'ack', kind, seq: packet.seq }), Number(packet.seq) % 2 ? 160 : 70);
    };
    for (let tick = 0; tick < 300; tick++) {
      for (let burst = 0; burst < 10; burst++) { const seq = tick * 10 + burst + 1; host.client.sendState(seq, activeState()); guest.client.sendInput(seq, seq % 2 ? 63 : 0); }
      advance(t, 10);
    }
    for (const [times, spacing, maximum] of [[stateTimes, 50, 20], [inputTimes, 40, 25]] as const) {
      assert.ok(times.length > 30, 'updates continue despite delayed and reordered ACKs');
      for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= spacing);
      for (const start of times) assert.ok(times.filter(time => time >= start && time < start + 1000).length <= maximum);
    }
    assert.equal(host.sockets.length, 1); assert.equal(guest.sockets.length, 1);
  } finally { host.client.close(); guest.client.close(); }
});

test('busy frames are an exact bounded union without authority, identity or a fake lease', () => {
  for (const value of [{ type: 'busy', kind: 'state', seq: 1, retryAfterMs: 50 }, { type: 'busy', kind: 'input', seq: 10000000, retryAfterMs: 1000 }, { type: 'busy', kind: 'ping', retryAfterMs: 200 }]) assert.deepEqual(validateMultiplayerServerMessage(JSON.stringify(value), strictState), value);
  for (const change of [{ kind: 'join' }, { kind: 'ping', seq: 1 }, { seq: 0 }, { seq: true }, { seq: 10000001 }, { seq: 1.5 }, { retryAfterMs: 49 }, { retryAfterMs: 1001 }, { retryAfterMs: true }, { retryAfterMs: 200.5 }, { expiresAt: room.expiresAt }, { token }, { state: { tick: 1 } }, { connected: true }]) assert.equal(validateMultiplayerServerMessage(JSON.stringify({ type: 'busy', kind: 'state', seq: 1, retryAfterMs: 200, ...change }), strictState), undefined);
  for (const value of [{ type: 'busy', kind: 'state', retryAfterMs: 200 }, { type: 'busy', kind: 'ping', seq: 1, retryAfterMs: 200 }, { type: 'busy', kind: 'ping', retryAfterMs: '200' }]) assert.equal(validateMultiplayerServerMessage(JSON.stringify(value), strictState), undefined);
  const host = connection();
  try { host.ready(); host.socket.message({ type: 'busy', kind: 'state', seq: 1, retryAfterMs: 200, expiresAt: room.expiresAt }); assert.equal(host.statuses.at(-1), 'ended:invalid-message'); }
  finally { host.client.close(); }
});

test('matching busy backs off one failed packet, preserves only the newest state and ignores bogus or duplicate signals', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const host = connection(0, 45000, () => Date.now());
  try {
    host.ready(); host.client.sendState(1, activeState()); advance(t, 50); host.client.sendState(2, activeState());
    for (const message of [{ type: 'busy', kind: 'input', seq: 1, retryAfterMs: 200 }, { type: 'busy', kind: 'state', seq: 2, retryAfterMs: 200 }]) host.socket.message(message);
    advance(t, 50); assert.equal(host.socket.sent.length, 2, 'unknown or wrong-kind busy cannot release a real credit');
    host.socket.message({ type: 'busy', kind: 'state', seq: 1, retryAfterMs: 200 });
    advance(t, 100); host.client.sendState(3, activeState());
    host.socket.message({ type: 'busy', kind: 'state', seq: 1, retryAfterMs: 1000 });
    advance(t, 99); assert.equal(host.socket.sent.length, 2, 'busy imposes a bounded quiet interval');
    advance(t, 1); assert.deepEqual(host.socket.sent.at(-1), { type: 'state', seq: 3, state: activeState() }, 'newest queued snapshot replaces the failed older one, without duplicate extending backoff');
    host.client.sendState(4, activeState()); advance(t, 50);
    assert.equal(host.socket.sent.length, 3, 'busy resets the data window to one');
    assert.equal(host.statuses.at(-1), 'connected'); assert.equal(host.peers.at(-1), true);
    assert.deepEqual(host.inputs, []); assert.deepEqual(host.states, []);
  } finally { host.client.close(); }
});

test('busy for an older packet never replays it after newer success and does not cancel another flight timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const host = connection(0, 45000, () => Date.now());
  try {
    host.ready(); host.client.sendState(1, activeState()); advance(t, 50); host.client.sendState(2, activeState());
    advance(t, 50); host.socket.message({ type: 'ack', kind: 'state', seq: 1 });
    advance(t, 50); host.client.sendState(3, activeState());
    host.socket.message({ type: 'ack', kind: 'state', seq: 3 });
    host.socket.message({ type: 'busy', kind: 'state', seq: 2, retryAfterMs: 200 });
    const before = host.socket.sent.length; advance(t, 200);
    assert.equal(host.socket.sent.length, before, 'an exact busy retires its older credit but cannot resurrect committed old data');
    host.client.sendState(4, activeState()); advance(t, 50); host.client.sendState(5, activeState());
    host.socket.message({ type: 'ack', kind: 'state', seq: 4 }); advance(t, 50); host.client.sendState(6, activeState());
    host.socket.message({ type: 'busy', kind: 'state', seq: 6, retryAfterMs: 200 });
    advance(t, 4949);
    assert.equal(host.statuses.at(-1), 'connected');
    advance(t, 1);
    assert.equal(host.statuses.at(-1), 'reconnecting', 'busy must leave the unacknowledged other packet failure timer intact');
  } finally { host.client.close(); }
});

test('guest tap and newest release survive contention without playing or replaying authoritative input locally', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const guest = connection(1, 45000, () => Date.now()), host = connection(0, 45000, () => Date.now());
  try {
    guest.ready(); host.ready(); guest.client.sendInput(1, 0);
    advance(t, 20); guest.client.sendInput(2, 18); advance(t, 60); guest.client.sendInput(3, 0);
    guest.socket.message({ type: 'busy', kind: 'input', seq: 1, retryAfterMs: 200 });
    advance(t, 200);
    const release = guest.socket.sent.at(-1);
    assert.deepEqual(release, { type: 'input', seq: 3, mask: 0, history: [{ seq: 1, mask: 0 }, { seq: 2, mask: 18 }, { seq: 3, mask: 0 }] });
    assert.deepEqual(guest.inputs, []); assert.deepEqual(guest.states, []);
    host.socket.message(release); host.socket.message(release);
    assert.deepEqual(host.inputs, [{ seq: 3, mask: 0 }]); assert.deepEqual(host.inputEdges, [18]);
    guest.socket.message({ type: 'ack', kind: 'input', seq: 3 });
    guest.socket.message({ type: 'busy', kind: 'input', seq: 1, retryAfterMs: 1000 });
    advance(t, 1000); assert.equal(guest.socket.sent.length, 3, 'a late old busy cannot replay acknowledged taps');
  } finally { guest.client.close(); host.client.close(); }
});

test('busy retries use fresh wire sequences so delayed duplicate busy and ACK cannot release a retried credit', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const host = connection(0, 45000, () => Date.now());
  try {
    host.ready(); host.client.sendState(1, activeState());
    host.socket.message({ type: 'busy', kind: 'state', seq: 1, retryAfterMs: 200 });
    advance(t, 200); assert.deepEqual(host.socket.sent.at(-1), { type: 'state', seq: 2, state: activeState() });
    host.client.sendState(2, activeState());
    host.socket.message({ type: 'ack', kind: 'state', seq: 1 });
    host.socket.message({ type: 'busy', kind: 'state', seq: 1, retryAfterMs: 50 });
    advance(t, 200); assert.equal(host.socket.sent.length, 3, 'late messages for the old wire sequence cannot free retry capacity');
    host.socket.message({ type: 'ack', kind: 'state', seq: 2 });
    assert.deepEqual(host.socket.sent.at(-1), { type: 'state', seq: 3, state: activeState() }, 'caller seq2 remains admissible and maps beyond the fresh retry');
    host.client.sendState(2, activeState()); advance(t, 50);
    assert.equal(host.socket.sent.length, 4, 'caller admission still rejects its own duplicate sequence');
  } finally { host.client.close(); }
});

test('fresh input retry preserves bounded press history and future caller release without replaying the edge', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const guest = connection(1, 45000, () => Date.now()), host = connection(0, 45000, () => Date.now());
  try {
    guest.ready(); host.ready(); guest.client.sendInput(1, 18);
    guest.socket.message({ type: 'busy', kind: 'input', seq: 1, retryAfterMs: 200 }); advance(t, 200);
    const retry = guest.socket.sent.at(-1);
    assert.deepEqual(retry, { type: 'input', seq: 2, mask: 18, history: [{ seq: 1, mask: 18 }, { seq: 2, mask: 18 }] });
    host.socket.message(retry); guest.socket.message({ type: 'ack', kind: 'input', seq: 2 });
    guest.client.sendInput(2, 0); advance(t, 40); const release = guest.socket.sent.at(-1);
    assert.deepEqual(release, { type: 'input', seq: 3, mask: 0, history: [{ seq: 1, mask: 18 }, { seq: 3, mask: 0 }] });
    host.socket.message(release); host.socket.message(retry);
    assert.deepEqual(host.inputs, [{ seq: 2, mask: 18 }, { seq: 3, mask: 0 }]); assert.deepEqual(host.inputEdges, [18, 0]);
    guest.socket.message({ type: 'busy', kind: 'input', seq: 1, retryAfterMs: 50 }); advance(t, 200);
    assert.equal(guest.socket.sent.length, 4);
  } finally { guest.client.close(); host.client.close(); }
});

test('wire sequence exhaustion is bounded and cannot wrap or reuse a busy packet', () => {
  const host = connection();
  try {
    host.ready(); host.client.sendState(10000000, activeState());
    host.socket.message({ type: 'busy', kind: 'state', seq: 10000000, retryAfterMs: 200 });
    assert.equal(host.statuses.at(-1), 'ended:sequence-exhausted'); assert.equal(host.socket.sent.length, 2);
  } finally { host.client.close(); }
});

test('repeated busy retries retain a short tap instead of replacing its history with retry tails', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const guest = connection(1, 45000, () => Date.now()), host = connection(0, 45000, () => Date.now());
  try {
    guest.ready(); host.ready(); guest.client.sendInput(1, 0);
    advance(t, 20); guest.client.sendInput(2, 18); advance(t, 60); guest.client.sendInput(3, 0);
    guest.socket.message({ type: 'busy', kind: 'input', seq: 1, retryAfterMs: 50 }); advance(t, 50);
    for (let retry = 0; retry < 12; retry++) {
      const failed = guest.socket.sent.at(-1) as { seq: number; history: { seq: number; mask: number }[] };
      guest.socket.message({ type: 'busy', kind: 'input', seq: failed.seq, retryAfterMs: 50 }); advance(t, 50);
      const fresh = guest.socket.sent.at(-1) as typeof failed;
      assert.equal(fresh.seq, failed.seq + 1); assert.ok(fresh.history.length <= 8); assert.ok(fresh.history.some(sample => sample.seq === 2 && sample.mask === 18));
    }
    const final = guest.socket.sent.at(-1); host.socket.message(final); host.socket.message(final);
    assert.deepEqual(host.inputEdges, [18]);
    guest.socket.message({ type: 'ack', kind: 'input', seq: (final as { seq: number }).seq });
    guest.socket.disconnect(); advance(t, 500);
    const resumed = guest.sockets[1]; resumed.open(); resumed.message({ type: 'ready', ...publication, roomId: id, seat: 1, expiresAt: room.expiresAt }); resumed.message({ type: 'peer', connected: true });
    guest.client.sendInput(4, 0);
    assert.ok(Number((resumed.sent.at(-1) as { seq: number }).seq) > Number((final as { seq: number }).seq), 'fresh wire admission remains monotonic after reconnect');
    assert.equal((resumed.sent.at(-1) as { history: unknown[] }).history.length, 1, 'reconnect still clears all old press history');
  } finally { guest.client.close(); host.client.close(); }
});

test('ping busy waits for the regular heartbeat and never grants a pong, peer or lease', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const guest = connection(1, 45000, () => Date.now());
  try {
    guest.ready(); guest.socket.message({ type: 'busy', kind: 'ping', retryAfterMs: 200 });
    advance(t, 10000); assert.equal(guest.socket.sent.filter((packet: any) => packet.type === 'ping').length, 1);
    guest.socket.message({ type: 'busy', kind: 'ping', retryAfterMs: 200 });
    advance(t, 100); guest.socket.message({ type: 'busy', kind: 'ping', retryAfterMs: 1000 });
    advance(t, 99); assert.equal(guest.socket.sent.filter((packet: any) => packet.type === 'ping').length, 1);
    advance(t, 1); assert.equal(guest.socket.sent.filter((packet: any) => packet.type === 'ping').length, 1, 'an unsequenced busy never creates a rapid heartbeat retry');
    assert.equal(guest.peers.at(-1), true); assert.deepEqual(guest.inputs, []); assert.deepEqual(guest.states, []);
    advance(t, 9800); assert.equal(guest.socket.sent.filter((packet: any) => packet.type === 'ping').length, 2, 'a matched busy allows the next normal ten-second heartbeat');
    guest.socket.message({ type: 'busy', kind: 'ping', retryAfterMs: 1000 });
    guest.socket.message({ type: 'peer', connected: false }); advance(t, 1000);
    assert.equal(guest.socket.sent.filter((packet: any) => packet.type === 'ping').length, 2, 'peer loss clears the backoff retry');
    advance(t, 19000);
    assert.equal(guest.statuses.at(-1), 'reconnecting', 'busy is not heartbeat progress and cannot keep an unresponsive socket alive');
  } finally { guest.client.close(); }
});

test('input history rejects missing tail, unordered, oversized, unsafe and noninteger samples while exact legacy masks remain valid', () => {
  const base = { type: 'input', seq: 3, mask: 0, history: [{ seq: 1, mask: 0 }, { seq: 2, mask: 18 }, { seq: 3, mask: 0 }] };
  assert.deepEqual(validateMultiplayerServerMessage(JSON.stringify(base), strictState), base);
  assert.deepEqual(validateMultiplayerServerMessage(JSON.stringify({ type: 'input', seq: 3, mask: 0 }), strictState), { type: 'input', seq: 3, mask: 0 });
  for (const history of [[], null, 'invalid', [{ seq: 2, mask: 18 }], [{ seq: 3, mask: 18 }], [{ seq: 3, mask: 0 }, { seq: 2, mask: 0 }], [{ seq: 3, mask: 0 }, { seq: 3, mask: 0 }], [{ seq: 1, mask: 0 }, { seq: 4, mask: 0 }], [{ seq: true, mask: 18 }, { seq: 3, mask: 0 }], [{ seq: 2.5, mask: 18 }, { seq: 3, mask: 0 }], [{ seq: -1, mask: 18 }, { seq: 3, mask: 0 }], [{ seq: 2, mask: 64 }, { seq: 3, mask: 0 }], [{ seq: 2, mask: true }, { seq: 3, mask: 0 }], [{ seq: 2, mask: 18, html: '<script>' }, { seq: 3, mask: 0 }], Array.from({ length: 9 }, (_, index) => ({ seq: index + 1, mask: 0 }))]) assert.equal(validateMultiplayerServerMessage(JSON.stringify({ ...base, history }), strictState), undefined);
  const host = connection();
  try {
    host.ready(); host.socket.message({ ...base, history: base.history.slice(0, -1) });
    assert.equal(host.statuses.at(-1), 'ended:invalid-message'); assert.deepEqual(host.inputs, []);
  } finally { host.client.close(); }
});

test('peer loss clears recent tap history and cannot carry held edges into a fresh connection', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const guest = connection(1, 45000, () => Date.now()), host = connection(0, 45000, () => Date.now());
  try {
    guest.ready(); host.ready(); guest.client.sendInput(1, 63);
    host.socket.message({ type: 'input', seq: 1, mask: 63, history: [{ seq: 1, mask: 63 }] });
    guest.socket.message({ type: 'peer', connected: false }); host.socket.message({ type: 'peer', connected: false });
    guest.socket.message({ type: 'peer', connected: true }); host.socket.message({ type: 'peer', connected: true });
    guest.client.sendInput(2, 0);
    assert.equal(guest.socket.sent.length, 2, 'peer changes cannot bypass pacing on the same relay connection');
    t.mock.timers.tick(39); assert.equal(guest.socket.sent.length, 2);
    t.mock.timers.tick(1);
    assert.deepEqual(guest.socket.sent.at(-1), { type: 'input', seq: 2, mask: 0, history: [{ seq: 2, mask: 0 }] });
    host.socket.message(guest.socket.sent.at(-1));
    assert.deepEqual(host.inputEdges, [63, 0]);
  } finally { guest.client.close(); host.client.close(); }
});

test('ACK timeout reconnects the same host seat and sends only its latest paused state after fresh admission', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.ready(); c.client.sendState(1, { tick: 1 }); c.client.sendState(2, { tick: 1 });
    t.mock.timers.tick(4999); c.socket.message({ type: 'pong' });
    assert.equal(c.sockets.length, 1);
    t.mock.timers.tick(1); assert.equal(c.statuses.at(-1), 'reconnecting'); assert.equal(c.peers.at(-1), false); assert.equal(c.socket.closes, 1);
    c.client.sendState(3, { tick: 1 });
    t.mock.timers.tick(500); const resumed = c.sockets[1]; resumed.open();
    resumed.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt: room.expiresAt });
    assert.equal(resumed.sent.length, 1, 'data must wait for both fresh admission and the peer');
    resumed.message({ type: 'peer', connected: true });
    assert.deepEqual(resumed.sent.slice(1), [{ type: 'state', seq: 3, state: { tick: 1 } }]);
    c.client.sendState(4, { tick: 1 }); c.socket.message({ type: 'ack', kind: 'state', seq: 3 });
    assert.equal(resumed.sent.length, 2, 'old socket callbacks cannot acknowledge a new flight');
    resumed.message({ type: 'ack', kind: 'state', seq: 3 });
    t.mock.timers.tick(50);
    assert.deepEqual(resumed.sent.at(-1), { type: 'state', seq: 4, state: { tick: 1 } });
  } finally { c.client.close(); }
});

test('guest reconnect drops held and queued controls until the frame supplies fresh input', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(1, 45000, () => Date.now());
  try {
    c.ready(); c.client.sendInput(1, 63); c.client.sendInput(2, 32); c.socket.disconnect();
    c.client.sendInput(3, 32); // A disconnected frame cannot enqueue controls.
    t.mock.timers.tick(500); const resumed = c.sockets[1]; resumed.open();
    resumed.message({ type: 'ready', ...publication, roomId: id, seat: 1, expiresAt: room.expiresAt }); resumed.message({ type: 'peer', connected: true });
    assert.equal(resumed.sent.length, 1, 'cached nonzero masks must never be replayed');
    c.client.sendInput(4, 0); assert.deepEqual(resumed.sent.at(-1), { type: 'input', seq: 4, mask: 0, history: [{ seq: 4, mask: 0 }] });
    c.socket.message({ type: 'ack', kind: 'input', seq: 4 }); c.client.sendInput(5, 1);
    assert.equal(resumed.sent.length, 2, 'an old socket ACK cannot release fresh controls');
    resumed.message({ type: 'ack', kind: 'input', seq: 4 }); t.mock.timers.tick(40);
    assert.deepEqual(resumed.sent.at(-1), { type: 'input', seq: 5, mask: 1, history: [{ seq: 4, mask: 0 }, { seq: 5, mask: 1 }] });
  } finally { c.client.close(); }
});

test('Gateway failures are a separate exact bounded transport classification, never permissive game messages', () => {
  const base = { message: 'Internal server error', connectionId: 'syntheticConnection=', requestId: 'syntheticRequest=' };
  for (const message of ['Internal server error', 'Internal Server Error', 'Endpoint request timed out', 'Endpoint request timed out.', 'Too Many Requests', 'Limit Exceeded']) {
    const raw = JSON.stringify({ ...base, message }); assert.equal(isTransientMultiplayerServiceError(raw), true); assert.equal(validateMultiplayerServerMessage(raw, strictState), undefined);
  }
  for (const invalid of [null, [], { message: base.message }, { ...base, type: 'state' }, { ...base, state: { tick: 1 } }, { ...base, token }, { ...base, message: 'anything' }, { ...base, connectionId: '<script>' }, { ...base, requestId: 'x'.repeat(129) }, { ...base, requestId: '\nprivate' }]) assert.equal(isTransientMultiplayerServiceError(JSON.stringify(invalid)), false);
  for (const invalid of ['{', 'x'.repeat(1025), new Blob()]) assert.equal(isTransientMultiplayerServiceError(invalid), false);
  for (const invalid of [{ type: 'ack', kind: 'input', seq: 0 }, { type: 'ack', kind: 'other', seq: 1 }, { type: 'ack', kind: 'state', seq: 1, token }, { type: 'ack', kind: 'input', seq: 1.2 }]) assert.equal(validateMultiplayerServerMessage(JSON.stringify(invalid), strictState), undefined);
  assert.deepEqual(validateMultiplayerServerMessage(JSON.stringify({ type: 'ack', kind: 'state', seq: 1 }), strictState), { type: 'ack', kind: 'state', seq: 1 });
});

test('known Gateway errors reconnect without granting a lease while unknown frames still terminate', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.ready(); c.socket.message({ message: 'Internal server error', connectionId: 'safe=', requestId: 'safe=' });
    assert.equal(c.statuses.at(-1), 'reconnecting'); assert.equal(c.socket.closes, 1);
    t.mock.timers.tick(500); const resumed = c.sockets[1]; resumed.open();
    resumed.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt: room.expiresAt }); resumed.message({ type: 'peer', connected: true });
    assert.equal(c.statuses.at(-1), 'connected');
    resumed.message({ message: 'new untrusted protocol', connectionId: 'safe=', requestId: 'safe=' });
    assert.equal(c.statuses.at(-1), 'ended:invalid-message');
  } finally { c.client.close(); }
});

test('repeated service failures cannot reset the recovery budget through successful ready handshakes', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  const failed = new Set<FakeSocket>();
  try {
    c.ready();
    for (let tick = 0; tick < 45; tick++) {
      const socket = c.sockets.at(-1)!;
      if (!failed.has(socket)) {
        if (socket.readyState !== 1) { socket.open(); socket.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt: room.expiresAt }); socket.message({ type: 'peer', connected: true }); }
        socket.message({ message: 'Internal server error', connectionId: 'safe=', requestId: 'safe=' }); failed.add(socket);
      }
      t.mock.timers.tick(1000);
    }
    assert.equal(c.statuses.at(-1), 'ended:connection-lost'); assert.ok(c.sockets.length > 2 && c.sockets.length < 20);
    const attempts = c.sockets.length; t.mock.timers.tick(120000); assert.equal(c.sockets.length, attempts);
  } finally { c.client.close(); }
});

test('thirty healthy seconds of real pongs reset an outage budget rather than imposing a room age cap', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.ready(); c.socket.message({ message: 'Internal server error', connectionId: 'safe=', requestId: 'safe=' });
    t.mock.timers.tick(500); const resumed = c.sockets[1]; resumed.open();
    resumed.message({ type: 'ready', ...publication, roomId: id, seat: 0, expiresAt: room.expiresAt }); resumed.message({ type: 'peer', connected: true });
    resumed.onSend = value => { if (value.type === 'ping') resumed.message({ type: 'pong' }); };
    for (let tick = 0; tick < 6; tick++) t.mock.timers.tick(10000);
    assert.equal(c.statuses.at(-1), 'connected'); assert.equal(resumed.closes, 0);
    resumed.message({ message: 'Too Many Requests', connectionId: 'safe=', requestId: 'safe=' });
    assert.equal(c.statuses.at(-1), 'reconnecting', 'a recovered room has a new bounded outage episode');
  } finally { c.client.close(); }
});
