/** Loopback-only two-browser rehearsal. All room logic runs in the real Python
 * relay against synthetic in-memory AWS ports; no production service is used. */
import { createServer as createHTTPServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.MULTIPLAYER_PREVIEW_PORT || 8096);
const relayPort = Number(process.env.MULTIPLAYER_PREVIEW_RELAY_PORT || 8097);
if (![port, relayPort].every(value => Number.isInteger(value) && value > 1024 && value < 65536) || port === relayPort || process.env.NODE_ENV === 'production') throw new Error('This rehearsal requires two distinct local development ports.');
const origin = `http://127.0.0.1:${port}`, relayOrigin = `http://127.0.0.1:${relayPort}`;
process.env.VITE_APP_MODE = 'local';
process.env.VITE_MULTIPLAYER_API_URL = relayOrigin;
const python = spawn(process.env.MULTIPLAYER_PREVIEW_PYTHON || 'python3', [resolve(root, 'scripts/multiplayer-preview-backend.py'), origin, `ws://127.0.0.1:${relayPort}/live`], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = [];
let readyResolve, readyReject;
const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
const sockets = new Map();
let httpServer, vite;
const lines = createInterface({ input: python.stdout });
lines.on('line', line => {
  let value; try { value = JSON.parse(line); } catch { readyReject(new Error('The preview backend returned invalid output.')); return; }
  if (value.ready) { readyResolve(value.game); return; }
  for (const message of value.outgoing || []) { const socket = sockets.get(message.connectionId); if (socket?.readyState === 1) socket.send(JSON.stringify(message.message)); }
  for (const id of value.closures || []) sockets.get(id)?.close(1000);
  pending.shift()?.resolve(value);
});
python.on('exit', () => { readyReject(new Error('The local backend stopped.')); while (pending.length) pending.shift().reject(new Error('The local backend stopped.')); });
function dispatch(command) { return new Promise((resolveValue, reject) => { pending.push({ resolve: resolveValue, reject }); python.stdin.write(`${JSON.stringify(command)}\n`); }); }
function headers(request, response) { if (request.headers.origin === origin) response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
try {
  const fixture = await ready;
  httpServer = createHTTPServer(async (request, response) => {
    headers(request, response);
    if (request.method === 'OPTIONS') { response.writeHead(request.headers.origin === origin ? 204 : 403); response.end(); return; }
    if (request.method === 'GET' && request.url === '/health') { response.setHeader('Content-Type', 'application/json'); response.end('{"status":"ok","mode":"synthetic-preview"}'); return; }
    const clock = request.method === 'POST' && request.url === '/__multiplayer-preview/advance-clock';
    const lobby = request.method === 'GET' && request.url === '/multiplayer/lobby';
    const room = request.method === 'POST' && /^\/multiplayer\/rooms(?:\/[0-9a-f-]{36}\/(?:join|lobby-join))?$/.test(request.url || '') || request.method === 'DELETE' && /^\/multiplayer\/rooms\/[0-9a-f-]{36}$/.test(request.url || '');
    if (!clock && !lobby && !room) { response.writeHead(404); response.end(); return; }
    if (clock && request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
    let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 2048) { response.writeHead(413); response.end(); return; } }
    try { const body = raw ? JSON.parse(raw) : {}; const command = clock ? { kind: 'advance-clock', seconds: body.seconds } : { kind: 'http', method: request.method, path: request.url, body, origin: request.headers.origin || '' }; const result = await dispatch(command); response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result.result)); }
    catch { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"Invalid local request."}'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 28672, perMessageDeflate: false });
  httpServer.on('upgrade', (request, socket, head) => { if (request.url !== '/live' || request.headers.origin !== origin) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; } wss.handleUpgrade(request, socket, head, webSocket => wss.emit('connection', webSocket, request)); });
  wss.on('connection', async (socket, request) => {
    const connectionId = randomUUID(); sockets.set(connectionId, socket);
    const connected = dispatch({ kind: 'socket', route: '$connect', connectionId, origin: request.headers.origin });
    socket.on('message', async (bytes, binary) => { if (binary) { socket.close(1008); return; } try { await connected; await dispatch({ kind: 'socket', route: '$default', connectionId, origin: request.headers.origin, body: JSON.parse(bytes.toString()) }); } catch { socket.close(1008); } });
    socket.on('close', () => { sockets.delete(connectionId); void dispatch({ kind: 'socket', route: '$disconnect', connectionId, origin: request.headers.origin }).catch(() => {}); });
    const accepted = await connected; if (accepted.status !== 200) socket.close(1008);
  });
  await new Promise((accept, reject) => { httpServer.once('error', reject); httpServer.listen(relayPort, '127.0.0.1', accept); });
  vite = await createViteServer({ root, mode: 'preview', server: { host: '127.0.0.1', port, strictPort: true }, plugins: [{ name: 'synthetic-multiplayer-fixture', configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url === '/__multiplayer-fixture.json') { response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(fixture)); return; }
    if (request.url !== '/__multiplayer-fixture') { next(); return; }
    const fixtureJSON = JSON.stringify(fixture).replaceAll('<', '\\u003c');
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    response.end(`<!doctype html><meta charset="utf-8"><title>Synthetic multiplayer rehearsal</title><p>Loading a synthetic local game. No cloud services or real accounts are used.</p><script>const game=${fixtureJSON};const key='game-studio-games:v1';const state=JSON.parse(localStorage.getItem(key)||'null')||{config:{version:1,revision:0,creationEnabled:true,assistantModeId:''},drafts:[],published:[],receipts:{},prompts:{},deleted:[]};state.published=[game,...state.published.filter(item=>item.id!==game.id)];localStorage.setItem(key,JSON.stringify(state));location.replace('/games/'+game.id);</script>`);
  }); } }] });
  await vite.listen();
  console.log(`Synthetic multiplayer rehearsal: ${origin}/__multiplayer-fixture`);
  console.log(`Real Python relay logic: ${relayOrigin}; transient in-memory storage only.`);
  console.log('Open the fixture in two sessions, choose cooperative play, create a room, and paste its invitation into the second session. Ctrl+C removes every local room.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Local rehearsal failed.'); for (const socket of sockets.values()) socket.close(1000); await vite?.close(); httpServer?.close(); python.kill(); process.exitCode = 1; }
async function close() { for (const socket of sockets.values()) socket.close(1000); await vite?.close(); httpServer?.close(); python.kill(); process.exit(0); }
process.once('SIGINT', close); process.once('SIGTERM', close);
