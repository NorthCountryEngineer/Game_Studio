/** Standalone CI rehearsal using two real WebSocket clients and the real
 * Python relay against disposable synthetic state. --reuse uses an open preview. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createCooperativeEngine } from '../src/lib/game-cooperative.ts';
import { createPublicationBinding } from '../src/lib/game-scoring.ts';


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
      if (health.ok && fixture.ok && (await health.json()).mode === 'synthetic-preview' && (await fixture.json()).spec.version === 5) return;
    } catch { /* Local startup may need a brief retry. */ }
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error(`The isolated local preview did not become ready. ${serverOutput}`);
}
process.once('exit', () => killOwned('SIGTERM'));
async function check() {
  
  const fixture = await (await fetch(`${origin}/__multiplayer-fixture.json`, { signal: AbortSignal.timeout(3000) })).json();
  const binding = await createPublicationBinding(fixture);
  async function request(path, method, body, requestOrigin = origin) { return fetch(`${api}${path}`, { method, headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }); }
  const createdResponse = await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision }); assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  const joining = { inviteToken: created.inviteToken, gameId: binding.game_id, publishedRevision: binding.published_revision, specSha256: binding.spec_sha256 };
  const guestResponse = await request(`/multiplayer/rooms/${created.roomId}/join`, 'POST', joining); assert.equal(guestResponse.status, 200); const guest = await guestResponse.json();
  assert.equal((await request(`/multiplayer/rooms/${created.roomId}/join`, 'POST', joining)).status, 403);
  assert.equal((await request('/multiplayer/rooms', 'POST', { gameId: fixture.id, publishedRevision: fixture.publishedRevision }, 'https://unapproved.example.test')).status, 403);
  const sockets = [];
  function connect(token) {
    const socket = new WebSocket(created.socketUrl, { origin }); sockets.push(socket); const messages = [], waits = [];
    const receive = value => { messages.push(value); for (const wait of [...waits]) if (wait.predicate(value)) { clearTimeout(wait.timeout); waits.splice(waits.indexOf(wait), 1); wait.resolve(value); } };
    socket.on('error', () => {});
    socket.on('message', raw => receive(JSON.parse(raw.toString())));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'join', roomId: created.roomId, token })));
    const until = predicate => { const existing = messages.find(predicate); if (existing) return Promise.resolve(existing); return new Promise((resolve, reject) => { const wait = { predicate, resolve, timeout: setTimeout(() => reject(new Error('Timed out waiting for the local relay.')), 5000) }; waits.push(wait); }); };
    return { socket, until, clear: () => { messages.length = 0; }, send: value => socket.send(JSON.stringify(value)) };
  }
  try {
    const host = connect(created.hostToken), second = connect(guest.guestToken);
    assert.equal((await host.until(m => m.type === 'ready')).seat, 0); assert.equal((await second.until(m => m.type === 'ready')).seat, 1);
    await Promise.all([host.until(m => m.type === 'peer' && m.connected), second.until(m => m.type === 'peer' && m.connected)]);
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
    assert.equal(fixture.spec.version, 5); assert.ok(state.powerUps);
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
    host.clear(); second.socket.close(1000); await host.until(m => m.type === 'peer' && !m.connected);
    assert.equal((await request(`/multiplayer/rooms/${created.roomId}`, 'DELETE', { hostToken: created.hostToken })).status, 200);
    await host.until(m => m.type === 'closed');
    console.log('PASS: two real WebSockets admitted separate seats, relayed independent input, shared physics, a player-owned shield and three owner-tagged triple-shot projectiles, rejected a third join and unapproved origin, and notified disconnect/room closure. Synthetic in-memory backend only.');
  } finally { for (const socket of sockets) socket.close(1000); }

}
try { await startOwned(); await check(); }
finally { await stopOwned(); }
