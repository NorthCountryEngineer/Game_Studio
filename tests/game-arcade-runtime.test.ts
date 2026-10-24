import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { defaultGameSpec } from '../src/lib/game-design.ts';
import { createGameEngine, gameSandboxDocument, startGameSandbox, validateGameResult, type GameState } from '../src/lib/game-runtime.ts';
import type { GameResult, GameSpec } from '../src/lib/game-types.ts';

function arcade(change: Partial<NonNullable<GameSpec['arcade']>> = {}): GameSpec {
  return { ...defaultGameSpec(), genre: 'dodge', theme: 'space', arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true, ...change } };
}
function clear(state: GameState) { state.entities = []; state.nextSnack = 999; state.nextHazard = 999; state.invulnerable = 99; }
const rock = (id = 10) => ({ id, kind: 'hazard' as const, asteroid: 'large' as const, x: 350, y: 290, w: 42, h: 42, vx: 0, vy: 0 });

test('rotation turns freely through a full circle, with forward and reverse thrust along its nose', () => {
  const engine = createGameEngine(), spec = arcade(), state = engine.create(spec); clear(state);
  const initial = { ...state.player };
  for (let i = 0; i < 180; i++) engine.step(state, spec, { right: true }, 1 / 60);
  assert.deepEqual(state.player, initial);
  const expected = ((-Math.PI / 2 + 180 * 2.8 / 60) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  assert.ok(Math.abs(state.angle! - expected) < 1e-10);
  assert.ok(state.angle! >= 0 && state.angle! < Math.PI * 2);
  state.angle = 0;
  engine.step(state, spec, { up: true }, 1 / 20); assert.ok(state.player.x > initial.x); assert.equal(state.player.y, initial.y);
  engine.step(state, spec, { down: true }, 1 / 20); assert.ok(Math.abs(state.player.x - initial.x) < 1e-10);
  const oldAngle = state.angle!; engine.step(state, spec, { left: true }, 1 / 20); assert.ok(state.angle! > oldAngle);
});

test('shooting and rotation are independent options and disabled movement remains direct', () => {
  const engine = createGameEngine(), spec = arcade({ rotation: false }), state = engine.create(spec); clear(state);
  const x = state.player.x; engine.step(state, spec, { right: true, fire: true }, 1 / 60);
  assert.ok(state.player.x > x); assert.equal(state.bullets!.length, 1); assert.ok(Math.abs(state.bullets![0].vx) < 1e-10); assert.ok(state.bullets![0].vy < 0);
  const noShots = arcade({ shooting: false, splitAsteroids: false }), peaceful = engine.create(noShots); clear(peaceful);
  engine.step(peaceful, noShots, { fire: true }, 1 / 60); assert.equal(peaceful.bullets, undefined);
});

test('one swept shot splits a large asteroid into exactly two small pieces and each takes one further shot', () => {
  const engine = createGameEngine(), spec = arcade(), state = engine.create(spec); clear(state); state.nextId = 100;
  state.entities = [rock()]; state.bullets = [{ id: 50, x: 300, y: 310, vx: 2000, vy: 0, ttl: 1 }];
  engine.step(state, spec, {}, 1 / 20);
  assert.equal(state.entities.length, 2); assert.ok(state.entities.every(entity => entity.asteroid === 'small' && entity.w === 20));
  assert.equal(state.bullets.length, 0); assert.equal(state.score, 0); assert.equal(state.points, 20);
  assert.ok(state.entities.every(entity => entity.grace! > 0)); assert.notEqual(state.entities[0].vx, state.entities[1].vx);
  state.bullets = state.entities.map((entity, index) => ({ id: 60 + index, x: entity.x + entity.w / 2, y: entity.y + entity.h / 2, vx: 0, vy: 0, ttl: 1 }));
  engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.entities.length, 0); assert.equal(state.points, 120); assert.equal(state.score, 0);
});

test('unsplit asteroids take one shot; overlapping bullets never award the same hit twice', () => {
  const engine = createGameEngine(), spec = arcade({ splitAsteroids: false }), state = engine.create(spec); clear(state);
  state.entities = [rock()]; state.bullets = [1, 2].map(id => ({ id, x: 300, y: 310, vx: 2000, vy: 0, ttl: 1 }));
  engine.step(state, spec, {}, 1 / 20);
  assert.equal(state.entities.length, 0); assert.equal(state.points, 20); assert.equal(state.bullets.length, 1);
  const noPoints = arcade({ scoring: false }), disabled = engine.create(noPoints); clear(disabled);
  disabled.entities = [rock()]; disabled.bullets = [{ id: 99, x: 300, y: 310, vx: 2000, vy: 0, ttl: 1 }];
  engine.step(disabled, noPoints, {}, 1 / 20); assert.equal(disabled.points, undefined); assert.equal(disabled.entities.length, 2);
});

test('swept collisions use relative asteroid motion and choose the nearest obstacle without tunneling', () => {
  const engine = createGameEngine(), spec = arcade({ splitAsteroids: false }), state = engine.create(spec); clear(state);
  state.entities = [{ ...rock(10), x: 380, w: 5, vx: -1800 }, { ...rock(11), x: 430 }];
  state.bullets = [{ id: 99, x: 300, y: 310, vx: 2000, vy: 0, ttl: 1 }];
  engine.step(state, spec, {}, 1 / 20);
  assert.deepEqual(state.entities.map(entity => entity.id), [11]); assert.equal(state.points, 20);
  assert.equal(engine.sweptHit(0, 0, 100, 0, { ...rock(), x: 50, y: 20 }), undefined);
});

test('point tracking keeps collection goals separate and prevents excess last-frame collectibles inflating points', () => {
  const engine = createGameEngine(), spec = arcade(), state = engine.create(spec); clear(state); state.score = spec.rules.goal - 1;
  state.entities = [1, 2, 3].map(id => ({ id, kind: 'snack', x: state.player.x, y: state.player.y, w: 22, h: 22, vx: 0, vy: 0 }));
  engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.score, spec.rules.goal); assert.equal(state.points, 10); assert.equal(state.outcome, 'won');
  const before = structuredClone(state); engine.step(state, spec, { fire: true }, 1 / 60); assert.deepEqual(state, before);
});

test('bullets have a firing cooldown and bounded lifetime, and seeded fragments are repeatable', () => {
  const engine = createGameEngine(), spec = arcade(), state = engine.create(spec); clear(state);
  let peak = 0;
  for (let i = 0; i < 1200; i++) { engine.step(state, spec, { fire: true, right: true }, 1 / 60); peak = Math.max(peak, state.bullets!.length); }
  assert.ok(peak > 1 && peak <= 8); assert.ok(state.nextId < 110);
  for (let i = 0; i < 120; i++) engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.bullets!.length, 0);
  const a = engine.create(spec), b = engine.create(spec);
  for (const item of [a, b]) { clear(item); item.entities = [rock()]; item.bullets = [{ id: 99, x: 300, y: 310, vx: 2000, vy: 0, ttl: 1 }]; engine.step(item, spec, {}, 1 / 20); }
  assert.deepEqual(a, b);
});

test('arcade reserves fragment capacity and keeps long-running spawn/entity counts bounded', () => {
  const engine = createGameEngine(), spec = arcade(), state = engine.create(spec); clear(state);
  state.entities = Array.from({ length: 63 }, (_, i) => ({ ...rock(i + 100), x: 100 + i, y: 10, vx: 0, vy: 0 }));
  state.entities.push({ id: 999, kind: 'snack', x: 10, y: 10, w: 22, h: 22, vx: 0, vy: 0 });
  state.nextHazard = 0; engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.entities.length, 64); // 127 weighted slots leaves no room for a large rock.
  state.bullets = [{ id: 1000, x: 90, y: 20, vx: 2000, vy: 0, ttl: 1 }];
  engine.step(state, spec, {}, 1 / 20);
  assert.equal(state.entities.length, 65); assert.equal(state.entities.filter(entity => entity.asteroid === 'small').length, 2);
  assert.ok(state.entities.reduce((sum, entity) => sum + (entity.kind === 'hazard' && entity.asteroid !== 'small' ? 2 : 1), 0) <= 128);
});

test('result validation bounds points per reviewed level and legacy games never acquire optional score fields', () => {
  const engine = createGameEngine(), spec = arcade();
  const result = { outcome: 'won', elapsed: 5, score: spec.rules.goal, reviewedLevelIds: ['level-1'], points: 120 };
  assert.deepEqual(validateGameResult(result, spec), result);
  const cap = spec.rules.goal * 10 + (Math.ceil(spec.rules.timeLimit / 0.5) + 8) * 120;
  assert.equal(engine.maxPoints(spec), cap);
  for (const points of [undefined, -1, 0.1, Infinity, NaN, cap + 1]) assert.equal(validateGameResult({ ...result, points }, spec), undefined);
  assert.equal(validateGameResult({ ...result, points: cap }, spec)?.points, cap);
  const legacy = defaultGameSpec(), plain = { ...result }; delete (plain as { points?: number }).points;
  assert.equal(engine.maxPoints(legacy), 0); assert.deepEqual(validateGameResult(plain, legacy), plain); assert.equal(validateGameResult(result, legacy), undefined);
  const state = engine.create(legacy); assert.equal('points' in state, false); assert.equal('bullets' in state, false); assert.equal('angle' in state, false);
  const campaign: GameSpec = { ...spec, version: 2, progression: 'Learn then explore.', levels: [1, 2].map((id) => ({ id: `level-${id}`, title: `Level ${id}`, brief: 'Collect snacks.', theme: 'space', rules: { ...spec.rules, timeLimit: id * 30 }, seed: id })) };
  const selected = { ...result, outcome: 'level-complete', reviewedLevelIds: ['level-2'] };
  assert.equal(engine.maxPoints(campaign, ['level-2']), cap);
  assert.deepEqual(validateGameResult(selected, campaign, 'level-2'), selected);
  assert.equal(validateGameResult({ ...selected, points: cap + 1 }, campaign, 'level-2'), undefined);
  assert.equal(validateGameResult({ ...selected, outcome: 'won' }, campaign, 'level-2'), undefined);
});

function harness(spec: GameSpec) {
  type Handler = (event: Record<string, unknown>) => void;
  type Element = { textContent: string; disabled: boolean; hidden: boolean; dataset: { control?: string }; attributes: Record<string, string>; handlers: Record<string, Handler>; addEventListener(name: string, fn: Handler): void; setAttribute(name: string, value: string): void; getContext(): unknown; focus(): void; setPointerCapture(): void };
  const elements = new Map<string, Element>(), messages: { type: string; result?: GameResult }[] = [], frames: ((now: number) => void)[] = [], documentHandlers: Record<string, Handler> = {}, windowHandlers: Record<string, Handler> = {}, recorded: unknown[] = [];
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', disabled: true, hidden: false, dataset: ['left', 'right', 'up', 'down', 'fire', 'jump'].includes(id) ? { control: id } : {}, attributes: {}, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; }, getContext: () => new Proxy({}, { get: () => () => {} }), focus() {}, setPointerCapture() {} });
    return elements.get(id)!;
  };
  const controls = ['left', 'right', 'up', 'down', 'fire', 'jump'].map(element), parent = { postMessage(value: { type: string; result?: GameResult }) { messages.push(JSON.parse(JSON.stringify(value))); } };
  const actual = createGameEngine(), engine = { ...actual, step(state: GameState, source: GameSpec, input: unknown) { recorded.push(input); state.elapsed = 3; state.score = actual.forLevel(source, state.levelIndex).rules.goal; state.points = (state.levelIndex + 1) * 120; state.outcome = 'won'; return state; } };
  new Script(`const __name = fn => fn; (${startGameSandbox.toString()})(engine, validate, '1234567890abcdef');`).runInNewContext({ engine, validate: (value: GameSpec) => value, parent, document: { getElementById: element, querySelectorAll: () => controls, addEventListener(name: string, fn: Handler) { documentHandlers[name] = fn; } }, window: { addEventListener(name: string, fn: Handler) { windowHandlers[name] = fn; } }, requestAnimationFrame(fn: (now: number) => void) { frames.push(fn); } });
  windowHandlers.message({ source: parent, data: { type: 'axolotl-game-load', nonce: '1234567890abcdef', spec } });
  let now = 1000; const tick = () => frames.shift()!(now += 1000 / 30);
  const click = (id: string) => element(id).handlers.click({});
  const complete = () => { const count = messages.filter(message => message.result).length; for (let i = 0; i < 5 && count === messages.filter(message => message.result).length; i++) tick(); };
  return { element, messages, tick, click, complete, documentHandlers, windowHandlers, recorded };
}

test('campaign points replace restarted levels instead of accumulating and all-game restart clears totals', () => {
  const single = arcade(), spec: GameSpec = { ...single, version: 2, progression: 'Learn then explore.', levels: [1, 2].map((id) => ({ id: `level-${id}`, title: `Level ${id}`, brief: 'Collect snacks.', theme: 'space', rules: { ...single.rules }, seed: id })) };
  const game = harness(spec); game.click('start'); game.complete();
  assert.equal(game.messages.at(-1)!.result!.points, 120);
  game.click('start'); game.complete(); assert.equal(game.messages.at(-1)!.result!.points, 120);
  game.click('next'); game.complete(); assert.equal(game.messages.at(-1)!.result!.points, 360);
  game.click('start'); game.complete(); assert.equal(game.messages.at(-1)!.result!.points, 360);
  game.click('restart'); game.complete(); assert.equal(game.messages.at(-1)!.result!.points, 120);
});

test('sandbox renders safe fixed Fire controls and appropriate rotation, shooting, and scoring help', () => {
  const game = harness(arcade());
  assert.equal(game.element('fire').hidden, false); assert.equal(game.element('jump').hidden, true);
  assert.match(game.element('controls-help').textContent, /360°/); assert.match(game.element('controls-help').textContent, /Space or Z/); assert.match(game.element('controls-help').textContent, /two small pieces/);
  assert.equal(game.element('left').attributes['aria-label'], 'Turn left'); assert.equal(game.element('up').attributes['aria-label'], 'Thrust forward');
  game.click('start');
  game.documentHandlers.keydown({ key: 'z', target: {}, preventDefault() {} }); game.complete();
  assert.equal((game.recorded[0] as { fire: boolean }).fire, true);
  game.click('start'); game.complete(); assert.equal((game.recorded.at(-1) as { fire: boolean }).fire, false);
  const html = gameSandboxDocument('1234567890abcdef');
  assert.match(html, /data-control="fire"/); assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|https?:\/\//);
  assert.doesNotThrow(() => new Script(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]));
});

test('pause, window blur, and touch cancellation release firing input before resuming', () => {
  const game = harness(arcade()); game.click('start');
  game.documentHandlers.keydown({ key: 'z', target: {}, preventDefault() {} });
  game.click('pause'); game.click('pause'); game.complete();
  assert.equal((game.recorded.at(-1) as { fire: boolean }).fire, false);
  game.click('start');
  game.documentHandlers.keydown({ key: ' ', target: {}, preventDefault() {} });
  game.windowHandlers.blur({}); assert.equal(game.element('pause').textContent, 'Resume');
  game.click('pause'); game.complete(); assert.equal((game.recorded.at(-1) as { fire: boolean }).fire, false);
  game.click('start');
  game.element('fire').handlers.pointerdown({ pointerId: 1, preventDefault() {} }); game.complete();
  assert.equal((game.recorded.at(-1) as { fire: boolean }).fire, true);
  game.click('start');
  game.element('fire').handlers.pointerdown({ pointerId: 2, preventDefault() {} }); game.element('fire').handlers.pointercancel({}); game.complete();
  assert.equal((game.recorded.at(-1) as { fire: boolean }).fire, false);
});
