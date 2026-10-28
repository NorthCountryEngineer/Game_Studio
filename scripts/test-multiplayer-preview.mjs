/** Standalone CI rehearsal using two real WebSocket clients and the real
 * Python relay against disposable synthetic state. --reuse uses an open preview. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createCooperativeEngine, validateCooperativeState } from '../src/lib/game-cooperative.ts';
import { createPublicationBinding } from '../src/lib/game-scoring.ts';
import { connectMultiplayer, validateMultiplayerRoom } from '../src/lib/game-multiplayer.ts';


const reuse = process.argv.includes('--reuse');
if (process.argv.slice(2).some(value => !['--reuse', '--standalone'].includes(value))) throw new Error('Use --reuse for an already-running local preview; standalone is the default.');
async function freePort() { const server = createServer(); await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); }); const value = server.address().port; await new Promise(accept => server.close(accept)); return value; }
const frontendPort = Number(process.env.MULTIPLAYER_PREVIEW_PORT || (reuse ? 8096 : await freePort()));
let relayPort = Number(process.env.MULTIPLAYER_PREVIEW_RELAY_PORT || (reuse ? 8097 : await freePort()));
if (!reuse && !process.env.MULTIPLAYER_PREVIEW_RELAY_PORT) while (relayPort === frontendPort) relayPort = await freePort();
const origin = `http://127.0.0.1:${frontendPort}`, api = `http://127.0.0.1:${relayPort}`;
let server, serverOutput = '', cleaned = false;
function killOwned(signal) { if (!server?.pid || cleaned) return; try { if (process.platform === 'win32') server.kill(signal); else process.kill(-server.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
async function stopOwned() { if (!server) return; const alreadyExited = server.exitCode !== null || server.signalCode !== null; const exited = alreadyExited ? Promise.resolve() : new Promise(accept => server.once('exit', accept)); killOwned('SIGTERM'); let timer; await Promise.race([exited, new Promise(accept => { timer = setTimeout(() => { killOwned('SIGKILL'); accept(); }, 3000); })]); clearTimeout(timer); cleaned = true; }
async function startOwned() {
  if (reuse) return;
  server = spawn(process.execPath, [fileURLToPath(new URL('./multiplayer-preview.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), detached: process.platform !== 'win32',
    env: { ...process.env, MULTIPLAYER_PREVIEW_PORT: String(frontendPort), MULTIPLAYER_PREVIEW_RELAY_PORT: String(relayPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.on('error', error => { serverOutput = error.message; });
  for (const pipe of [server.stdout, server.stderr]) pipe.on('data', value => { serverOutput = (serverOutput + value.toString()).slice(-4000); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && server.exitCode === null && server.signalCode === null) {
    try {
      const [health, fixture] = await Promise.all([fetch(`${api}/health`, { signal: AbortSignal.timeout(500) }), fetch(`${origin}/__multiplayer-fixture.json`, { signal: AbortSignal.timeout(500) })]);
      if (health.ok && fixture.ok && (await health.json()).mode === 'synthetic-preview' && (await fixture.json()).spec.version === 6) return;
    } catch { /* Local startup may need a brief retry. */ }
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error(`The isolated local preview did not become ready. ${serverOutput}`);
}
process.once('exit', () => killOwned('SIGTERM'));
async function check() {
  
  const fixture = await (await fetch(`${origin}/__multiplayer-fixture.json`, { signal: AbortSignal.timeout(3000) })).json();
  const binding = await createPublicationBinding(fixture);
  async function request(path, method, body, requestOrigin = origin) { return fetch(`${api}${path}`, { method, headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) }); }
  async function lobby() { const response = await request('/multiplayer/lobby', 'GET'); assert.equal(response.status, 200); const value = await response.json(); assert.deepEqual(Object.keys(value), ['rooms']); assert.ok(Array.isArray(value.rooms) && value.rooms.length <= 20); return value.rooms; }
  const createdResponse = await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision }); assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  const joining = { inviteToken: created.inviteToken, gameId: binding.game_id, publishedRevision: binding.published_revision, specSha256: binding.spec_sha256 };
  const guestResponse = await request(`/multiplayer/rooms/${created.roomId}/join`, 'POST', joining); assert.equal(guestResponse.status, 200); const guest = await guestResponse.json();
  assert.equal((await request(`/multiplayer/rooms/${created.roomId}/join`, 'POST', joining)).status, 403);
  assert.equal((await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision }, 'https://unapproved.example.test')).status, 403);
  const sockets = [];
  function connect(token, room = created, renewable = false, flow = false) {
    const socket = new WebSocket(room.socketUrl, { origin }); sockets.push(socket); const messages = [], waits = [];
    const receive = value => { messages.push(value); for (const wait of [...waits]) if (wait.predicate(value)) { clearTimeout(wait.timeout); waits.splice(waits.indexOf(wait), 1); wait.resolve(value); } };
    socket.on('error', () => {});
    socket.on('message', raw => receive(JSON.parse(raw.toString())));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'join', roomId: room.roomId, token, ...(renewable ? { leaseVersion: 1 } : {}), ...(flow ? { flowVersion: 1 } : {}) })));
    const until = predicate => { const existing = messages.find(predicate); if (existing) return Promise.resolve(existing); return new Promise((resolve, reject) => { const wait = { predicate, resolve, timeout: setTimeout(() => reject(new Error('Timed out waiting for the local relay.')), 5000) }; waits.push(wait); }); };
    return { socket, until, observed: () => [...messages], clear: () => { messages.length = 0; }, send: value => socket.send(JSON.stringify(value)) };
  }
  async function delayedClientRehearsal() {
    const response = await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision });
    assert.equal(response.status, 200); const rawHost = await response.json();
    const joined = await request(`/multiplayer/rooms/${rawHost.roomId}/join`, 'POST', { ...joining, inviteToken: rawHost.inviteToken });
    assert.equal(joined.status, 200); const rawGuest = await joined.json();
    const hostRoom = validateMultiplayerRoom(rawHost, 0, true), guestRoom = validateMultiplayerRoom(rawGuest, 1, true);
    assert.ok(hostRoom && guestRoom);
    const timers = new Set(), clients = [], received = [], controls = [], statuses = [], started = Date.now();
    let mask = 0, production = 0;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(predicate) { const deadline = Date.now() + 5000; while (!predicate() && Date.now() < deadline) await pause(5); assert.ok(predicate(), 'delayed real-client rehearsal reached its expected state'); }
    function later(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); }
    function delayedSocket(url) {
      const socket = new WebSocket(url, { origin }); sockets.push(socket);
      const view = { get readyState() { return socket.readyState; }, onopen: null, onmessage: null, onclose: null, onerror: null,
        send(raw) { const message = JSON.parse(raw); if (message.type === 'join') socket.send(raw); else later(() => { if (socket.readyState === 1) socket.send(raw); }, 80); },
        close(code) { socket.close(code); },
      };
      socket.on('open', () => view.onopen?.({})); socket.on('error', () => view.onerror?.({})); socket.on('close', () => view.onclose?.({}));
      socket.on('message', raw => { const data = raw.toString(), message = JSON.parse(data); later(() => view.onmessage?.({ data }), message.type === 'ack' ? 480 : 80); });
      return view;
    }
    const engine = createCooperativeEngine(), world = engine.create(fixture.spec); world.running = true; world.paused = false;
    // Stable synthetic space keeps this transport measurement independent of collisions.
    world.entities = []; world.nextSnack = world.nextHazard = 1;
    function client(room) { const value = connectMultiplayer(room, { validateState: value => Boolean(validateCooperativeState(value, fixture.spec)),
      socketFactory: delayedSocket, onStatus: status => statuses.push([room.seat, status]), onPeer: () => {},
      onInput: (seq, value, pressedMask) => { mask = value; controls.push({ seq, mask: value, pressedMask, at: Date.now() - started }); },
      onState: (seq, value) => { received.push({ seq, state: value }); },
    }); clients.push(value); return value; }
    const hostClient = client(hostRoom), guestClient = client(guestRoom);
    let physics, snapshots;
    try {
      await until(() => statuses.some(([seat, status]) => seat === 0 && status === 'connected') && statuses.some(([seat, status]) => seat === 1 && status === 'connected'));
      guestClient.sendInput(1, 0);
      later(() => guestClient.sendInput(2, 2), 20);
      later(() => guestClient.sendInput(3, 0), 80);
      physics = setInterval(() => { engine.step(world, fixture.spec, [0, mask], 1 / 60); }, 1000 / 60);
      snapshots = setInterval(() => hostClient.sendState(++production, engine.snapshot(world)), 100);
      await until(() => controls.some(value => value.seq >= 3));
      assert.ok(controls.some(value => value.mask & 2 || value.pressedMask & 2), 'a 60 ms tap survives an outstanding ACK and reaches the real host client');
      assert.equal(controls.at(-1).mask, 0, 'the newest release reaches the host');
      await pause(1600);
      assert.ok(received.length >= 12, `delayed ACKs must not collapse the 10 Hz snapshot stream: ${received.length} snapshots`);
      assert.ok(received.every((value, index) => index === 0 || value.seq > received[index - 1].seq));
      assert.equal(statuses.some(([, status]) => ['ended', 'expired', 'reconnecting'].includes(status)), false, 'supported latency keeps the same room connected');
      console.log(`PASS: actual connectMultiplayer clients over real loopback WebSockets preserved a 60 ms tap/release and received ${received.length} host snapshots with 80 ms each-way delay and 400 ms additional ACK delay.`);
    } finally {
      clearInterval(physics); clearInterval(snapshots); for (const value of clients) value.close(); for (const timer of timers) clearTimeout(timer);
      assert.equal((await request(`/multiplayer/rooms/${rawHost.roomId}`, 'DELETE', { hostToken: rawHost.hostToken })).status, 200);
    }
  }
  try {
    const host = connect(created.hostToken), second = connect(guest.guestToken);
    const legacyReady = await host.until(m => m.type === 'ready'); assert.equal(legacyReady.seat, 0); assert.equal(legacyReady.expiresAt, created.expiresAt); assert.equal((await second.until(m => m.type === 'ready')).seat, 1);
    await Promise.all([host.until(m => m.type === 'peer' && m.connected), second.until(m => m.type === 'peer' && m.connected)]);
    host.send({ type: 'ping' }); assert.deepEqual(await host.until(m => m.type === 'pong'), { type: 'pong' });
    assert.equal(host.observed().some(message => message.type === 'lease'), false, 'old socket admission must not receive an unfamiliar lease frame');
    assert.equal(host.observed().some(message => message.type === 'ack'), false, 'old socket admission must not receive unfamiliar acknowledgments');
    assert.equal((await lobby()).some(room => room.roomId === created.roomId), false, 'default private rooms must never be advertised');
    const engine = createCooperativeEngine(), state = engine.create(fixture.spec); state.running = true; state.paused = false;
    host.send({ type: 'state', seq: 1, state: engine.snapshot(state) });
    assert.deepEqual((await second.until(m => m.type === 'state' && m.seq === 1)).state.players, engine.snapshot(state).players);
    second.send({ type: 'input', seq: 1, mask: 2 }); assert.equal((await host.until(m => m.type === 'input')).mask, 2);
    const positions = state.players.map(player => player.x);
    engine.step(state, fixture.spec, [1, 2], 1 / 20); host.send({ type: 'state', seq: 2, state: engine.snapshot(state) });
    const advanced = (await second.until(m => m.type === 'state' && m.seq === 2)).state;
    assert.ok(advanced.players[0].x < positions[0]); assert.ok(advanced.players[1].x > positions[1]); assert.equal(advanced.elapsed, 0.05);
    // Place two pickups in this disposable fixture to exercise collection and
    // projectile effects over the real relay without waiting for random drops.
    assert.equal(fixture.spec.version, 6); assert.equal(fixture.spec.asteroids.endless, true); assert.ok(state.powerUps);
    state.powerUps.pickups.push({ id: state.nextId++, type: 'shield', x: state.players[0].x, y: state.players[0].y, ttl: 12 });
    engine.step(state, fixture.spec, [0, 0], 1 / 20);
    host.send({ type: 'state', seq: 3, state: engine.snapshot(state) });
    const shielded = (await second.until(m => m.type === 'state' && m.seq === 3)).state;
    assert.equal(shielded.players[0].effects.shield, 1); assert.equal(shielded.players[1].effects.shield, 0);
    assert.equal(shielded.powerUps.pickups.some(pickup => pickup.type === 'shield'), false);
    state.powerUps.pickups.push({ id: state.nextId++, type: 'triple-shot', x: state.players[1].x, y: state.players[1].y, ttl: 12 });
    engine.step(state, fixture.spec, [0, 0], 1 / 20);
    engine.step(state, fixture.spec, [0, 32], 1 / 20);
    host.send({ type: 'state', seq: 4, state: engine.snapshot(state) });
    const armed = (await second.until(m => m.type === 'state' && m.seq === 4)).state;
    assert.ok(armed.players[1].effects.tripleShot > 0); assert.equal(armed.players[0].effects.tripleShot, 0);
    assert.equal(armed.players[0].effects.shield, 1); assert.equal(armed.players[1].effects.shield, 0);
    assert.equal(armed.bullets.filter(bullet => bullet.owner === 1).length, 3); assert.equal(armed.bullets.filter(bullet => bullet.owner === 0).length, 0);
    assert.deepEqual(armed, engine.snapshot(state));
    assert.equal(host.observed().some(message => message.type === 'ack'), false); assert.equal(second.observed().some(message => message.type === 'ack'), false);
    host.clear(); second.socket.close(1000); await host.until(m => m.type === 'peer' && !m.connected);
    assert.equal((await request(`/multiplayer/rooms/${created.roomId}`, 'DELETE', { hostToken: created.hostToken })).status, 200);
    await host.until(m => m.type === 'closed');

    await delayedClientRehearsal();

    const publicResponse = await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision, visibility: 'public' });
    assert.equal(publicResponse.status, 200); const publicRoom = await publicResponse.json();
    assert.equal((await lobby()).some(room => room.roomId === publicRoom.roomId), false, 'a public room needs a live host before listing');
    const publicHost = connect(publicRoom.hostToken, publicRoom, true, true); await publicHost.until(m => m.type === 'ready');
    const listing = (await lobby()).find(room => room.roomId === publicRoom.roomId); assert.ok(listing);
    assert.deepEqual(Object.keys(listing).sort(), ['expiresAt', 'gameId', 'publishedRevision', 'roomId', 'specSha256', 'title']);
    assert.equal(listing.title, fixture.spec.title); assert.equal(listing.specSha256, binding.spec_sha256);
    const listedJSON = JSON.stringify(listing); for (const capability of [publicRoom.hostToken, publicRoom.inviteToken, created.hostToken, created.inviteToken, guest.guestToken]) assert.equal(listedJSON.includes(capability), false);
    assert.equal((await request('/multiplayer/lobby', 'GET', undefined, 'https://unapproved.example.test')).status, 403);
    const otherResponse = await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision, visibility: 'public' }); assert.equal(otherResponse.status, 200); const otherRoom = await otherResponse.json();
    assert.notEqual(otherRoom.roomId, publicRoom.roomId, 'a second public room must return its own new identity while another host is waiting');
    assert.equal((await lobby()).some(room => room.roomId === otherRoom.roomId), false);
    assert.equal((await request(`/multiplayer/rooms/${otherRoom.roomId}`, 'DELETE', { hostToken: otherRoom.hostToken })).status, 200);
    const publicBinding = { gameId: binding.game_id, publishedRevision: binding.published_revision, specSha256: binding.spec_sha256 };
    // Both admission paths contend for the same one guest seat.
    const racing = await Promise.all([
      request(`/multiplayer/rooms/${publicRoom.roomId}/lobby-join`, 'POST', publicBinding),
      request(`/multiplayer/rooms/${publicRoom.roomId}/join`, 'POST', { ...publicBinding, inviteToken: publicRoom.inviteToken }),
    ]);
    assert.equal(racing.filter(response => response.status === 200).length, 1);
    assert.ok(racing.filter(response => response.status !== 200).every(response => [403, 409].includes(response.status)));
    const admittedGuest = await racing.find(response => response.status === 200).json();
    assert.equal((await lobby()).some(room => room.roomId === publicRoom.roomId), false, 'claiming a guest seat removes its public listing');
    const publicGuest = connect(admittedGuest.guestToken, publicRoom, true, true); await publicGuest.until(m => m.type === 'ready');
    await Promise.all([publicHost.until(m => m.type === 'peer' && m.connected), publicGuest.until(m => m.type === 'peer' && m.connected)]);
    let virtualNow = 0, lastLease = publicRoom.expiresAt;
    for (let step = 0; step < 65; step++) {
      const clockResponse = await request('/__multiplayer-preview/advance-clock', 'POST', { seconds: 30 }); assert.equal(clockResponse.status, 200); virtualNow = (await clockResponse.json()).now;
      publicHost.clear(); publicGuest.clear(); publicHost.send({ type: 'ping' }); publicGuest.send({ type: 'ping' });
      await Promise.all([publicHost.until(m => m.type === 'pong'), publicGuest.until(m => m.type === 'pong')]);
      const [hostLease, guestLease] = await Promise.all([publicHost.until(m => m.type === 'lease' && m.expiresAt > lastLease), publicGuest.until(m => m.type === 'lease' && m.expiresAt > lastLease)]);
      assert.ok(hostLease.expiresAt > virtualNow && guestLease.expiresAt > virtualNow); lastLease = Math.min(hostLease.expiresAt, guestLease.expiresAt);
      assert.equal(publicHost.observed().some(message => message.type === 'ack'), false); assert.equal(publicGuest.observed().some(message => message.type === 'ack'), false, 'lease heartbeats never acknowledge a gameplay packet');
    }
    assert.ok(virtualNow > publicRoom.expiresAt, 'active relay use must cross the original 30-minute deadline');
    publicHost.send({ type: 'state', seq: 1, state: engine.snapshot(state) });
    assert.deepEqual((await publicGuest.until(m => m.type === 'state' && m.seq === 1)).state, engine.snapshot(state), 'the same room still relays its retained world after renewal');
    assert.deepEqual(await publicHost.until(m => m.type === 'ack' && m.kind === 'state' && m.seq === 1), { type: 'ack', kind: 'state', seq: 1 });
    publicHost.clear(); publicGuest.clear();
    publicHost.send({ type: 'state', seq: 1, state: engine.snapshot(state) });
    assert.deepEqual(await publicHost.until(m => m.type === 'ack' && m.seq === 1), { type: 'ack', kind: 'state', seq: 1 });
    assert.equal(publicGuest.observed().some(message => message.type === 'state'), false, 'duplicate retry acknowledges the committed packet without re-forwarding');
    publicGuest.send({ type: 'input', seq: 1, mask: 2 });
    assert.deepEqual(await publicHost.until(m => m.type === 'input' && m.seq === 1), { type: 'input', seq: 1, mask: 2 });
    assert.deepEqual(await publicGuest.until(m => m.type === 'ack' && m.kind === 'input' && m.seq === 1), { type: 'ack', kind: 'input', seq: 1 });
    assert.equal((await request(`/multiplayer/rooms/${publicRoom.roomId}`, 'DELETE', { hostToken: publicRoom.hostToken })).status, 200);
    await Promise.all([publicHost.until(m => m.type === 'closed'), publicGuest.until(m => m.type === 'closed')]);
    assert.equal((await lobby()).some(room => room.roomId === publicRoom.roomId), false);

    const absentResponse = await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision, visibility: 'public' }); assert.equal(absentResponse.status, 200); const absentRoom = await absentResponse.json();
    const absentHost = connect(absentRoom.hostToken, absentRoom, true); await absentHost.until(m => m.type === 'ready');
    assert.ok((await lobby()).some(room => room.roomId === absentRoom.roomId));
    await new Promise(resolve => { absentHost.socket.once('close', resolve); absentHost.socket.close(1000); });
    // The HTTP request queues behind the real socket disconnect in the adapter.
    assert.equal((await lobby()).some(room => room.roomId === absentRoom.roomId), false, 'a disconnected host cannot advertise an available seat');
    assert.equal((await request(`/multiplayer/rooms/${absentRoom.roomId}`, 'DELETE', { hostToken: absentRoom.hostToken })).status, 200);
    console.log('PASS: real WebSockets preserved legacy admission without new frames, relayed separate controls/shared prizes, acknowledged opted-in committed state/input and duplicate retry without duplicate forwarding; private rooms stayed hidden, public joins admitted one guest, filled/disconnected/closed rooms vanished, and renewal preserved the same room/world beyond its original 30-minute deadline. Synthetic in-memory backend only.');
  } finally { for (const socket of sockets) socket.close(1000); }

}
try { await startOwned(); await check(); }
finally { await stopOwned(); }
