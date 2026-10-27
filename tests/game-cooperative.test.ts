import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { defaultGameSpec, designArcadeGame, getGameLevels, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { createGameEngine } from '../src/lib/game-runtime.ts';
import { cooperativeGameSandboxDocument, createCooperativeEngine, startCooperativeSandbox, validateCooperativeState, type CooperativeState } from '../src/lib/game-cooperative.ts';
import type { CooperativeGameSpec } from '../src/lib/game-types.ts';

function game(genre: 'collect' | 'dodge' | 'platformer' = 'dodge'): CooperativeGameSpec {
  const planned = planGameLevels({ ...defaultGameSpec(), genre, rules: { goal: 3, timeLimit: 60, lives: 3, difficulty: 1 }, ...(genre === 'dodge' ? { arcade: { rotation: false, shooting: true, splitAsteroids: true, scoring: true, highScores: true } } : {}) }, 2, 'synthetic cooperative campaign');
  return validateArcadeGameSpec({ ...planned, version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } }) as CooperativeGameSpec;
}
function active(state: CooperativeState) { state.running = true; state.paused = false; state.entities = []; state.nextSnack = 1; state.nextHazard = 1; return state; }
const snack = (id: number, x: number, y: number) => ({ id, kind: 'snack' as const, x, y, w: 22, h: 22, vx: 0, vy: 0 });

test('cooperation is opt-in version 4 and validates exact mode, count, and complete saved levels', () => {
  assert.equal(defaultGameSpec().version, 1);
  const spec = game(); assert.deepEqual(validateArcadeGameSpec(spec), spec);
  for (const edit of [{ multiplayer: { mode: 'competitive', maxPlayers: 2 } }, { multiplayer: { mode: 'cooperative', maxPlayers: 3 } }, { multiplayer: { mode: 'cooperative', maxPlayers: 2, chat: true } }, { levels: [] }, { version: 2 }]) assert.throws(() => validateArcadeGameSpec({ ...spec, ...edit }));
  const { multiplayer: _multiplayer, ...without } = spec; assert.throws(() => validateArcadeGameSpec(without));
});

test('authoring refinements and level planning preserve optional cooperation and authored seeds', () => {
  const spec = game(), seeds = spec.levels.map(level => level.seed);
  for (const message of ['Title: Twin explorers', 'Level 2 harder', 'Collect 7', '4 levels', 'shuffle layouts']) {
    const updated = designArcadeGame(message, spec).spec;
    assert.equal(updated.version, 4); assert.deepEqual(updated.multiplayer, spec.multiplayer);
    if (message !== 'shuffle layouts') assert.deepEqual(updated.levels!.slice(0, 2).map(level => level.seed), seeds);
  }
  assert.equal(designArcadeGame('disable multiplayer', spec).spec.version, 2);
  assert.equal(designArcadeGame('add two-player cooperation', defaultGameSpec()).spec.version, 4);
  assert.deepEqual(getGameLevels(spec), spec.levels);
  assert.deepEqual(createGameEngine().getLevels(spec), spec.levels);
});

test('browser and API preserve identical cooperative refinements and explicit disable', () => {
  const spec = game();
  const cases = ['Title: Twin explorers', 'Level 2 harder', 'Collect 7', '4 levels', 'shuffle layouts', 'disable multiplayer'].map(message => ({ message, current: spec }));
  const python = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('coop_parity',Path.cwd()/'backend/nce_api/games.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps([m.design_game(c['message'],c['current']) for c in json.load(sys.stdin)],ensure_ascii=False))`;
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify(cases), encoding: 'utf8' }));
  cases.forEach((entry, index) => assert.deepEqual(actual[index], designArcadeGame(entry.message, spec), entry.message));
});

test('one simulation moves each player independently and advances the shared clock once', () => {
  const spec = game(), engine = createCooperativeEngine(), state = active(engine.create(spec));
  const before = state.players.map(player => player.x);
  engine.step(state, spec, [1, 2], 1 / 60);
  assert.ok(state.players[0].x < before[0]); assert.ok(state.players[1].x > before[1]); assert.equal(state.elapsed, 1 / 60);
  assert.notEqual(state.players[0], state.players[1]);
  state.paused = true; const paused = structuredClone(state); engine.step(state, spec, [63, 63], 1); assert.deepEqual(state, paused);
});

test('shared collectibles are consumed once, belong to one player, and cannot inflate a completed goal', () => {
  const spec = game(), engine = createCooperativeEngine(), state = active(engine.create(spec));
  state.players[1].x = state.players[0].x;
  state.entities = [snack(100, state.players[0].x, state.players[0].y)];
  engine.step(state, spec, [0, 0], 1 / 60);
  assert.equal(state.players.reduce((sum, p) => sum + p.score, 0), 1); assert.equal(state.entities.length, 0);
  assert.equal(state.players.reduce((sum, p) => sum + p.points, 0), 10);
  state.players[0].score = spec.levels[0].rules.goal;
  state.players[1].score = 0; state.entities = [snack(101, state.players[0].x, state.players[0].y)];
  engine.step(state, spec, [0, 0], 1 / 60); assert.equal(state.players[1].score, 1); assert.equal(state.players[0].score, 3);
});

test('both personal goals are required to win, with independent lives and a common deadline', () => {
  const spec = game(), engine = createCooperativeEngine(), state = active(engine.create(spec));
  state.players[0].score = 3; engine.step(state, spec, [0, 0], 1 / 60); assert.equal(state.outcome, 'playing');
  state.players[1].score = 3; engine.step(state, spec, [0, 0], 1 / 60); assert.equal(state.outcome, 'won');
  const deadline = active(engine.create(spec)); deadline.elapsed = 59.99; engine.step(deadline, spec, [0, 0], 1 / 20); assert.equal(deadline.outcome, 'lost');
  const dead = active(engine.create(spec)); dead.players[0].lives = 0; engine.step(dead, spec, [2, 2], 1 / 60); assert.equal(dead.outcome, 'playing'); assert.equal(dead.players[0].x, 350);
  dead.players[1].lives = 0; engine.step(dead, spec, [0, 0], 1 / 60); assert.equal(dead.outcome, 'lost');
});

test('shots retain their owner, award only that player, split once, and never hit friendly ships', () => {
  const spec = game(), engine = createCooperativeEngine(), state = active(engine.create(spec)); state.nextId = 100;
  state.entities = [{ id: 50, kind: 'hazard', asteroid: 'large', x: 350, y: 290, w: 42, h: 42, vx: 0, vy: 0 }];
  state.bullets = [{ id: 60, owner: 1, x: 340, y: 310, vx: 620, vy: 0, ttl: 1 }, { id: 61, owner: 0, x: 340, y: 310, vx: 620, vy: 0, ttl: 1 }];
  engine.step(state, spec, [0, 0], 1 / 20);
  assert.deepEqual(state.players.map(p => p.points), [0, 20]); assert.equal(state.entities.length, 2); assert.ok(state.entities.every(e => e.asteroid === 'small'));
  state.entities = []; state.players.forEach(p => { p.invulnerable = 0; });
  state.bullets = [{ id: 70, owner: 1, x: state.players[0].x + 10, y: state.players[0].y + 10, vx: 0, vy: 0, ttl: 1 }];
  engine.step(state, spec, [0, 0], 1 / 60); assert.deepEqual(state.players.map(p => p.lives), [3, 3]);
});

test('all supported arcade styles share a seeded world with independent motion', () => {
  const engine = createCooperativeEngine();
  for (const genre of ['collect', 'platformer', 'dodge'] as const) {
    const spec = game(genre), a = active(engine.create(spec)), b = active(engine.create(spec));
    for (let tick = 0; tick < 120; tick++) { engine.step(a, spec, [2 | 16, 1], 1 / 60); engine.step(b, spec, [2 | 16, 1], 1 / 60); }
    assert.deepEqual(a, b); assert.notEqual(a.players[0].x, a.players[1].x); assert.ok(validateCooperativeState(engine.snapshot(a), spec), genre);
    assert.equal(engine.create(spec, 1).levelIndex, 1);
  }
});

test('snapshots reject arbitrary payloads, impossible outcomes, excess entities, duplicate IDs and nonfinite coordinates', () => {
  const engine = createCooperativeEngine(), spec = game(), state = engine.snapshot(engine.create(spec));
  assert.deepEqual(validateCooperativeState(state, spec), state);
  for (const edit of [{ extra: 'chat' }, { levelIndex: 99 }, { elapsed: Infinity }, { running: 'true' }, { outcome: 'won' }, { platforms: [{ x: 0, y: 500, w: 960, h: 40, html: 'bad' }] }, { entities: Array.from({ length: 97 }, (_, i) => snack(i + 1, 30, 30)) }, { bullets: [{ id: 1, owner: 3, x: 20, y: 20, vx: 0, vy: 0, ttl: 1 }] }]) assert.equal(validateCooperativeState({ ...state, ...edit }, spec), undefined);
  const duplicate = { ...state, entities: [snack(20, 50, 50), snack(20, 60, 60)] }; assert.equal(validateCooperativeState(duplicate, spec), undefined);
  const invalid = structuredClone(state); invalid.players[1].x = Number.NaN; assert.equal(validateCooperativeState(invalid, spec), undefined);
  const copy = validateCooperativeState(state, spec)!; copy.players[0].x = 1; assert.notEqual(state.players[0].x, 1);
});

test('bounded long runs produce finite relay snapshots below 24KB and cap projectiles per player', () => {
  const engine = createCooperativeEngine(), spec = game(), state = active(engine.create(spec));
  let maxShots = 0;
  for (let tick = 0; tick < 3600 && state.outcome === 'playing'; tick++) {
    engine.step(state, spec, [32 | (tick % 120 < 60 ? 1 : 2), 32 | (tick % 120 < 60 ? 2 : 1)], 1 / 60);
    const snapshot = engine.snapshot(state); assert.ok(validateCooperativeState(snapshot, spec), `tick ${tick}`); assert.ok(JSON.stringify(snapshot).length <= 24000);
    maxShots = Math.max(maxShots, state.bullets.length); assert.ok(state.entities.length <= 96);
  }
  assert.ok(maxShots > 1 && maxShots <= 32);
});

test('fixed cooperative sandbox serializes tested functions, denies network and cannot emit solo result events', () => {
  const html = cooperativeGameSandboxDocument('synthetic_multiplayer_12345');
  assert.match(html, /connect-src 'none'/); assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /axolotl-game-result|fetch\(|WebSocket|RTCPeerConnection/);
  const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)![1]; assert.doesNotThrow(() => new Script(script));
  assert.throws(() => cooperativeGameSandboxDocument('<script>'));
});

function sandboxHarness(seat: 0 | 1) {
  type Element = { textContent: string; disabled: boolean; hidden: boolean; handlers: Record<string, () => void>; addEventListener(name: string, fn: () => void): void; focus(): void; getContext(): unknown };
  const spec = game(), elements = new Map<string, Element>(), messages: { type: string; seq?: number; mask?: number; state?: CooperativeState }[] = [], frames: ((now: number) => void)[] = [], listeners: Record<string, (value: unknown) => void> = {};
  const getElement = (id: string) => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, hidden: false, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, focus() {}, getContext: () => new Proxy({}, { get: () => () => {} }) }); return elements.get(id)!; };
  const parent = { postMessage(value: typeof messages[number]) { messages.push(structuredClone(value)); } };
  const document = { hidden: false, getElementById: getElement, querySelectorAll: () => [], addEventListener(name: string, fn: typeof listeners[string]) { listeners[`document:${name}`] = fn; } };
  new Script(`const __name = fn => fn; (${startCooperativeSandbox.toString()})(engine, validate, validateState, '1234567890abcdef');`).runInNewContext({
    engine: createCooperativeEngine(), validate: validateArcadeGameSpec, validateState: validateCooperativeState, structuredClone, parent,
    document,
    window: { addEventListener(name: string, fn: typeof listeners[string]) { listeners[name] = fn; } }, requestAnimationFrame(fn: (now: number) => void) { frames.push(fn); },
  });
  const send = (data: unknown, source: unknown = parent) => listeners.message({ source, data: { nonce: '1234567890abcdef', ...(data as object) } });
  send({ type: 'game-coop-load', spec, seat }); let clock = 1000;
  return { spec, elements, messages, send, blur: () => listeners.blur({}), visibility(hidden: boolean) { document.hidden = hidden; listeners['document:visibilitychange']({}); }, click: (id: string) => getElement(id).handlers.click(), key: (key: string) => listeners['document:keydown']({ key, target: { tagName: 'CANVAS' }, preventDefault() {} }), tick(count = 1) { for (let i = 0; i < count; i++) frames.shift()!(clock += 1000 / 60); } };
}

test('host bridge waits for the second seat, rejects stale or extra-field input, and pauses across reconnect', () => {
  const h = sandboxHarness(0); h.click('start'); h.tick(8); assert.equal(h.messages.some(m => m.state), false);
  h.send({ type: 'game-coop-peer', connected: true }); h.click('start');
  const initial = h.messages.at(-1)!.state!; assert.equal(initial.running, true); assert.equal(initial.paused, false);
  h.send({ type: 'game-coop-input', seq: 1, mask: 2 }); h.tick(8);
  const moved = h.messages.at(-1)!.state!; assert.equal(moved.players[0].x, initial.players[0].x); assert.ok(moved.players[1].x > initial.players[1].x);
  h.send({ type: 'game-coop-input', seq: 1, mask: 1 }); h.tick(8); assert.ok(h.messages.at(-1)!.state!.players[1].x > moved.players[1].x);
  h.send({ type: 'game-coop-input', seq: 2, mask: 1, html: 'extra' }); h.tick(8); assert.ok(h.messages.at(-1)!.state!.players[1].x > moved.players[1].x);
  h.send({ type: 'game-coop-peer', connected: false }); const paused = h.messages.at(-1)!.state!; assert.equal(paused.paused, true);
  h.send({ type: 'game-coop-peer', connected: true }); h.tick(8); assert.equal(h.messages.at(-1)!.state!.paused, true);
  h.click('pause'); h.tick(8); assert.equal(h.messages.at(-1)!.state!.players[1].x, paused.players[1].x);
});

test('guest cannot start, emits only local input and accepts bounded fresh host snapshots', () => {
  const h = sandboxHarness(1), state = createCooperativeEngine().create(h.spec); h.send({ type: 'game-coop-peer', connected: true });
  h.click('start'); h.tick(2); assert.equal(h.messages.some(m => m.state), false); assert.equal(h.elements.get('start')!.hidden, true);
  h.key('ArrowLeft'); h.tick(); assert.equal(h.messages.at(-1)!.type, 'game-coop-input'); assert.equal(h.messages.at(-1)!.mask, 1);
  state.players[1].score = 2; h.send({ type: 'game-coop-state', seq: 10, state }); h.tick(); assert.match(h.elements.get('player-2')!.textContent, /2\/3 goal/);
  const earlier = structuredClone(state); earlier.players[1].score = 1;
  h.send({ type: 'game-coop-state', seq: 9, state: earlier }); h.tick(); assert.match(h.elements.get('player-2')!.textContent, /2\/3 goal/);
  h.send({ type: 'game-coop-state', seq: 11, state: { ...state, extra: 'chat' } }); h.tick(); assert.match(h.elements.get('player-2')!.textContent, /2\/3 goal/);
  h.send({ type: 'game-coop-peer', connected: false }); h.send({ type: 'game-coop-peer', connected: true }); h.tick(8); assert.equal(h.messages.at(-1)!.mask, 0);
});

test('host backgrounding immediately publishes a pause before RAF suspension and requires an explicit resume', () => {
  const h = sandboxHarness(0); h.send({ type: 'game-coop-peer', connected: true }); h.click('start'); h.tick(8);
  h.blur(); h.tick(8); assert.equal(h.messages.at(-1)!.state!.paused, false);
  const count = h.messages.length; h.visibility(true);
  assert.equal(h.messages.length, count + 1); assert.equal(h.messages.at(-1)!.type, 'game-coop-state'); assert.equal(h.messages.at(-1)!.state!.paused, true);
  assert.match(h.elements.get('announce')!.textContent, /host game tab is in the background/);
  h.visibility(false); h.tick(8); assert.equal(h.messages.at(-1)!.state!.paused, true);
  h.click('pause'); h.tick(8); assert.equal(h.messages.at(-1)!.state!.paused, false);
  const guest = sandboxHarness(1); guest.send({ type: 'game-coop-peer', connected: true }); guest.key('ArrowRight'); guest.tick(2); assert.equal(guest.messages.at(-1)!.mask, 2);
  guest.visibility(true); assert.equal(guest.messages.at(-1)!.type, 'game-coop-input'); assert.equal(guest.messages.at(-1)!.mask, 0); assert.equal(guest.messages.some(m => m.state), false);
});
