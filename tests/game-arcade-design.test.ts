import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { defaultGameSpec, designGame, getGameLevels, planGameLevels, validateGameSpec } from '../src/lib/game-design.ts';
import type { GameArcadeOptions } from '../src/lib/game-types';

const allOptions: GameArcadeOptions = { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true };

test('optional arcade data is strict, copied, and leaves legacy specs unchanged', () => {
  const legacy = defaultGameSpec();
  assert.equal(JSON.stringify(validateGameSpec(legacy)), JSON.stringify(legacy));
  assert.equal(Object.hasOwn(validateGameSpec(legacy), 'arcade'), false);
  assert.equal(Object.hasOwn(designGame('A space dodging game.').spec, 'arcade'), false);
  for (const version of [1, 2] as const) for (let bits = 0; bits < 32; bits++) {
    const arcade = Object.fromEntries(Object.keys(allOptions).map((key, index) => [key, !!(bits & 1 << index)])) as GameArcadeOptions;
    const base = { ...legacy, genre: 'dodge' as const, arcade };
    const candidate = version === 1 ? base : planGameLevels({ ...base, arcade: allOptions }, 2, 'stable');
    candidate.arcade = arcade;
    if (arcade.splitAsteroids && !arcade.shooting || arcade.highScores && !arcade.scoring) assert.throws(() => validateGameSpec(candidate));
    else {
      const copied = validateGameSpec(candidate);
      assert.deepEqual(copied.arcade, arcade);
      copied.arcade!.rotation = !arcade.rotation;
      assert.equal(candidate.arcade.rotation, arcade.rotation);
    }
  }
});

test('arcade options reject missing, unknown, nonboolean, and unsupported genre fields', () => {
  const base = { ...defaultGameSpec(), genre: 'dodge' as const };
  for (const arcade of [null, [], true, {}, { ...allOptions, code: 'run' }, { ...allOptions, shooting: 1 }, { ...allOptions, highScores: 'true' }, { ...allOptions, rotation: undefined }]) assert.throws(() => validateGameSpec({ ...base, arcade }));
  for (const key of Object.keys(allOptions)) {
    const arcade = { ...allOptions } as Record<string, unknown>; delete arcade[key];
    assert.throws(() => validateGameSpec({ ...base, arcade }));
  }
  for (const genre of ['collect', 'platformer']) assert.throws(() => validateGameSpec({ ...base, genre, arcade: allOptions }));
  assert.throws(() => validateGameSpec({ ...base, arcade: { ...allOptions, shootUrl: 'https://example.com' } }));
});

test('Asteroids defaults and conversational switches produce independent supported options', () => {
  const first = designGame('Asteroids with three levels, collect 12, 90 seconds.');
  assert.equal(first.spec.genre, 'dodge'); assert.equal(first.spec.theme, 'space');
  assert.equal(first.spec.objects.hazard, 'asteroid'); assert.deepEqual(first.spec.arcade, allOptions);
  assert.equal(first.spec.levels!.length, 3); assert.equal(first.spec.levels!.at(-1)!.rules.goal, 12);
  assert.match(first.spec.instructions, /turn 360 degrees/); assert.match(first.spec.instructions, /Space fires/);
  assert.match(first.spec.instructions, /two pieces/); assert.match(first.spec.instructions, /snacks 10, large hits 20, small pieces 50/);
  assert.doesNotMatch(first.reply, /cannot add.*(?:shooting|leaderboard)/);
  const rotation = designGame('Turn rotation off.', first.spec).spec;
  assert.deepEqual(rotation.arcade, { ...allOptions, rotation: false }); assert.match(rotation.instructions, /WASD to move/);
  const shooting = designGame('Disable shooting.', first.spec).spec;
  assert.deepEqual(shooting.arcade, { ...allOptions, shooting: false, splitAsteroids: false });
  assert.doesNotMatch(shooting.instructions, /Space fires|large hits|small pieces/);
  const split = designGame('Splitting off.', first.spec).spec;
  assert.deepEqual(split.arcade, { ...allOptions, splitAsteroids: false });
  assert.match(split.instructions, /One shot destroys an asteroid/); assert.doesNotMatch(split.instructions, /small pieces/);
  const points = designGame('Points off.', first.spec).spec;
  assert.deepEqual(points.arcade, { ...allOptions, scoring: false, highScores: false }); assert.doesNotMatch(points.instructions, /Points:/);
  assert.equal(designGame('High scores off.', first.spec).spec.arcade!.scoring, true);
  const restored = designGame('Enable leaderboard and splitting.', { ...shooting, arcade: { ...shooting.arcade!, scoring: false, highScores: false } }).spec;
  assert.deepEqual(restored.arcade, allOptions);
  assert.deepEqual(designGame('Shooting off, splitting on. Scoring off, high scores on.', first.spec).spec.arcade, { ...allOptions, shooting: false, splitAsteroids: false, scoring: false, highScores: false });
  const onlyRotation = designGame('Enable 360-degree turning.').spec;
  assert.deepEqual(onlyRotation.arcade, { rotation: true, shooting: false, splitAsteroids: false, scoring: false, highScores: false });
  const garden = designGame('A garden arcade game.').spec;
  assert.equal(garden.theme, 'garden'); assert.deepEqual(garden.arcade, allOptions);
});

test('level plans, targeted edits, shuffles, and legacy edits preserve arcade options', () => {
  const first = designGame('Asteroids with four levels.').spec;
  const original = structuredClone(first);
  const shuffled = designGame('Shuffle layouts.', first).spec;
  assert.deepEqual(shuffled.arcade, first.arcade);
  assert.ok(shuffled.levels!.every((level, index) => level.seed !== first.levels![index].seed));
  const refined = designGame('Make level 2 harder, collect 12, 90 seconds.', first).spec;
  assert.deepEqual(refined.arcade, first.arcade); assert.deepEqual(refined.levels![0], first.levels![0]);
  assert.equal(refined.levels![1].rules.goal, 12); assert.match(refined.levels![1].brief, /Space fires/);
  const changed = designGame('Level 2 shooting off.', first).spec;
  assert.equal(changed.arcade!.shooting, false); assert.equal(changed.arcade!.splitAsteroids, false);
  assert.ok(changed.levels!.every(level => !/Space fires|split into/.test(level.brief)));
  assert.deepEqual(first, original);
  for (const message of ['Switch to a collection game.', 'Make it a platformer.']) {
    const changedGenre = designGame(message, first).spec;
    assert.equal(Object.hasOwn(changedGenre, 'arcade'), false); assert.doesNotMatch(changedGenre.instructions, /fires|turn 360/);
  }
  const legacy = { ...defaultGameSpec(), genre: 'dodge' as const, arcade: allOptions };
  const saved = designGame('Title: Old space adventure', legacy).spec;
  assert.equal(saved.version, 1); assert.deepEqual(saved.arcade, allOptions);
  assert.equal(getGameLevels(saved).length, 1);
  for (const input of [legacy, planGameLevels(legacy, 8, 'long')]) {
    input.objects.collectible = 'a'.repeat(30); input.rules.goal = 40;
    assert.doesNotThrow(() => designGame('Rotation on.', input));
  }
});

test('global arcade switches preserve authored levels and progression instead of replanning them', () => {
  const original = designGame('Asteroids with three levels.').spec;
  original.progression = 'Explore a moon, visit a garden, and return home.';
  Object.assign(original.levels![1], { title: 'My moon garden', theme: 'garden', brief: 'Look for the hidden flowers beside the moon gate.', seed: 123456 });
  Object.assign(original.levels![1].rules, { goal: 19, timeLimit: 120, lives: 5, difficulty: 4 });
  for (const message of ['Rotation off.', 'Shooting off.', 'Splitting off.', 'Scoring off.', 'High scores off.', 'Level 2 shooting off.']) {
    const changed = designGame(message, original).spec;
    assert.equal(changed.progression, original.progression, message);
    assert.deepEqual(changed.rules, original.rules, message);
    assert.deepEqual(changed.levels![1], original.levels![1], message);
    changed.levels!.forEach((level, index) => {
      const { brief: _changed, ...design } = level, { brief: _original, ...oldDesign } = original.levels![index];
      assert.deepEqual(design, oldDesign, message);
    });
    if (message.includes('shooting')) assert.ok(changed.levels!.every(level => !/Space fires|split into/.test(level.brief)));
    if (message.includes('Rotation')) assert.doesNotMatch(changed.levels![0].brief, /turn 360/);
  }
  const noArcade = structuredClone(original); delete noArcade.arcade;
  const enabled = designGame('Enable rotation.', noArcade).spec;
  assert.equal(enabled.progression, noArcade.progression);
  assert.deepEqual(enabled.levels, noArcade.levels);
  assert.equal(enabled.arcade!.rotation, true);
  const shuffled = designGame('Shooting off and shuffle layouts.', original).spec;
  assert.equal(shuffled.levels![1].brief, original.levels![1].brief);
  assert.equal(shuffled.levels![1].title, original.levels![1].title);
  assert.deepEqual(shuffled.levels![1].rules, original.levels![1].rules);
  assert.notEqual(shuffled.levels![1].seed, original.levels![1].seed);
  const briefOnly = designGame('Rotation off.', original).spec;
  const oldHint = 'Use arrows or WASD to swim. Space fires. Large asteroids split into two pieces; one shot destroys each piece.';
  briefOnly.levels![0].brief = oldHint;
  assert.match(designGame('Rotation on.', briefOnly).spec.levels![0].brief, /^Left\/Right/);
  const authored = 'a'.repeat(300 - oldHint.length - 1);
  briefOnly.levels![0].brief = `${authored} ${oldHint}`;
  assert.equal(designGame('Rotation on.', briefOnly).spec.levels![0].brief, authored);
});

test('API and browser arcade planners and strict validators agree', () => {
  const current = designGame('Asteroids with four levels, collect 16.').spec;
  current.progression = 'Keep my chosen progression.';
  Object.assign(current.levels![1], { title: 'My own garden', theme: 'garden', brief: 'Find the flowers at the edge of the moon.', seed: 12345 });
  Object.assign(current.levels![1].rules, { goal: 19, timeLimit: 120, lives: 5 });
  const messages = ['Asteroids', 'A garden arcade game with two levels.', 'Asteroids, no shooting, no points.', 'Enable shooting.', '360 degree turning on.', 'Rotation off.', 'No rotation.', 'Turning disabled.', 'Turn off shooting.', 'Without splitting.', 'Split asteroids on.', 'Scoring false.', 'Points off.', 'Point tracking on.', 'High scores off.', 'Leaderboard on.', 'Disable high scores.', 'No shooting and splitting on.', 'No points and leaderboard on.', 'Shooting off then shooting on.', 'Level 2 harder, collect 10.', 'Level 2 rotation off.', 'Randomize level 3.', 'Shuffle layouts.', 'Replan progression with 5 levels.', 'Switch to a collection game.', 'A platformer with shooting.', 'Online leaderboards.', 'Add multiplayer and music.', 'Title: Moon 🦎'];
  const cases = [...messages.map(message => ({ message, current })), ...messages.slice(0, 20).map(message => ({ message }))];
  const validation: unknown[] = [defaultGameSpec(), current];
  for (let bits = 0; bits < 32; bits++) validation.push({ ...current, arcade: Object.fromEntries(Object.keys(allOptions).map((key, index) => [key, !!(bits & 1 << index)])) });
  for (const arcade of [null, [], {}, { ...allOptions, rotation: 1 }, { ...allOptions, shooting: 'false' }, { ...allOptions, extra: true }]) validation.push({ ...current, arcade });
  validation.push({ ...current, genre: 'collect' });
  const python = `import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('parity_arcade',Path.cwd()/'backend/nce_api/games.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
data=json.load(sys.stdin)
def valid(v):
 try: m.validate_spec(v);return True
 except m.GameError: return False
print(json.dumps({'plans':[m.design_game(c['message'],c.get('current')) for c in data['cases']],'valid':[valid(v) for v in data['validation']]},ensure_ascii=False))`;
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify({ cases, validation }), encoding: 'utf8' }));
  cases.forEach((entry, index) => assert.deepEqual(actual.plans[index], designGame(entry.message, 'current' in entry ? entry.current : undefined), entry.message));
  validation.forEach((value, index) => {
    let valid = true; try { validateGameSpec(value); } catch { valid = false; }
    assert.equal(actual.valid[index], valid, `Validation case ${index}`);
  });
});
