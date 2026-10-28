import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { connectMultiplayer, createMultiplayerInvitation, loadMultiplayerAPI, multiplayerRequest, parseMultiplayerInvitation, sameMultiplayerPublication, watchMultiplayerInvitations, validateMultiplayerAPIConfig, validateMultiplayerRoom, validateMultiplayerLobby, validateMultiplayerServerMessage, isTransientMultiplayerServiceError, validateMultiplayerSocketURL, type MultiplayerRoom, type MultiplayerSocket } from '../src/lib/game-multiplayer.ts';
import { setCooperativeMode, updateArcadeLevelPlan } from '../src/lib/game-multiplayer-design.ts';
import { defaultGameSpec, planGameLevels, validateGameSpec } from '../src/lib/game-design.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';

const id = '11111111-1111-4111-8111-111111111111', gameId = '22222222-2222-4222-8222-222222222222', token = 'A'.repeat(43), inviteToken = 'B'.repeat(43), now = 1793102400000;
const publication = { gameId, publishedRevision: 1, specSha256: 'c'.repeat(64) };
const room: MultiplayerRoom = { ...publication, roomId: id, token, expiresAt: Math.floor(now / 1000) + 1800, socketUrl: 'wss://relay.execute-api.us-east-1.amazonaws.com/production', seat: 0 };
const strictState = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { tick?: unknown }).tick === 1);
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
    t.ready(); assert.equal(t.socket.url.includes(token), false); assert.deepEqual(t.socket.sent[0], { type: 'join', roomId: id, token, leaseVersion: 1, flowVersion: 2 });
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
    const resumed = c.sockets[1]; resumed.open(); assert.deepEqual(resumed.sent[0], { type: 'join', roomId: id, token, leaseVersion: 1, flowVersion: 2 }); assert.equal(resumed.url.includes(token), false);
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
    assert.deepEqual(resumed.sent[0], { type: 'join', roomId: id, token, leaseVersion: 1, flowVersion: 2 });
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

test('flow control bounds eight packets in flight and coalesces pending snapshots without trusting bogus ACKs', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const c = connection(0, 45000, () => Date.now());
  try {
    c.ready();
    for (let seq = 1; seq <= 8; seq++) { c.client.sendState(seq, { tick: 1 }); t.mock.timers.tick(50); }
    const snapshot = { tick: 1 };
    for (let seq = 9; seq <= 1000; seq++) c.client.sendState(seq, snapshot);
    snapshot.tick = 2;
    assert.equal(c.socket.sent.length, 9, 'the join and eight unacknowledged states are the only writes');
    for (const invalid of [{ type: 'ack', kind: 'input', seq: 1 }, { type: 'ack', kind: 'state', seq: 999 }]) c.socket.message(invalid);
    assert.equal(c.socket.sent.length, 9, 'an unrelated ACK cannot free a window slot');
    c.socket.message({ type: 'ack', kind: 'state', seq: 4 });
    assert.deepEqual(c.socket.sent.at(-1), { type: 'state', seq: 1000, state: { tick: 1 } }, 'only the newest serialized snapshot is sent');
    c.client.sendState(1001, { tick: 1 }); t.mock.timers.tick(50);
    c.socket.message({ type: 'ack', kind: 'state', seq: 4 });
    assert.equal(c.socket.sent.length, 10, 'a duplicate ACK cannot free another slot');
    c.socket.message({ type: 'ack', kind: 'state', seq: 1000 });
    assert.deepEqual(c.socket.sent.at(-1), { type: 'state', seq: 1001, state: { tick: 1 } });
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

test('400 ms ACK latency preserves 10 Hz host snapshots with a bounded window instead of 2.5 Hz stop-and-wait', t => {
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
    for (let seq = 1; seq <= 20; seq++) { host.client.sendState(seq, { tick: 1 }); advance(t, 100); }
    assert.deepEqual(sentAt, Array.from({ length: 20 }, (_, index) => index * 100));
    assert.equal(sentAt.length / 2, 10, 'all 20 snapshots produced over two seconds leave at 10 Hz');
    assert.ok(maximumOutstanding >= 4 && maximumOutstanding <= 8);
    assert.equal(host.sockets.length, 1); assert.equal(host.statuses.at(-1), 'connected');
  } finally { host.client.close(); }
});

test('a 60 ms tap behind a 180 ms ACK is preserved even when its newest release overtakes the press', t => {
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
    assert.deepEqual(sentAt.map(({ seq, mask, time }) => ({ seq, mask, time })), [
      { seq: 1, mask: 0, time: 0 }, { seq: 2, mask: 18, time: 40 }, { seq: 3, mask: 0, time: 80 },
    ]);
    const release = sentAt[2];
    host.socket.message({ type: 'input', seq: release.seq, mask: release.mask, history: release.history });
    host.socket.message({ type: 'input', seq: sentAt[1].seq, mask: sentAt[1].mask, history: sentAt[1].history });
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
      for (let burst = 0; burst < 10; burst++) { const seq = tick * 10 + burst + 1; host.client.sendState(seq, { tick: 1 }); guest.client.sendInput(seq, seq % 2 ? 63 : 0); }
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
