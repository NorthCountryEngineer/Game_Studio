import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { defaultGameSpec, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { createGameEngine, gameSandboxDocument, startGameSandbox, validateGameResult, type GameState, type GameEntity, type GameEnemy } from '../src/lib/game-runtime.ts';
import { cooperativeGameSandboxDocument, createCooperativeEngine, validateCooperativeState, type CooperativeState } from '../src/lib/game-cooperative.ts';
import type { ArcadeGameSpec, CooperativeGameSpec, GameAsteroidSettings } from '../src/lib/game-types.ts';

function game(options: { endless?: boolean; sizes?: 2 | 3; enemy?: 'easy' | 'medium' | 'hard'; hp?: number; cooperative?: boolean; prizes?: boolean } = {}): ArcadeGameSpec {
  const planned = planGameLevels({ ...defaultGameSpec(), genre: 'dodge', theme: 'space', rules: { goal: 10, timeLimit: 30, lives: 5, difficulty: 5 }, arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true } }, 2, 'advanced synthetic runtime');
  const asteroids: GameAsteroidSettings = { endless: options.endless ?? true, difficultyInterval: 10, sizes: options.sizes ?? 3, enemies: { enabled: Boolean(options.enemy), difficulty: options.enemy || 'easy', hitPoints: options.hp || 2, spawnInterval: 5, maxShips: 2 } };
  return validateArcadeGameSpec({ ...planned, version: 6, asteroids, ...(options.prizes ? { powerUps: { spawnInterval: 5, duration: 10, types: ['triple-shot', 'rapid-fire', 'shield', 'speed-boost'] } } : {}), ...(options.cooperative ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 } } : {}) });
}
function clear(state: GameState) { state.entities = []; state.bullets = []; state.nextSnack = state.nextHazard = 1; state.advanced!.nextEnemy = 1; state.advanced!.enemies = []; state.advanced!.enemyBullets = []; }
function asteroid(state: GameState, tier: 'large' | 'medium' | 'small' = 'large'): GameEntity {
  const size = tier === 'large' ? 42 : tier === 'medium' ? 30 : 18;
  return { id: state.nextId++, kind: 'hazard', asteroid: tier, x: 300, y: 200, w: size, h: size, vx: 0, vy: 0 };
}
function enemy(state: GameState, hp = 2): GameEnemy { return { id: state.nextId++, x: 350, y: 120, w: 38, h: 28, vx: 0, vy: 0, hp, maxHp: hp, phase: 0, fireCooldown: 2 }; }
function shoot(state: GameState, targets: { x: number; y: number; w: number; h: number }[]) {
  state.bullets = targets.map(target => ({ id: state.nextId++, x: target.x + target.w / 2, y: target.y + target.h / 2, vx: 0, vy: 0, ttl: 1 }));
}

test('endless uses the first retained level, exceeds its timer and collectible goal, and ends only on death', () => {
  const engine = createGameEngine(), spec = game(), saved = structuredClone(spec.levels), state = engine.create(spec, 'level-2'); clear(state);
  assert.equal(state.levelIndex, 0); assert.equal(state.levelId, 'level-1');
  state.elapsed = spec.levels![0].rules.timeLimit; state.score = spec.levels![0].rules.goal;
  state.entities = [{ id: state.nextId++, kind: 'snack', x: state.player.x, y: state.player.y, w: 22, h: 22, vx: 0, vy: 0 }];
  engine.step(state, spec, {}, 1 / 20);
  assert.equal(state.outcome, 'playing'); assert.ok(state.elapsed > spec.levels![0].rules.timeLimit); assert.equal(state.score, spec.levels![0].rules.goal + 1); assert.equal(state.points, 10);
  assert.equal(engine.nextLevel(state, spec), undefined); assert.deepEqual(spec.levels, saved);
  const before = structuredClone(state); engine.step(state, spec, {}, 0); assert.deepEqual(state, before);
  state.lives = 1; state.invulnerable = 0; state.entities = [{ ...asteroid(state, 'small'), x: state.player.x, y: state.player.y }];
  engine.step(state, spec, {}, 1 / 60); assert.equal(state.outcome, 'lost'); assert.equal(state.lives, 0);
  assert.ok(validateGameResult({ outcome: 'lost', elapsed: state.elapsed, score: state.score, points: state.points, reviewedLevelIds: ['level-1'] }, spec));
});

test('three asteroid sizes require seven distinct hits, while two sizes retain three-hit behavior', () => {
  const engine = createGameEngine();
  for (const sizes of [2, 3] as const) {
    const spec = game({ sizes }), state = engine.create(spec); clear(state); state.entities = [asteroid(state)];
    shoot(state, state.entities); state.bullets!.push({ ...state.bullets![0], id: state.nextId++ });
    engine.step(state, spec, {}, 1 / 60);
    assert.equal(state.entities.length, 2); assert.equal(state.points, 20); assert.equal(state.bullets!.length, 1, 'a same-frame second shot cannot hit a new fragment');
    assert.ok(state.entities.every(item => item.asteroid === (sizes === 3 ? 'medium' : 'small') && item.w === (sizes === 3 ? 30 : 18)));
    state.entities.forEach((item, index) => { item.x = 100 + index * 150; item.y = 100; item.vx = item.vy = 0; });
    shoot(state, state.entities); engine.step(state, spec, {}, 1 / 60);
    if (sizes === 3) {
      assert.equal(state.points, 80); assert.equal(state.entities.length, 4); assert.ok(state.entities.every(item => item.asteroid === 'small' && item.w === 18));
      state.entities.forEach((item, index) => { item.x = 100 + index * 150; item.y = 100; item.vx = item.vy = 0; });
      shoot(state, state.entities); engine.step(state, spec, {}, 1 / 60);
    }
    assert.equal(state.entities.length, 0); assert.equal(state.points, sizes === 3 ? 280 : 120); assert.equal(state.score, 0);
  }
});

test('finite v6 preserves authored level pressure while only endless play ramps with elapsed time', () => {
  const engine = createGameEngine(), finite = game({ endless: false, enemy: 'hard', cooperative: true }) as CooperativeGameSpec;
  finite.levels.forEach(level => { level.rules.timeLimit = 180; });
  const early = engine.create(finite), later = engine.create(finite); later.elapsed = 90;
  for (const state of [early, later]) { clear(state); state.nextHazard = 0; state.advanced!.nextEnemy = 0; engine.step(state, finite, {}, 1 / 60); }
  assert.deepEqual(later.entities, early.entities); assert.deepEqual(later.advanced, early.advanced); assert.equal(later.nextHazard, early.nextHazard);
  assert.equal(early.advanced!.difficulty, finite.levels[0].rules.difficulty);
  const coEngine = createCooperativeEngine();
  for (let index = 0; index < finite.levels.length; index++) {
    const state = coEngine.create(finite, index); assert.equal(state.advanced!.difficulty, finite.levels[index].rules.difficulty);
    assert.ok(validateCooperativeState(coEngine.snapshot(state), finite));
    state.advanced!.difficulty = finite.levels[index].rules.difficulty === 1 ? 2 : 1;
    assert.equal(validateCooperativeState(coEngine.snapshot(state), finite), undefined);
  }
  const endless = game(), fresh = engine.create(endless), seasoned = engine.create(endless); seasoned.elapsed = 90;
  for (const state of [fresh, seasoned]) { clear(state); state.nextHazard = 0; engine.step(state, endless, {}, 1 / 60); }
  assert.equal(fresh.advanced!.difficulty, 1); assert.equal(seasoned.advanced!.difficulty, 10);
  assert.ok(seasoned.entities[0].vy > fresh.entities[0].vy); assert.ok(seasoned.nextHazard < fresh.nextHazard);
});

test('enemy HP consumes one projectile per hit, awards only kills, and difficulty selects movement and firing', () => {
  const engine = createGameEngine();
  for (const [difficulty, points] of [['easy', 100], ['medium', 200], ['hard', 300]] as const) {
    const spec = game({ enemy: difficulty }), state = engine.create(spec); clear(state); state.advanced!.enemies = [enemy(state)];
    shoot(state, state.advanced!.enemies); engine.step(state, spec, {}, 1 / 60);
    assert.equal(state.advanced!.enemies[0].hp, 1); assert.equal(state.points, 0); assert.equal(state.bullets!.length, 0);
    shoot(state, state.advanced!.enemies); engine.step(state, spec, {}, 1 / 60);
    assert.equal(state.advanced!.enemies.length, 0); assert.equal(state.points, points);
  }
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const spec = game({ enemy: difficulty }), left = engine.create(spec), right = engine.create(spec);
    for (const state of [left, right]) { clear(state); state.advanced!.enemies = [enemy(state)]; state.advanced!.enemies[0].fireCooldown = 0; }
    left.player.x = 40; right.player.x = 850;
    engine.step(left, spec, {}, 1 / 20); engine.step(right, spec, {}, 1 / 20);
    if (difficulty === 'easy') assert.equal(left.advanced!.enemies[0].vx, right.advanced!.enemies[0].vx, 'easy movement ignores players');
    else { assert.ok(left.advanced!.enemies[0].vx < 0); assert.ok(right.advanced!.enemies[0].vx > 0); }
    assert.equal(left.advanced!.enemyBullets.length, difficulty === 'hard' ? 1 : 0);
    if (difficulty === 'hard') { const bullet = left.advanced!.enemyBullets[0]; assert.ok(bullet.vx < 0 && bullet.vy > 0); assert.ok(Math.hypot(bullet.vx, bullet.vy) < 236); }
  }
});

test('endless prizes persist past their authored duration and every damaging source clears all perks once', () => {
  const engine = createGameEngine(), spec = game({ enemy: 'hard', prizes: true });
  const lasting = engine.create(spec); clear(lasting); lasting.powerUps!.effects = { shield: 1, tripleShot: 10, rapidFire: 10, speedBoost: 10 };
  for (let tick = 0; tick < 700; tick++) { clear(lasting); lasting.powerUps!.nextSpawn = 1; engine.step(lasting, spec, {}, 1 / 60); }
  assert.deepEqual(lasting.powerUps!.effects, { shield: 1, tripleShot: 10, rapidFire: 10, speedBoost: 10 });
  for (const source of ['asteroid', 'enemy', 'bullet'] as const) for (const shield of [0, 1] as const) {
    const state = engine.create(spec); clear(state); state.invulnerable = 0;
    state.powerUps!.effects = { shield, tripleShot: 10, rapidFire: 10, speedBoost: 10 };
    if (source === 'asteroid') state.entities = [1, 2].map(() => ({ ...asteroid(state, 'small'), x: state.player.x, y: state.player.y }));
    if (source === 'enemy') state.advanced!.enemies = [1, 2].map(() => ({ ...enemy(state), x: state.player.x, y: state.player.y }));
    if (source === 'bullet') state.advanced!.enemyBullets = [1, 2].map(() => ({ id: state.nextId++, x: state.player.x + 10, y: state.player.y + 10, vx: 0, vy: 0, ttl: 1 }));
    engine.step(state, spec, {}, 1 / 60);
    assert.equal(state.lives, spec.levels![0].rules.lives - (shield ? 0 : 1), source);
    assert.deepEqual(state.powerUps!.effects, { shield: 0, tripleShot: 0, rapidFire: 0, speedBoost: 0 }); assert.ok(state.invulnerable > 1);
    engine.step(state, spec, {}, 1 / 60); assert.equal(state.lives, spec.levels![0].rules.lives - (shield ? 0 : 1));
  }
  const finite = game({ endless: false, prizes: true }), timed = engine.create(finite); clear(timed); timed.powerUps!.effects.rapidFire = 0.01;
  engine.step(timed, finite, {}, 1 / 20); assert.equal(timed.powerUps!.effects.rapidFire, 0, 'finite v6 retains timed prize behavior');
  timed.powerUps!.effects = { shield: 1, tripleShot: 10, rapidFire: 10, speedBoost: 10 }; timed.invulnerable = 0;
  timed.entities = [{ ...asteroid(timed, 'small'), x: timed.player.x, y: timed.player.y }];
  engine.step(timed, finite, {}, 1 / 60);
  assert.equal(timed.powerUps!.effects.shield, 0); assert.ok(timed.powerUps!.effects.tripleShot > 9); assert.equal(timed.lives, finite.levels![0].rules.lives, 'finite shields keep other timed prizes');
  const protectedShip = engine.create(spec); clear(protectedShip); protectedShip.invulnerable = 1;
  protectedShip.powerUps!.effects = { shield: 1, tripleShot: 10, rapidFire: 10, speedBoost: 10 };
  protectedShip.entities = [{ ...asteroid(protectedShip, 'small'), x: protectedShip.player.x, y: protectedShip.player.y }];
  engine.step(protectedShip, spec, {}, 1 / 60);
  assert.deepEqual(protectedShip.powerUps!.effects, { shield: 1, tripleShot: 10, rapidFire: 10, speedBoost: 10 }, 'invulnerable overlaps are not damaging impacts');
});

test('advanced solo and cooperative physics share seeded behavior, with a surviving partner keeping endless play active', () => {
  const base = createGameEngine(), coop = createCooperativeEngine(), spec = game({ cooperative: true, enemy: 'hard', prizes: true }) as CooperativeGameSpec;
  const solo = base.create(spec), state = coop.create(spec); state.running = true; state.paused = false;
  state.players[0] = { ...state.players[0], x: solo.player.x, y: solo.player.y, invulnerable: solo.invulnerable };
  state.players[1].lives = 0;
  for (let tick = 0; tick < 900; tick++) {
    solo.invulnerable = state.players[0].invulnerable = 2;
    base.step(solo, spec, { fire: true, right: tick % 120 < 60, left: tick % 120 >= 60 }, 1 / 60);
    coop.step(state, spec, [32 | (tick % 120 < 60 ? 2 : 1), 0], 1 / 60);
    assert.equal(state.outcome, 'playing');
  }
  assert.deepEqual(state.entities, solo.entities); assert.deepEqual(state.bullets, solo.bullets); assert.deepEqual(state.advanced, solo.advanced);
  assert.equal(state.players[0].points, solo.points); assert.equal(state.seed, solo.seed); assert.equal(state.elapsed, solo.elapsed);
  state.players[0].lives = 0; coop.step(state, spec, [0, 0], 1 / 60); assert.equal(state.outcome, 'lost');
  const paused = structuredClone(state); coop.step(state, spec, [63, 63], 30); assert.deepEqual(state, paused);
});

test('endless pressure and all projectile/entity budgets remain bounded and snapshots match Python relay validation', () => {
  const spec = game({ cooperative: true, enemy: 'hard', prizes: true }) as CooperativeGameSpec, engine = createCooperativeEngine(), state = engine.create(spec);
  state.running = true; state.paused = false;
  const snapshots: CooperativeState[] = [];
  let sawEnemy = false, sawHostile = false, sawMedium = false, sawPrize = false;
  for (let tick = 0; tick < 6000; tick++) {
    state.players.forEach(player => { player.invulnerable = 2; player.effects!.tripleShot = player.effects!.rapidFire = 10; });
    engine.step(state, spec, [32 | (tick % 240 < 120 ? 1 : 2), 32 | (tick % 240 < 120 ? 2 : 1)], 1 / 60);
    sawEnemy ||= state.advanced!.enemies.length > 0; sawHostile ||= state.advanced!.enemyBullets.length > 0;
    sawMedium ||= state.entities.some(item => item.asteroid === 'medium'); sawPrize ||= state.powerUps!.pickups.length > 0;
    assert.ok(state.bullets.length <= 64 && [0, 1].every(owner => state.bullets.filter(bullet => bullet.owner === owner).length <= 32));
    assert.ok(state.entities.reduce((sum, entity) => sum + (entity.asteroid === 'large' ? 4 : entity.asteroid === 'medium' ? 2 : 1), 0) <= 64);
    assert.ok(state.advanced!.enemies.length <= 2 && state.advanced!.enemyBullets.length <= 24);
    const snapshot = engine.snapshot(state); assert.ok(validateCooperativeState(snapshot, spec), `advanced snapshot tick ${tick}`);
    if (tick % 250 === 0) snapshots.push(snapshot);
  }
  assert.ok(sawEnemy && sawHostile && sawMedium && sawPrize); assert.ok(state.elapsed > 99); assert.equal(state.advanced!.difficulty, 10); assert.equal(state.outcome, 'playing');
  // Explicitly retain a real, stepped medium fragment/enemy/hostile/prize world
  // together so both independent validators see the full new wire contract.
  const specimen = engine.snapshot(state), player = specimen.players[0];
  specimen.entities = [{ id: specimen.nextId++, kind: 'hazard', asteroid: 'medium', x: 100, y: 100, w: 30, h: 30, vx: 50, vy: 80, grace: 0.1 }];
  specimen.advanced!.enemies = [{ id: specimen.nextId++, x: 500, y: 100, w: 38, h: 28, vx: 0, vy: 30, hp: 1, maxHp: 2, fireCooldown: 1, phase: 2 }];
  specimen.advanced!.enemyBullets = [{ id: specimen.nextId++, x: 500, y: 200, vx: 20, vy: 160, ttl: 2 }];
  specimen.powerUps!.pickups = [{ id: specimen.nextId++, type: 'shield', x: 200, y: 100, ttl: 6 }];
  specimen.bullets = [{ id: specimen.nextId++, owner: 0, x: player.x + 21, y: player.y - 20, vx: 0, vy: -620, ttl: 1 }];
  engine.step(specimen, spec, [0, 0], 1 / 60); snapshots.push(engine.snapshot(specimen));
  const hostile = Array.from({ length: 9 }, () => structuredClone(snapshots.at(-1)!));
  hostile[0].advanced!.enemies[0].hp = 3;
  hostile[1].advanced!.enemies[0].id = hostile[1].entities[0].id;
  (hostile[2].advanced!.enemyBullets[0] as unknown as Record<string, unknown>).owner = 0;
  hostile[3].advanced!.enemies = Array.from({ length: 3 }, () => ({ ...hostile[3].advanced!.enemies[0], id: hostile[3].nextId++ }));
  hostile[4].outcome = 'won';
  hostile[5].players[0].points = Math.ceil(hostile[5].elapsed * 2000) + 2001;
  hostile[6].players[0].score = Math.ceil(hostile[6].elapsed * 20) + 41;
  hostile[7].entities[0].w = 42;
  hostile[8].entities[0] = { id: hostile[8].entities[0].id, kind: 'snack', x: 100, y: 100, w: 22, h: 22, vx: 0, vy: 0, grace: 0.1 };
  const states = [...snapshots, ...hostile], expected = states.map(value => Boolean(validateCooperativeState(value, spec)));
  const python = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('advanced_relay_parity',Path.cwd()/'backend/nce_api/multiplayer.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ndata=json.loads(sys.stdin.readline())\nout=[]\nfor value in data['states']:\n try: m.validate_state(value,data['spec']);out.append(True)\n except m.MultiplayerError: out.append(False)\nprint(json.dumps(out))`;
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify({ spec, states }) + '\n', encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(actual, expected); assert.ok(expected.slice(0, snapshots.length).every(Boolean)); assert.ok(expected.slice(snapshots.length).every(value => !value));
  assert.equal(validateCooperativeState(snapshots.at(-1), game({ cooperative: true, sizes: 2, enemy: 'hard', prizes: true }) as CooperativeGameSpec), undefined);
});

test('v6 result ceilings use observed elapsed for finite and endless results without loosening old versions', () => {
  const engine = createGameEngine(), spec = game({ endless: false }), result = { outcome: 'lost', elapsed: 1, score: 0, points: 4000, reviewedLevelIds: ['level-1'] };
  assert.ok(validateGameResult(result, spec)); assert.equal(validateGameResult({ ...result, points: 4001 }, spec), undefined);
  assert.equal(engine.maxPoints(spec, ['level-1'], 1), 4000); assert.equal(engine.maxPoints(spec, ['level-1']), spec.levels![0].rules.timeLimit * 2000 + 2000);
  const infinite = game(); assert.equal(engine.maxPoints(infinite), 2147483647);
  assert.ok(validateGameResult({ ...result, elapsed: 100000, score: 1000, points: 1500000 }, infinite));
  for (const patch of [{ outcome: 'won' }, { outcome: 'level-complete' }, { reviewedLevelIds: ['level-2'] }, { elapsed: 2147483648 }, { score: 61 }, { points: 4001 }]) assert.equal(validateGameResult({ ...result, ...patch }, infinite), undefined);
});

test('v6 ID exhaustion stops new prizes without clamping gameplay time or dropping existing pickups', () => {
  const engine = createGameEngine(), spec = game({ prizes: true }), state = engine.create(spec); clear(state);
  state.elapsed = 2147483647; state.nextId = 2147483600; state.powerUps!.nextSpawn = 0;
  state.powerUps!.pickups = [{ id: 1, type: 'shield', x: 100, y: 100, ttl: 5 }];
  engine.step(state, spec, {}, 1 / 20);
  assert.equal(state.nextId, 2147483600); assert.equal(state.powerUps!.pickups.length, 1); assert.ok(state.powerUps!.pickups[0].y > 100);
  assert.ok(state.elapsed > 2147483647); assert.equal(state.outcome, 'playing');
});

function sandbox(spec: ArcadeGameSpec, playtest: boolean, finish?: 'lost') {
  type Element = { textContent: string; disabled: boolean; hidden: boolean; handlers: Record<string, () => void>; addEventListener(name: string, fn: () => void): void; setAttribute(): void; getContext(): unknown; focus(): void };
  const elements = new Map<string, Element>(), messages: Record<string, unknown>[] = [], frames: ((now: number) => void)[] = [];
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: true, hidden: true, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {}, getContext: () => new Proxy({}, { get: () => () => {} }), focus() {} }); return elements.get(id)!; };
  const listeners: Record<string, (event: unknown) => void> = {}, parent = { postMessage(message: Record<string, unknown>) { messages.push(JSON.parse(JSON.stringify(message))); } };
  const actual = createGameEngine(); let steps = 0;
  const engine = { ...actual, step(state: GameState) { steps++; state.elapsed = steps / 60; if (finish && steps === 360) { state.lives = 0; state.outcome = finish; } return state; } };
  new Script(`const __name = fn => fn; (${startGameSandbox.toString()})(engine, validate, 'advanced_test_nonce');`).runInNewContext({ engine, validate: (value: ArcadeGameSpec) => value, parent, document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} }, window: { addEventListener(name: string, fn: typeof listeners[string]) { listeners[name] = fn; } }, requestAnimationFrame(fn: (now: number) => void) { frames.push(fn); } });
  const load = (source = parent, nonce = 'advanced_test_nonce') => listeners.message({ source, data: { type: 'axolotl-game-load', nonce, spec, playtest } });
  let now = 1000;
  return { element, messages, load, get steps() { return steps; }, tick() { frames.shift()!(now += 1000 / 60); }, click(id: string) { element(id).handlers.click(); } };
}

test('only explicit private endless playtests can stop after five seconds and emit a review without a score result', () => {
  for (const [spec, privatePreview] of [[game(), true], [game(), false], [game({ endless: false }), true]] as const) {
    const harness = sandbox(spec, privatePreview); harness.load({} as never); assert.ok(harness.element('start').disabled);
    harness.load(undefined, 'wrongnonce'); assert.ok(harness.element('start').disabled); harness.load(); harness.click('start');
    if (spec.asteroids!.endless) { assert.match(harness.element('instruction').textContent, /^Survive as long as possible\./); assert.equal(harness.element('instruction').textContent.includes(spec.levels![0].brief), false); }
    for (let tick = 0; tick < 290; tick++) harness.tick();
    assert.equal(harness.element('finish-review').hidden, true); harness.click('finish-review'); assert.equal(harness.messages.some(message => message.type === 'axolotl-game-review'), false);
    for (let tick = 0; tick < 30; tick++) harness.tick();
    assert.equal(harness.element('finish-review').hidden, !(privatePreview && spec.asteroids!.endless));
    harness.click('finish-review');
    const review = harness.messages.find(message => message.type === 'axolotl-game-review');
    if (privatePreview && spec.asteroids!.endless) {
      assert.ok(review); assert.deepEqual(Object.keys(review).sort(), ['nonce', 'review', 'type']); assert.equal(review.nonce, 'advanced_test_nonce');
      assert.deepEqual((review.review as { reviewedLevelIds: string[] }).reviewedLevelIds, ['level-1']);
      const stopped = harness.steps; for (let tick = 0; tick < 10; tick++) harness.tick(); assert.equal(harness.steps, stopped);
      harness.click('finish-review'); assert.equal(harness.messages.filter(message => message.type === 'axolotl-game-review').length, 1);
      assert.equal(harness.messages.some(message => message.type === 'axolotl-game-result'), false);
    } else assert.equal(review, undefined);
  }
  const death = sandbox(game(), true, 'lost'); death.load(); death.click('start'); for (let tick = 0; tick < 370; tick++) death.tick();
  const result = death.messages.find(message => message.type === 'axolotl-game-result'); assert.equal((result!.result as { outcome: string }).outcome, 'lost');
  assert.equal(death.messages.some(message => message.type === 'axolotl-game-review'), false);
});

test('advanced solo/cooperative engines remain self-contained fixed scripts with network disabled', () => {
  for (const html of [gameSandboxDocument('advanced_test_nonce'), cooperativeGameSandboxDocument('advanced_test_nonce')]) {
    assert.match(html, /connect-src 'none'/); assert.doesNotMatch(html, /fetch\(|WebSocket|RTCPeerConnection/);
    assert.doesNotThrow(() => new Script(html.match(/<script[^>]*>([\s\S]*)<\/script>/)![1]));
  }
  const serialized = new Script(`const __name = fn => fn; (${createGameEngine.toString()})()`).runInNewContext();
  const spec = game(), state = serialized.create(spec); serialized.step(state, spec, { fire: true }, 1 / 60); assert.equal(state.bullets.length, 1);
});
