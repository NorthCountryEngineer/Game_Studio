import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { defaultGameSpec, designArcadeGame, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { createCooperativeEngine, validateCooperativeState, type CooperativeState } from '../src/lib/game-cooperative.ts';

const nonce = 'production_sandbox_123456';
const match = { mode: 'versus' as const, lives: 2, timeLimit: 30 };
const solo = designArcadeGame('Asteroids with one level.', defaultGameSpec()).spec;
const cooperative = validateArcadeGameSpec({ ...solo, version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } });

function sandbox(html: string) {
  const elements = new Map<string, any>(), listeners: Record<string, ((event: any) => void)[]> = {}, messages: any[] = [], frames: ((now: number) => void)[] = [];
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: true, handlers: {} as Record<string, () => void>,
      addEventListener(name: string, fn: () => void) { this.handlers[name] = fn; }, setAttribute() {}, focus() {}, getContext: () => new Proxy({}, { get: () => () => {} }) });
    return elements.get(id);
  };
  const parent = { postMessage(value: unknown) { messages.push(structuredClone(value)); } };
  const context = createContext({ parent, structuredClone, listeners,
    document: { hidden: false, getElementById: element, querySelectorAll: () => [], addEventListener(name: string, fn: (event: any) => void) { (listeners['document:' + name] ??= []).push(fn); } },
    window: { addEventListener(name: string, fn: (event: any) => void) { (listeners[name] ??= []).push(fn); } },
    requestAnimationFrame(fn: (now: number) => void) { frames.push(fn); } });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1]; assert.ok(script);
  new Script(script).runInContext(context);
  let now = 1000;
  return { elements, messages,
    send(data: unknown) { context.wire = JSON.stringify({ nonce, ...(data as object) }); new Script('listeners.message.forEach(fn=>fn({source:parent,data:JSON.parse(wire)}))').runInContext(context); },
    click(id: string) { element(id).handlers.click(); },
    tick(count: number) { for (let index = 0; index < count; index++) frames.shift()!(now += 1000 / 60); } };
}

test('production-minified Vite output generates executable co-op and versus sandboxes with working validation and rematches', async () => {
  // Use the same Rollup + esbuild minifier pipeline as the production frontend.
  // Importing source functions misses renamed closed-over module identifiers.
  const built = await build({ configFile: false, publicDir: false, logLevel: 'silent', build: {
    write: false, minify: 'esbuild', lib: { entry: fileURLToPath(new URL('../src/lib/game-cooperative.ts', import.meta.url)), formats: ['es'], fileName: () => 'sandbox.js' },
  } });
  const output = (Array.isArray(built) ? built[0] : built) as { output: { type: string; code?: string }[] };
  const chunk = output.output.find(item => item.type === 'chunk'); assert.ok(chunk?.code);
  const bundle = await import('data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64'));
  const html = bundle.cooperativeGameSandboxDocument(nonce);
  assert.match(html, /connect-src 'none'/); assert.match(html, /script-src 'nonce-production_sandbox_123456'/);
  for (const settings of [undefined, match]) {
    const spec = settings ? solo : cooperative, host = sandbox(html), guest = sandbox(html);
    for (const [seat, instance] of [host, guest].entries()) {
      assert.equal(instance.messages.at(-1)?.type, 'game-coop-ready');
      instance.send({ type: 'game-coop-load', spec, seat, ...(settings ? { match: settings } : {}) });
      assert.equal(instance.messages.at(-1)?.type, 'game-coop-loaded', instance.elements.get('announce')?.textContent);
      instance.send({ type: 'game-coop-peer', connected: true });
    }
    host.click('start'); const initial = host.messages.at(-1).state as CooperativeState;
    assert.equal(initial.running, true); assert.ok(validateCooperativeState(initial, spec, settings));
    guest.send({ type: 'game-coop-state', seq: 1, state: initial });
    assert.match(guest.elements.get('player-2').textContent, settings ? /2 \/ 2 lives/ : /goal/);
    if (settings) {
      const engine = createCooperativeEngine(), terminal = engine.create(spec, 0, settings);
      terminal.running = true; terminal.paused = false; terminal.players[0].lives = 0;
      engine.step(terminal, spec, [0, 0], 1 / 60, settings);
      assert.equal(terminal.outcome, 'finished');
      guest.send({ type: 'game-coop-state', seq: 2, state: engine.snapshot(terminal) });
      assert.match(guest.elements.get('status').textContent, /Player 2 wins/);
      const malformed = structuredClone(terminal); malformed.versus!.winner = 0;
      guest.send({ type: 'game-coop-state', seq: 3, state: malformed });
      assert.match(guest.elements.get('status').textContent, /Player 2 wins/, 'A forged winner cannot replace the validated state.');
      // The minified host runs the real timer and reconstructs a fresh arena.
      host.tick(1900); assert.equal(host.messages.filter(item => item.state).at(-1).state.outcome, 'finished');
      host.send({ type: 'game-coop-peer', connected: false }); host.send({ type: 'game-coop-peer', connected: true });
      assert.equal(host.messages.at(-1).state.paused, false); assert.equal(host.elements.get('start').textContent, 'Rematch');
      host.click('start'); assert.deepEqual(host.messages.at(-1).state.versus, { winner: null, reason: null });
    }
    guest.click('start'); assert.equal(guest.messages.some(item => item.state), false, 'A guest cannot run the host simulation.');
  }
});
