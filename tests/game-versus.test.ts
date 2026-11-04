import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import { defaultGameSpec, defaultAsteroidSettings, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { createCooperativeEngine, createCooperativePresentation, cooperativeGameSandboxDocument, validateCooperativeState, type CooperativeState } from '../src/lib/game-cooperative.ts';
import { isVersusEligible, validateVersusMatch, type VersusMatch } from '../src/lib/game-versus.ts';
import type { ArcadeGameSpec } from '../src/lib/game-types.ts';

const match: VersusMatch = { mode: 'versus', lives: 3, timeLimit: 120 };
function game(version: 1 | 2 | 4 | 5 | 6 = 2): ArcadeGameSpec {
  const basic = { ...defaultGameSpec(), genre: 'dodge' as const, theme: 'space' as const, rules: { goal: 3, lives: 2, timeLimit: 30, difficulty: 2 }, arcade: { rotation: false, shooting: true, splitAsteroids: false, scoring: true, highScores: true } };
  const planned = planGameLevels(basic, 3, 'Preserved authored campaign');
  return validateArcadeGameSpec(version === 1 ? basic : { ...planned, version, ...(version === 4 ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 } } : {}), ...(version === 5 ? { powerUps: { spawnInterval: 15, duration: 10, types: ['shield', 'rapid-fire'] } } : {}), ...(version === 6 ? { asteroids: { ...defaultAsteroidSettings(), endless: true } } : {}) });
}
function active(state: CooperativeState) { state.running = true; state.paused = false; quiet(state); return state; }
function quiet(state: CooperativeState) { state.entities = []; state.nextSnack = 1; state.nextHazard = 1; if (state.advanced) { state.advanced.enemies = []; state.advanced.enemyBullets = []; state.advanced.nextEnemy = 5; } }
function bullet(state: CooperativeState, owner: 0 | 1, target: 0 | 1) {
  const player = state.players[target];
  state.bullets.push({ id: state.nextId++, owner, x: player.x + 10, y: player.y + 10, vx: 0, vy: 0, ttl: 1 });
}

test('versus match settings are strict and eligibility preserves every supported published Asteroids format', () => {
  assert.deepEqual(validateVersusMatch(match), match);
  for (const bad of [null, [], { ...match, mode: 'cooperative' }, { ...match, lives: 0 }, { ...match, lives: 6 }, { ...match, lives: 1.5 }, { ...match, timeLimit: 29 }, { ...match, timeLimit: 181 }, { ...match, timeLimit: Infinity }, { ...match, extra: true }]) assert.equal(validateVersusMatch(bad), undefined);
  for (const version of [1, 2, 4, 5, 6] as const) assert.equal(isVersusEligible(game(version)), true);
  assert.equal(isVersusEligible(defaultGameSpec()), false);
  assert.equal(isVersusEligible({ ...game(), flow: { version: 1, nodes: [{ id: 'step-1', type: 'level', levelId: 'level-1' }] } }), false);
});

test('versus creates only the first arena with room lives, opposing ships and no saved-spec mutation', () => {
  const engine = createCooperativeEngine();
  for (const version of [1, 2, 4, 5, 6] as const) {
    const spec = game(version), before = structuredClone(spec), state = engine.create(spec, 2, match);
    assert.equal(state.levelIndex, 0); assert.deepEqual(state.players.map(player => player.lives), [3, 3]);
    assert.deepEqual(state.players.map(player => [player.x, player.y, player.angle]), [[90, 253, 0], [828, 253, Math.PI]]);
    assert.deepEqual(state.versus, { winner: null, reason: null }); assert.deepEqual(spec, before);
    assert.ok(validateCooperativeState(engine.snapshot(state), spec, match), `version ${version}`);
  }
  assert.throws(() => engine.create(defaultGameSpec(), 0, match));
  assert.throws(() => engine.create(game(), 0, { ...match, lives: 99 }));
});

test('versus forces turning combat for nonrotating editions and prevents protected firing', () => {
  const engine = createCooperativeEngine();
  for (const version of [2, 6] as const) {
    const spec = game(version), state = active(engine.create(spec, 0, match));
    engine.step(state, spec, [32, 32], 1 / 60, match); assert.equal(state.bullets.length, 0);
    state.players.forEach(player => player.invulnerable = 0);
    const y = state.players[0].y; engine.step(state, spec, [4 | 32, 2 | 32], 1 / 60, match);
    assert.ok(state.players[0].x > 90); assert.equal(state.players[0].y, y); assert.ok(state.players[1].angle > Math.PI);
    assert.ok(state.bullets.find(item => item.owner === 0)!.vx > 600); assert.ok(state.bullets.find(item => item.owner === 1)!.vx < -600);
  }
});

test('direct shots lose one opposing life, reset position and boosts, respect shields and never hit their owner', () => {
  const engine = createCooperativeEngine();
  for (const version of [2, 5, 6] as const) {
    const spec = game(version), state = active(engine.create(spec, 0, match)); state.players.forEach(player => player.invulnerable = 0);
    state.players[1].x = 400; if (state.players[1].effects) state.players[1].effects.rapidFire = 7;
    bullet(state, 0, 1); engine.step(state, spec, [0, 0], 1 / 60, match);
    assert.equal(state.players[1].lives, 2); assert.equal(state.players[1].x, 828); assert.equal(state.players[1].invulnerable, 1.5); assert.equal(state.players[1].effects?.rapidFire ?? 0, 0);
    bullet(state, 0, 1); bullet(state, 0, 0); engine.step(state, spec, [32, 32], 1 / 60, match);
    assert.equal(state.players[1].lives, 2); assert.equal(state.players[0].lives, 3);
    if (state.players[1].effects) {
      state.bullets = []; state.players[1].effects.shield = 1; state.players[1].invulnerable = 0;
      bullet(state, 0, 1); engine.step(state, spec, [0, 0], 1 / 60, match);
      assert.equal(state.players[1].lives, 2); assert.equal(state.players[1].effects.shield, 0);
    }
  }
});

test('a nearer asteroid blocks a shot and a nearer ship is hit before the asteroid behind it', () => {
  const engine = createCooperativeEngine();
  for (const version of [2, 6] as const) {
    const spec = game(version), state = active(engine.create(spec, 0, match)); state.players.forEach(player => player.invulnerable = 0);
    state.players[1].x = 420; state.entities = [{ id: state.nextId++, kind: 'hazard', asteroid: 'large', x: 400, y: 250, w: 42, h: 42, vx: 0, vy: 0 }];
    state.bullets = [{ id: state.nextId++, owner: 0, x: 390, y: 265, vx: 1000, vy: 0, ttl: 1 }];
    engine.step(state, spec, [0, 0], 1 / 20, match); assert.equal(state.players[1].lives, 3); assert.equal(state.entities.length, 0);
    state.players[1].invulnerable = 0; state.players[1].x = 400;
    state.entities = [{ id: state.nextId++, kind: 'hazard', asteroid: 'large', x: 460, y: 250, w: 42, h: 42, vx: 0, vy: 0 }];
    state.bullets = [{ id: state.nextId++, owner: 0, x: 390, y: 265, vx: 1000, vy: 0, ttl: 1 }];
    engine.step(state, spec, [0, 0], 1 / 20, match); assert.equal(state.players[1].lives, 2); assert.equal(state.entities.length, 1);
  }
});

test('nearest shootable prizes and enemy ships shield a farther opponent without stealing another player\'s pickup', () => {
  const engine = createCooperativeEngine();
  const spec = validateArcadeGameSpec({ ...game(6), powerUps: game(5).powerUps, asteroids: { ...defaultAsteroidSettings(), enemies: { enabled: true, difficulty: 'hard', hitPoints: 1, spawnInterval: 15, maxShips: 2 } } });
  const state = active(engine.create(spec, 0, match)); state.players.forEach(player => player.invulnerable = 0); state.players[1].x = 420;
  state.powerUps!.pickups = [{ id: state.nextId++, type: 'shield', x: 390, y: 250, ttl: 10 }];
  state.bullets = [{ id: state.nextId++, owner: 0, x: 380, y: 265, vx: 1000, vy: 0, ttl: 1 }];
  engine.step(state, spec, [0, 0], 1 / 20, match);
  assert.equal(state.players[0].effects!.shield, 1); assert.equal(state.players[1].effects!.shield, 0); assert.equal(state.players[1].lives, 3); assert.equal(state.powerUps!.pickups.length, 0);
  state.advanced!.enemies = [{ id: state.nextId++, x: 390, y: 250, w: 38, h: 28, vx: 0, vy: 0, hp: 1, maxHp: 1, fireCooldown: 2, phase: 0 }];
  state.bullets = [{ id: state.nextId++, owner: 0, x: 380, y: 265, vx: 1000, vy: 0, ttl: 1 }];
  engine.step(state, spec, [0, 0], 1 / 20, match);
  assert.equal(state.advanced!.enemies.length, 0); assert.equal(state.players[1].lives, 3); assert.equal(state.players[0].points, 300);
});

test('simultaneous final projectile trades draw after the whole tick, and restart clears all results', () => {
  const engine = createCooperativeEngine(), oneLife = { ...match, lives: 1 };
  for (const version of [2, 6] as const) {
    const spec = game(version), state = active(engine.create(spec, 0, oneLife)); state.players.forEach(player => player.invulnerable = 0);
    bullet(state, 0, 1); bullet(state, 1, 0); engine.step(state, spec, [0, 0], 1 / 60, oneLife);
    assert.deepEqual(state.players.map(player => player.lives), [0, 0]); assert.equal(state.outcome, 'finished'); assert.equal(state.running, false); assert.equal(state.paused, false);
    assert.deepEqual(state.versus, { winner: 'draw', reason: 'elimination' }); assert.ok(validateCooperativeState(engine.snapshot(state), spec, oneLife));
    const ended = structuredClone(state); engine.step(state, spec, [32, 32], 1 / 60, oneLife); assert.deepEqual(state, ended);
    const restart = engine.create(spec, 0, oneLife); assert.equal(restart.elapsed, 0); assert.equal(restart.bullets.length, 0); assert.deepEqual(restart.versus, { winner: null, reason: null });
  }
});

test('time uses remaining lives only, ignores collection completion and ends original endless games', () => {
  const engine = createCooperativeEngine();
  for (const version of [1, 2, 6] as const) {
    const spec = game(version), state = active(engine.create(spec, 0, match)); state.players.forEach(player => player.score = 3);
    engine.step(state, spec, [0, 0], 1 / 60, match); assert.equal(state.outcome, 'playing');
    state.elapsed = 119.99; state.players[0].lives = 2; state.players[1].points = 1000;
    engine.step(state, spec, [0, 0], 1 / 20, match); assert.deepEqual(state.versus, { winner: 1, reason: 'time' });
    const draw = active(engine.create(spec, 0, match)); draw.elapsed = 119.99; draw.players[1].points = 1000;
    engine.step(draw, spec, [0, 0], 1 / 20, match); assert.deepEqual(draw.versus, { winner: 'draw', reason: 'time' }); assert.ok(validateCooperativeState(engine.snapshot(draw), spec, match));
    const near = active(engine.create(spec, 0, match)); near.elapsed = 119.9994;
    engine.step(near, spec, [0, 0], 0.0002, match); assert.equal(near.elapsed, 120); assert.ok(validateCooperativeState(engine.snapshot(near), spec, match));
  }
});

test('versus snapshots reject invented winners, early completion, changed limits and co-op terminal shapes', () => {
  const engine = createCooperativeEngine(), spec = game(), state = engine.snapshot(engine.create(spec, 0, match));
  for (const edit of [{ outcome: 'won' }, { versus: { winner: 0, reason: 'elimination' } }, { levelIndex: 1 }, { elapsed: 120 }, { extra: 'arbitrary' }]) assert.equal(validateCooperativeState({ ...state, ...edit }, spec, match), undefined);
  assert.equal(validateCooperativeState(state, spec), undefined);
  const ended = active(engine.create(spec, 0, match)); ended.players[1].lives = 0; engine.step(ended, spec, [0, 0], 1 / 60, match);
  assert.ok(validateCooperativeState(engine.snapshot(ended), spec, match));
  for (const edit of [{ running: true }, { paused: true }, { versus: { winner: 1, reason: 'elimination' } }, { versus: { winner: 0, reason: 'time' } }]) assert.equal(validateCooperativeState({ ...ended, ...edit }, spec, match), undefined);
  const tooMany = structuredClone(state); tooMany.players[0].lives = 4; assert.equal(validateCooperativeState(tooMany, spec, match), undefined);
});

test('guest presentation follows versus turning and thrust instead of the original nonrotating controls', () => {
  const spec = game(), engine = createCooperativeEngine(), state = active(engine.create(spec, 0, match)), presentation = createCooperativePresentation(spec, match);
  state.players.forEach(player => player.invulnerable = 0); presentation.receive(state, 1000); presentation.render(4, 1000);
  const view = presentation.render(4, 1100)!; assert.ok(view.players[1].x < 828); assert.ok(Math.abs(view.players[1].y - 253) < 0.001);
  assert.equal(view.players[1].lives, 3); assert.equal(view.versus?.winner, null);
});

test('full bounded versus runs produce valid snapshots through terminal results for all eligible formats', () => {
  const engine = createCooperativeEngine();
  for (const version of [1, 2, 4, 5, 6] as const) {
    const spec = game(version), state = active(engine.create(spec, 0, match));
    for (let tick = 0; tick < 120 * 60 + 1 && state.outcome === 'playing'; tick++) {
      engine.step(state, spec, [32 | (tick % 120 < 60 ? 2 : 4), 32 | (tick % 90 < 45 ? 1 : 4)], 1 / 60, match);
      if (tick % 30 === 0 || state.outcome === 'finished') {
        const snapshot = engine.snapshot(state); assert.ok(validateCooperativeState(snapshot, spec, match), `version ${version}, tick ${tick}`); assert.ok(JSON.stringify(snapshot).length <= 24000);
      }
    }
    assert.equal(state.outcome, 'finished'); assert.ok(state.versus?.reason);
  }
});

function sandbox(seat: 0 | 1, settings = match) {
  const elements = new Map<string, any>(), listeners: Record<string, ((event: any) => void)[]> = {}, frames: ((now: number) => void)[] = [], messages: any[] = [];
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: true, hidden: false, handlers: {} as Record<string, () => void>, addEventListener(name: string, fn: () => void) { this.handlers[name] = fn; }, setAttribute() {}, focus() {}, getContext: () => new Proxy({}, { get: () => () => {} }) }); return elements.get(id); };
  const parent = { postMessage(value: unknown) { messages.push(structuredClone(value)); } }, document = { hidden: false, getElementById: element, querySelectorAll: () => [], addEventListener(name: string, fn: (event: any) => void) { (listeners[`document:${name}`] ??= []).push(fn); } };
  const context = createContext({ structuredClone, parent, document, window: { addEventListener(name: string, fn: (event: any) => void) { (listeners[name] ??= []).push(fn); } }, requestAnimationFrame(fn: (now: number) => void) { frames.push(fn); }, listeners });
  const html = cooperativeGameSandboxDocument('1234567890abcdef'), script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1];
  new Script(script).runInContext(context);
  const send = (data: unknown) => { context.wire = JSON.stringify({ nonce: '1234567890abcdef', ...(data as object) }); new Script("listeners.message.forEach(fn=>fn({source:parent,data:JSON.parse(wire)}))").runInContext(context); };
  send({ type: 'game-coop-load', spec: game(1), seat, match: settings });
  let now = 1000;
  return { elements, messages, send, click(id: string) { element(id).handlers.click(); }, tick(count: number) { for (let i = 0; i < count; i++) frames.shift()!(now += 1000 / 60); } };
}

test('the actual serialized sandbox loads solo Asteroids for versus, enforces host controls and preserves terminal state across reconnect', () => {
  const host = sandbox(0, { ...match, timeLimit: 30 }); assert.equal(host.messages.at(-1).type, 'game-coop-loaded');
  assert.match(host.elements.get('title').textContent, /Versus/); assert.match(host.elements.get('instruction').textContent, /3 lives/); assert.equal(host.elements.get('next').hidden, true);
  host.send({ type: 'game-coop-peer', connected: true }); host.click('start'); host.tick(1900);
  const terminal = host.messages.filter(message => message.state).at(-1).state as CooperativeState;
  assert.equal(terminal.outcome, 'finished'); assert.equal(terminal.paused, false);
  host.send({ type: 'game-coop-peer', connected: false }); host.send({ type: 'game-coop-peer', connected: true });
  const reconnected = host.messages.at(-1).state; assert.equal(reconnected.outcome, 'finished'); assert.equal(reconnected.paused, false); assert.ok(validateCooperativeState(reconnected, game(1), { ...match, timeLimit: 30 }));
  assert.equal(host.elements.get('start').textContent, 'Rematch'); host.click('start'); assert.equal(host.messages.at(-1).state.outcome, 'playing');
  const guest = sandbox(1); guest.send({ type: 'game-coop-peer', connected: true }); guest.click('start'); guest.tick(2); assert.equal(guest.messages.some(message => message.state), false); assert.equal(guest.elements.get('start').hidden, true);
});
