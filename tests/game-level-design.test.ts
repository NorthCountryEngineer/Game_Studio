import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultGameSpec, designGame, getGameLevels, validateGameSpec } from '../src/lib/game-design.ts';

test('new games plan an introduction, practice, and finale from the requested rules', () => {
  const { spec, reply } = designGame('A gentle pond platformer. Collect 20 bubbles, 90 seconds, 4 lives.');
  assert.equal(spec.version, 2);
  const levels = getGameLevels(spec);
  assert.equal(levels.length, 3);
  assert.deepEqual(levels.map(level => level.rules.goal), [12, 16, 20]);
  assert.deepEqual(levels.map(level => level.rules.difficulty), [1, 1, 2]);
  assert.ok(levels.every(level => level.rules.lives === 4 && level.rules.timeLimit === 90));
  assert.match(levels[0].brief, /Learn the controls/);
  assert.match(levels[2].brief, /Put your practice together/);
  assert.match(reply, /free guided plan uses fixed progression rules/);
  assert.match(spec.instructions, /each level/);
  assert.deepEqual(validateGameSpec(spec), spec);
});

test('requested level count is bounded and single-level games retain the full objective', () => {
  for (const [prompt, count] of [['one level', 1], ['eight levels', 8], ['levels: 5', 5], ['4-level adventure', 4], ['4 gentle levels', 4], ['99 levels', 3]] as const) {
    const { spec } = designGame(`A space game, collect 10, ${prompt}.`);
    assert.equal(getGameLevels(spec).length, count);
    assert.equal(getGameLevels(spec).at(-1)!.rules.goal, 10);
  }
  assert.match(designGame('99 levels').reply, /1 to 8/);
  const custom = designGame('A space game.').spec;
  custom.levels![0].title = 'My own opening'; custom.levels![1].rules.goal = 17;
  assert.deepEqual(designGame('99 levels', custom).spec, custom);
});

test('legacy games are neither upgraded nor randomized by unrelated conversation', () => {
  const original = defaultGameSpec();
  assert.deepEqual(designGame('Tell me a joke.', original).spec, original);
  const legacy = getGameLevels(original);
  assert.equal(legacy.length, 1); assert.equal(legacy[0].seed, 17031);
  assert.deepEqual(legacy[0].rules, original.rules);
  legacy[0].rules.goal = 40;
  assert.equal(original.rules.goal, 10);
  assert.equal(designGame('Add levels.', original).spec.version, 2);
});

test('seeded layouts are stable until an explicit shuffle, including repeated shuffles', () => {
  const first = designGame('A space game with 4 levels.').spec;
  const seeds = getGameLevels(first).map(level => level.seed);
  assert.equal(new Set(seeds).size, 4);
  assert.deepEqual(designGame('A space game with 4 levels.').spec, first);
  assert.deepEqual(getGameLevels(designGame('Title: Star explorer', first).spec).map(level => level.seed), seeds);
  assert.deepEqual(getGameLevels(designGame('Collect 18.', first).spec).map(level => level.seed), seeds);
  const shuffled = designGame('Shuffle layouts.', first).spec;
  assert.ok(getGameLevels(shuffled).every((level, index) => level.seed !== seeds[index]));
  assert.notDeepEqual(getGameLevels(designGame('Shuffle layouts.', shuffled).spec).map(level => level.seed), getGameLevels(shuffled).map(level => level.seed));
  assert.deepEqual(getGameLevels(designGame('Tell me a joke.', shuffled).spec), getGameLevels(shuffled));
});

test('conversation can refine a particular level without replacing other planned levels', () => {
  const original = designGame('A pond game with 4 levels, collect 20, 90 seconds.').spec;
  const edited = designGame('Make level 2 harder, collect 10, 60 seconds.', original).spec;
  assert.deepEqual(edited.rules, original.rules);
  assert.equal(edited.levels![1].rules.difficulty, 4);
  assert.equal(edited.levels![1].rules.goal, 10);
  assert.equal(edited.levels![1].rules.timeLimit, 60);
  for (const index of [0, 2, 3]) assert.deepEqual(edited.levels![index], original.levels![index]);
  const changed = designGame('Randomize level layouts for level 3.', edited).spec;
  assert.notEqual(changed.levels![2].seed, edited.levels![2].seed);
  for (const index of [0, 1, 3]) assert.deepEqual(changed.levels![index], edited.levels![index]);
  const reset = designGame('Level 1 20 snacks, time 90, lives 3.', original).spec;
  assert.equal(reset.levels![0].rules.goal, 20);
  assert.equal(reset.levels![0].rules.timeLimit, 90);
  assert.equal(reset.levels![0].rules.lives, 3);
  assert.notEqual(designGame('Randomize level 2.', original).spec.levels![1].seed, original.levels![1].seed);
});

test('v2 validation rejects unsafe, ambiguous, missing, or unbounded plans', () => {
  const original = designGame('A garden game.').spec;
  for (const mutation of [
    (spec: typeof original) => { delete spec.progression; },
    (spec: typeof original) => { spec.progression = 'x'.repeat(301); },
    (spec: typeof original) => { spec.levels = []; },
    (spec: typeof original) => { spec.levels = Array(9).fill(spec.levels![0]); },
    (spec: typeof original) => { spec.levels![1].id = spec.levels![0].id; },
    (spec: typeof original) => { spec.levels![0].seed = 0; },
    (spec: typeof original) => { spec.levels![0].seed = 2147483648; },
    (spec: typeof original) => { spec.levels![0].brief = 'https://unsafe.example'; },
    (spec: typeof original) => { spec.levels![0].rules.goal = 41; },
    (spec: typeof original) => { Object.assign(spec.levels![0], { code: 'anything' }); },
  ]) { const candidate = structuredClone(original); mutation(candidate); assert.throws(() => validateGameSpec(candidate)); }
  assert.throws(() => validateGameSpec({ ...defaultGameSpec(), levels: original.levels }));
  const clean = validateGameSpec(original); clean.levels![0].rules.goal = 40;
  assert.notEqual(original.levels![0].rules.goal, 40);
});
