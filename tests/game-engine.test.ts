import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { defaultGameSpec, designGame, validateGameSpec } from '../src/lib/game-design.ts';
import { createGameEngine, gameSandboxDocument, type GameState } from '../src/lib/game-runtime.ts';

test('game schema rejects extra and missing fields at every nesting level', () => {
  const original = defaultGameSpec();
  for (const change of [
    { ...original, script: 'alert(1)' },
    { ...original, player: { ...original.player, url: 'https://example.com' } },
    { ...original, rules: { ...original.rules, unlimited: true } },
    { ...original, objects: { ...original.objects, asset: 'secret' } },
    { ...original, version: 2 },
  ]) assert.throws(() => validateGameSpec(change));
  const missing = { ...original } as Record<string, unknown>; delete missing.instructions;
  assert.throws(() => validateGameSpec(missing), /missing or unexpected/);
  assert.throws(() => validateGameSpec({ ...original, player: [] }));
});

test('game schema enforces bounded integers, plain text, and fixed rendering options', () => {
  for (const bad of [-1, 0, 2.5, 41, Infinity, NaN, '10']) assert.throws(() => validateGameSpec({ ...defaultGameSpec(), rules: { ...defaultGameSpec().rules, goal: bad } }));
  for (const field of ['lives', 'difficulty']) for (const bad of [0, 6, 1.2]) assert.throws(() => validateGameSpec({ ...defaultGameSpec(), rules: { ...defaultGameSpec().rules, [field]: bad } }));
  for (const field of ['speed', 'jump']) assert.throws(() => validateGameSpec({ ...defaultGameSpec(), player: { ...defaultGameSpec().player, [field]: 99 } }));
  for (const title of ['<script>alert(1)</script>', 'https://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'fetch(secret)', 'hidden\u0085control', 'line\nbreak', 'x'.repeat(81)]) assert.throws(() => validateGameSpec({ ...defaultGameSpec(), title }));
  assert.throws(() => validateGameSpec({ ...defaultGameSpec(), player: { ...defaultGameSpec().player, color: 'url(secret)' } }));
  assert.throws(() => validateGameSpec({ ...defaultGameSpec(), theme: 'remote' }));
  assert.doesNotThrow(() => validateGameSpec({ ...defaultGameSpec(), description: '', instructions: '', player: { ...defaultGameSpec().player, color: '#AABBCC' } }));
});

test('validator copies nested data and cannot be used to mutate the input', () => {
  const original = defaultGameSpec(), copy = validateGameSpec(original);
  copy.player.speed = 8; copy.rules.goal = 20; copy.objects.hazard = 'boulder';
  assert.equal(original.player.speed, 5); assert.equal(original.rules.goal, 10); assert.equal(original.objects.hazard, 'rock');
});

test('conversational builder makes three playable archetypes and bounded numeric changes', () => {
  const platform = designGame('A space platformer, collect 12, 90 seconds, 3 lives. Call it "Moon Axolotl".');
  assert.equal(platform.spec.genre, 'platformer'); assert.equal(platform.spec.theme, 'space'); assert.equal(platform.spec.rules.goal, 12); assert.equal(platform.spec.rules.timeLimit, 90); assert.equal(platform.spec.title, 'Moon Axolotl');
  assert.match(platform.spec.instructions, /Space or Up jumps/);
  const dodge = designGame('Dodge falling rocks in a garden, difficulty 4, speed 7, color blue.', platform.spec);
  assert.equal(dodge.spec.genre, 'dodge'); assert.equal(dodge.spec.theme, 'garden'); assert.equal(dodge.spec.rules.difficulty, 4); assert.equal(dodge.spec.player.speed, 7); assert.equal(dodge.spec.player.color, '#79b9df');
  const collect = designGame('A collection game with water snacks in a pond, easy, 2 minutes, 5 lives.', dodge.spec);
  assert.equal(collect.spec.genre, 'collect'); assert.equal(collect.spec.theme, 'pond'); assert.equal(collect.spec.rules.timeLimit, 120); assert.equal(collect.spec.rules.lives, 5); assert.equal(collect.spec.rules.difficulty, 1);
  assert.equal(platform.spec.player.speed, 5);
});

test('natural game descriptions honor explicit settings, colors, objects, and numeric goals', () => {
  const result = designGame('A pink axolotl collects 20 stars in a pond and avoids rocks.');
  assert.equal(result.spec.theme, 'pond'); assert.equal(result.spec.rules.goal, 20); assert.equal(result.spec.player.color, '#efadc4'); assert.equal(result.spec.objects.collectible, 'star'); assert.equal(result.spec.objects.hazard, 'rock');
  const garden = designGame('A blue axolotl can collect flowers in a garden and avoid thorns.');
  assert.equal(garden.spec.theme, 'garden'); assert.equal(garden.spec.player.color, '#79b9df'); assert.equal(garden.spec.objects.collectible, 'flower'); assert.equal(garden.spec.objects.hazard, 'thorn');
});

test('collection goals refine an existing platformer or dodge game without replacing its archetype', () => {
  for (const genre of ['platformer', 'dodge'] as const) {
    const original = { ...defaultGameSpec(), genre };
    const result = designGame('Make it a space game, collect 5, 30 seconds.', original);
    assert.equal(result.spec.genre, genre); assert.equal(result.spec.theme, 'space'); assert.equal(result.spec.rules.goal, 5); assert.equal(result.spec.rules.timeLimit, 30);
    assert.equal(designGame('Switch to a collection game.', original).spec.genre, 'collect');
  }
});

test('explicit field edits preserve valid author text and reject unsafe requested changes', () => {
  const edited = designGame('Title: Tiny explorer\nPlayer: Beans\nCollectible: star\nHazard: meteor\nDescription: Explore a quiet sky.');
  assert.equal(edited.spec.title, 'Tiny explorer'); assert.equal(edited.spec.player.name, 'Beans'); assert.equal(edited.spec.objects.collectible, 'star'); assert.equal(edited.spec.description, 'Explore a quiet sky.');
  const unsafe = designGame('Title: <img src=x onerror=alert(1)>\nGoal: 900\nSpeed: 0\nAdd multiplayer and music.', edited.spec);
  assert.equal(unsafe.spec.title, 'Tiny explorer'); assert.equal(unsafe.spec.rules.goal, 10); assert.equal(unsafe.spec.player.speed, 5);
  assert.match(unsafe.reply, /without links or code/); assert.match(unsafe.reply, /Goal must be from 3 to 40/); assert.match(unsafe.reply, /cannot add/);
  const unknown = designGame('Make the next masterpiece!', edited.spec);
  assert.deepEqual(unknown.spec, edited.spec); assert.match(unknown.reply, /Try/);
});

test('collection collision increments score, removes the snack, and reaches the goal', () => {
  const engine = createGameEngine(), spec = defaultGameSpec(), state = engine.create(spec);
  state.score = spec.rules.goal - 1;
  state.entities = [{ id: 1, kind: 'snack', x: state.player.x, y: state.player.y, w: 22, h: 22, vx: 0, vy: 0 }];
  engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.score, spec.rules.goal); assert.equal(state.outcome, 'won'); assert.equal(state.entities.length, 0);
  const elapsed = state.elapsed; engine.step(state, spec, { right: true }, 1 / 60); assert.equal(state.elapsed, elapsed);
});

test('hazards remove one life per invulnerability window and cannot multiply damage in one tick', () => {
  const engine = createGameEngine(), spec = defaultGameSpec(), state = engine.create(spec);
  state.invulnerable = 0;
  const hazard = { id: 10, kind: 'hazard' as const, x: state.player.x, y: state.player.y, w: 30, h: 30, vx: 0, vy: 0 };
  state.entities = [hazard, { ...hazard, id: 11 }];
  engine.step(state, spec, {}, 1 / 60); assert.equal(state.lives, 2);
  engine.step(state, spec, {}, 1 / 60); assert.equal(state.lives, 2);
  state.invulnerable = 0; state.lives = 1; engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.lives, 0); assert.equal(state.outcome, 'lost');
});

test('timeout loses, movement stays in bounds, and simulation ignores invalid time', () => {
  const engine = createGameEngine(), spec = defaultGameSpec(), state = engine.create(spec);
  state.entities = [];
  for (let i = 0; i < 500; i++) engine.step(state, spec, { left: true, up: true }, 1 / 60);
  assert.equal(state.player.x, 0); assert.equal(state.player.y, 12);
  const before = structuredClone(state); engine.step(state, spec, {}, NaN); assert.deepEqual(state, before);
  state.elapsed = spec.rules.timeLimit - 0.001; engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.outcome, 'lost'); assert.equal(state.elapsed, spec.rules.timeLimit);
});

test('platformer jumps, lands on elevated platforms, and requires releasing jump before jumping again', () => {
  const engine = createGameEngine(), spec = { ...defaultGameSpec(), genre: 'platformer' as const }, state = engine.create(spec);
  state.entities = []; state.player.x = 100;
  engine.step(state, spec, { jump: true }, 1 / 60); assert.ok(state.player.vy < 0);
  let landed = false;
  for (let i = 0; i < 120; i++) { engine.step(state, spec, { jump: true }, 1 / 60); if (state.player.grounded) { landed = true; break; } }
  assert.equal(landed, true); assert.equal(state.player.y + state.player.h, 420);
  engine.step(state, spec, { jump: true }, 1 / 60); assert.equal(state.player.vy, 0);
  engine.step(state, spec, {}, 1 / 60); engine.step(state, spec, { jump: true }, 1 / 60); assert.ok(state.player.vy < 0);
});

test('dodge mode spawns moving snacks and hazards and reaps missed objects', () => {
  const engine = createGameEngine(), spec = { ...defaultGameSpec(), genre: 'dodge' as const }, state = engine.create(spec);
  for (let i = 0; i < 120; i++) engine.step(state, spec, {}, 1 / 60);
  assert.ok(state.entities.some(entity => entity.kind === 'snack' && entity.vy > 0));
  assert.ok(state.entities.some(entity => entity.kind === 'hazard' && entity.vy > 0));
  state.entities.push({ id: 999, kind: 'hazard', x: 0, y: 700, w: 30, h: 30, vx: 0, vy: 10 });
  engine.step(state, spec, {}, 1 / 60); assert.equal(state.entities.some(entity => entity.id === 999), false);
});

test('identical validated specs and inputs produce deterministic simulations', () => {
  const engine = createGameEngine();
  for (const genre of ['collect', 'dodge', 'platformer'] as const) {
    const spec = { ...defaultGameSpec(), genre }, a = engine.create(spec), b = engine.create(spec);
    const run = (state: GameState) => { for (let i = 0; i < 300; i++) engine.step(state, spec, { right: i < 80, jump: i % 90 < 30 }, 1 / 60); };
    run(a); run(b); assert.deepEqual(a, b);
  }
});

test('sandbox document contains fixed executable code, restrictive CSP, and nonce/source checked messages', () => {
  const nonce = 'a1234567890b1234567890c1234567890d';
  const document = gameSandboxDocument(nonce);
  assert.match(document, /default-src 'none'/); assert.match(document, /connect-src 'none'/); assert.match(document, /form-action 'none'/); assert.match(document, /script-src 'nonce-/);
  assert.match(document, /event\.source\s*!==\s*parent/); assert.match(document, /event\.data\.nonce\s*!==\s*nonce/);
  assert.doesNotMatch(document, /\beval\s*\(|new Function\s*\(|\.innerHTML\s*=|localStorage|sessionStorage|https?:\/\//);
  assert.doesNotMatch(document, /Axolotl Pond Adventure/);
  const script = document.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1];
  assert.doesNotThrow(() => new Script(script));
  const messages: unknown[] = [];
  const listeners: Record<string, (event: { source: unknown; data: unknown }) => void> = {};
  const elements = new Map<string, Record<string, unknown>>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', disabled: true, addEventListener() {}, setAttribute() {}, getContext: () => ({}), focus() {} });
    return elements.get(id)!;
  };
  const parent = { postMessage(value: unknown) { messages.push(value); } };
  new Script(script).runInNewContext({ document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} }, window: { addEventListener(name: string, fn: typeof listeners[string]) { listeners[name] = fn; } }, parent, requestAnimationFrame() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'axolotl-game-ready', nonce }]);
  listeners.message({ source: {}, data: { type: 'axolotl-game-load', nonce, spec: defaultGameSpec() } });
  assert.equal(elements.get('start')!.disabled, true);
  // Structured clone from another realm is what postMessage provides in a real browser.
  listeners.message({ source: parent, data: { type: 'axolotl-game-load', nonce: 'wrong', spec: defaultGameSpec() } });
  assert.equal(elements.get('start')!.disabled, true);
  assert.throws(() => gameSandboxDocument('bad\"><script>'), /safe random/);
});
