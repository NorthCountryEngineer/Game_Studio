import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { defaultGameSpec } from '../src/lib/game-design.ts';
import { createGameEngine, gameSandboxDocument, startGameSandbox, validateGameResult } from '../src/lib/game-runtime.ts';
import type { GameResult, GameSpec } from '../src/lib/game-types.ts';

function campaign(genre: GameSpec['genre'] = 'collect'): GameSpec {
  const spec = defaultGameSpec();
  return { ...spec, version: 2, genre, player: { ...spec.player, jump: 6, speed: 2 }, progression: 'Learn the controls, then practice with more obstacles.', levels: [
    { id: 'level-1', title: 'Getting started', brief: 'Find three treasures.', theme: 'pond', rules: { goal: 3, timeLimit: 60, lives: 5, difficulty: 1 }, seed: 1001 },
    { id: 'level-2', title: 'A little challenge', brief: 'Find six treasures with more obstacles.', theme: 'garden', rules: { goal: 6, timeLimit: 90, lives: 3, difficulty: 3 }, seed: 2027 },
  ] };
}

test('saved seeds reproduce every archetype and changing a seed changes its layout or spawn sequence', () => {
  const engine = createGameEngine();
  for (const genre of ['collect', 'dodge', 'platformer'] as const) {
    const spec = campaign(genre), different = structuredClone(spec); different.levels![0].seed++;
    const a = engine.create(spec), b = engine.create(spec), c = engine.create(different);
    for (let i = 0; i < 90; i++) for (const [state, source] of [[a, spec], [b, spec], [c, different]] as const) engine.step(state, source, { right: i < 30 }, 1 / 60);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.entities, c.entities);
    if (genre === 'platformer') assert.notDeepEqual(a.platforms, c.platforms);
  }
});

test('platform layouts remain reachable with minimum speed and jump across many seeds', () => {
  const engine = createGameEngine(), spec = campaign('platformer');
  for (let seed = 1; seed <= 100; seed++) {
    spec.levels![0].seed = seed;
    const initial = engine.create(spec);
    for (let i = 1; i < initial.platforms.length; i++) {
      const below = initial.platforms[i - 1], above = initial.platforms[i];
      assert.equal(below.y - above.y, 75);
      const left = Math.max(below.x, above.x), right = Math.min(below.x + below.w, above.x + above.w);
      assert.ok(right - left >= 50, `seed ${seed} has a safe overlap`);
      // Exercise the actual jump/collision solver, including its maximum step.
      for (const dt of [1 / 60, 1 / 20]) {
        const state = engine.create(spec); state.entities = [];
        state.player.x = left + (right - left - state.player.w) / 2;
        state.player.y = below.y - state.player.h; state.player.grounded = true;
        engine.step(state, spec, { jump: true }, dt);
        for (let frame = 0; frame < 100 && !state.player.grounded; frame++) engine.step(state, spec, {}, dt);
        assert.equal(state.player.y + state.player.h, above.y, `seed ${seed}, step ${dt}, platform ${i}`);
      }
    }
    for (const entity of initial.entities) assert.equal(engine.overlaps(initial.player, entity), false);
    for (let i = 0; i < initial.entities.length; i++) for (let j = i + 1; j < initial.entities.length; j++) assert.equal(engine.overlaps(initial.entities[i], initial.entities[j]), false);
  }
});

test('level transitions require winning and reset local score, time, and lives to that level rules', () => {
  const engine = createGameEngine(), spec = campaign(), first = engine.create(spec);
  assert.equal(first.lives, 5); assert.equal(engine.nextLevel(first, spec), undefined);
  first.outcome = 'lost'; assert.equal(engine.nextLevel(first, spec), undefined);
  first.outcome = 'won'; first.score = 3; first.lives = 1; first.elapsed = 40;
  const second = engine.nextLevel(first, spec)!;
  assert.equal(second.levelId, 'level-2'); assert.equal(second.levelIndex, 1);
  assert.equal(second.lives, 3); assert.equal(second.score, 0); assert.equal(second.elapsed, 0);
  second.outcome = 'won'; assert.equal(engine.nextLevel(second, spec), undefined);
  assert.deepEqual(engine.create(spec, 'level-2'), engine.create(spec, 1));
  assert.throws(() => engine.create(spec, 'level-8')); assert.throws(() => engine.create(spec, -1));
});

test('each level uses its own goals, lives, theme and time rather than the top-level defaults', () => {
  const engine = createGameEngine(), spec = campaign(), state = engine.create(spec, 1);
  assert.equal(engine.forLevel(spec, 1).theme, 'garden');
  state.score = 5; state.entities = [{ id: 100, kind: 'snack', x: state.player.x, y: state.player.y, w: 22, h: 22, vx: 0, vy: 0 }];
  engine.step(state, spec, {}, 1 / 60); assert.equal(state.outcome, 'won'); assert.equal(state.score, 6);
  const timeout = engine.create(spec, 1); timeout.entities = []; timeout.elapsed = 89.99;
  engine.step(timeout, spec, {}, 1 / 20); assert.equal(timeout.elapsed, 90); assert.equal(timeout.outcome, 'lost');
});

test('legacy games retain their original single-level seed and platform geometry', () => {
  const engine = createGameEngine(), spec = { ...defaultGameSpec(), genre: 'platformer' as const }, state = engine.create(spec);
  assert.deepEqual(state.platforms, [{ x: 0, y: 500, w: 960, h: 40 }, { x: 40, y: 420, w: 270, h: 16 }, { x: 250, y: 340, w: 270, h: 16 }, { x: 460, y: 260, w: 270, h: 16 }, { x: 650, y: 180, w: 270, h: 16 }, { x: 430, y: 100, w: 270, h: 16 }]);
  assert.deepEqual(engine.getLevels(spec)[0].seed, 17031);
  state.outcome = 'won'; assert.equal(engine.nextLevel(state, spec), undefined);
});

test('parent result validation bounds aggregate values and prevents isolated or partial campaign wins', () => {
  const spec = campaign();
  const result: GameResult = { outcome: 'won', elapsed: 150, score: 9, reviewedLevelIds: ['level-1', 'level-2'] };
  assert.deepEqual(validateGameResult(result, spec), result);
  for (const change of [
    { elapsed: 151 }, { elapsed: NaN }, { score: 10 }, { score: 8 }, { score: 1.5 }, { score: -1 }, { outcome: 'level-complete' },
    { reviewedLevelIds: [] }, { reviewedLevelIds: ['level-1'] }, { reviewedLevelIds: ['level-1', 'level-1'] }, { reviewedLevelIds: ['level-2', 'level-1'] }, { reviewedLevelIds: ['level-9'] },
  ]) assert.equal(validateGameResult({ ...result, ...change }, spec), undefined);
  const selected = { outcome: 'level-complete', elapsed: 90, score: 6, reviewedLevelIds: ['level-2'] };
  assert.deepEqual(validateGameResult(selected, spec, 'level-2'), selected);
  assert.equal(validateGameResult({ ...selected, outcome: 'won' }, spec, 'level-2'), undefined);
  assert.equal(validateGameResult({ ...selected, reviewedLevelIds: ['level-1'] }, spec, 'level-2'), undefined);
  assert.equal(validateGameResult({ ...selected, elapsed: 91 }, spec, 'level-2'), undefined);
  assert.equal(validateGameResult(selected, spec), undefined);
});

// Round physics are exercised above. This harness isolates the browser's campaign
// orchestration so transitions, callbacks, and review totals do not need a timed game.
function sandboxHarness(spec: GameSpec, levelId?: string, finish: 'won' | 'lost' = 'won') {
  type Element = { textContent: string; disabled: boolean; hidden: boolean; handlers: Record<string, () => void>; addEventListener: (name: string, fn: () => void) => void; setAttribute(): void; getContext(): unknown; focus(): void };
  const elements = new Map<string, Element>(), messages: { type: string; result?: GameResult }[] = [], frames: ((now: number) => void)[] = [];
  const getElement = (id: string) => {
    if (!elements.has(id)) { const item: Element = { textContent: '', disabled: true, hidden: ['next', 'restart'].includes(id), handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {}, getContext: () => new Proxy({}, { get: () => () => {} }), focus() {} }; elements.set(id, item); }
    return elements.get(id)!;
  };
  const listeners: Record<string, (event: unknown) => void> = {}, parent = { postMessage(value: { type: string; result?: GameResult }) { messages.push(JSON.parse(JSON.stringify(value))); } };
  const actual = createGameEngine(), engine = { ...actual, step(state: ReturnType<typeof actual.create>, source: GameSpec) { state.elapsed = 3; state.score = actual.forLevel(source, state.levelIndex).rules.goal; state.outcome = finish; return state; } };
  new Script(`const __name = fn => fn; (${startGameSandbox.toString()})(engine, validate, '1234567890abcdef');`).runInNewContext({
    engine, validate: (value: GameSpec) => value, parent,
    document: { getElementById: getElement, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener(name: string, fn: typeof listeners[string]) { listeners[name] = fn; } },
    requestAnimationFrame(fn: (now: number) => void) { frames.push(fn); },
  });
  listeners.message({ source: parent, data: { type: 'axolotl-game-load', nonce: '1234567890abcdef', spec, levelId } });
  let clock = 1000;
  const tick = () => { const frame = frames.shift(); assert.ok(frame); frame(clock += 1000 / 30); };
  const click = (id: string) => getElement(id).handlers.click();
  const complete = () => { const count = messages.filter(message => message.result).length; for (let i = 0; i < 5 && messages.filter(message => message.result).length === count; i++) tick(); };
  return { elements, messages, tick, click, complete };
}

test('campaign player emits per-level reviews, advances explicitly, totals results, and restarts cleanly', () => {
  const harness = sandboxHarness(campaign());
  harness.click('start'); harness.complete();
  let results = harness.messages.filter(message => message.result).map(message => message.result!);
  assert.deepEqual(results, [{ outcome: 'level-complete', elapsed: 3, score: 3, reviewedLevelIds: ['level-1'] }]);
  assert.equal(harness.elements.get('next')!.hidden, false);
  harness.click('next'); harness.complete();
  results = harness.messages.filter(message => message.result).map(message => message.result!);
  assert.deepEqual(results[1], { outcome: 'won', elapsed: 6, score: 9, reviewedLevelIds: ['level-1', 'level-2'] });
  assert.equal(harness.elements.get('next')!.hidden, true);
  harness.click('restart'); harness.complete();
  assert.deepEqual(harness.messages.at(-1)!.result, results[0]);
});

test('selected-level preview cannot unlock later levels or report a full campaign win', () => {
  const harness = sandboxHarness(campaign(), 'level-2');
  harness.click('start'); harness.complete();
  assert.deepEqual(harness.messages.at(-1)!.result, { outcome: 'level-complete', elapsed: 3, score: 6, reviewedLevelIds: ['level-2'] });
  assert.equal(harness.elements.get('next')!.hidden, true);
  assert.equal(harness.elements.get('restart')!.hidden, true);
  harness.click('start'); harness.complete();
  assert.deepEqual(harness.messages.at(-1)!.result, { outcome: 'level-complete', elapsed: 3, score: 6, reviewedLevelIds: ['level-2'] });
});

test('losing a level reports its review but leaves the next level locked', () => {
  const harness = sandboxHarness(campaign(), undefined, 'lost');
  harness.click('start'); harness.complete();
  assert.equal(harness.messages.at(-1)!.result!.outcome, 'lost');
  assert.equal(harness.elements.get('next')!.hidden, true);
});

test('serialized multi-level player remains fixed and valid JavaScript with the restrictive CSP', () => {
  const html = gameSandboxDocument('1234567890abcdef');
  assert.match(html, /connect-src 'none'/); assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /Getting started|A little challenge|Learn the controls/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1];
  assert.doesNotThrow(() => new Script(script));
});


test('level instructions retain authored briefs and always state the actual current objective', () => {
  const spec = campaign(); spec.levels![0].brief = 'Collect five treasures to learn the controls.';
  spec.levels![0].rules.goal = 7;
  const harness = sandboxHarness(spec);
  const objective = 'Objective: Collect 7 water snacks in 60 seconds. 5 lives. Avoid rocks.';
  assert.equal(harness.elements.get('instruction')!.textContent, `${spec.levels![0].brief} ${objective}`);
  harness.click('start'); assert.match(harness.elements.get('instruction')!.textContent, /Collect 7 water snacks/);
  harness.complete(); harness.click('next');
  assert.match(harness.elements.get('instruction')!.textContent, /Objective: Collect 6 water snacks in 90 seconds. 3 lives. Avoid rocks./);
  const legacy = defaultGameSpec(); legacy.instructions = 'My original instructions, exactly as written.';
  const old = sandboxHarness(legacy); assert.equal(old.elements.get('instruction')!.textContent, legacy.instructions);
  old.click('start'); assert.equal(old.elements.get('instruction')!.textContent, legacy.instructions);
});
