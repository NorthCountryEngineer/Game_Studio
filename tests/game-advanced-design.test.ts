import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { defaultAsteroidSettings, designGame, updateAsteroidEnemies, updateAsteroidSettings, validateGameSpec, reconcileArcadeFormat } from '../src/lib/game-design.ts';
import { gameReviewLevelIds, isEndlessAsteroids, type ArcadeGameSpec } from '../src/lib/game-types.ts';
import { setCooperativeMode, setPowerUpsEnabled, updatePowerUps, updateArcadeLevelPlan } from '../src/lib/game-multiplayer-design.ts';

const asteroid = () => designGame('Asteroids with three levels.').spec as ArcadeGameSpec;
const advanced = () => updateAsteroidSettings(asteroid(), { endless: true, sizes: 3, enemies: { enabled: true, difficulty: 'hard', hitPoints: 3 } });

test('v6 is strict and explicitly opt-in while old editions retain their shape', () => {
  const old = asteroid(), original = JSON.stringify(old);
  assert.equal(old.version, 2); assert.equal(old.asteroids, undefined);
  assert.deepEqual(validateGameSpec(old), old);
  const spec = advanced();
  assert.equal(spec.version, 6); assert.deepEqual(validateGameSpec(spec), spec);
  assert.equal(JSON.stringify(old), original);
  assert.deepEqual(defaultAsteroidSettings(), { endless: false, difficultyInterval: 30, sizes: 2, enemies: { enabled: false, difficulty: 'easy', hitPoints: 1, spawnInterval: 15, maxShips: 2 } });
  for (const mutate of [
    (v: any) => { v.asteroids.endless = 1; }, (v: any) => { v.asteroids.difficultyInterval = 9; },
    (v: any) => { v.asteroids.sizes = 4; }, (v: any) => { v.asteroids.enemies.difficulty = 'expert'; },
    (v: any) => { v.asteroids.enemies.hitPoints = 11; }, (v: any) => { v.asteroids.enemies.spawnInterval = 4; },
    (v: any) => { v.asteroids.enemies.maxShips = 7; }, (v: any) => { v.asteroids.enemies.enabled = 'true'; },
    (v: any) => { v.asteroids.extra = true; }, (v: any) => { v.genre = 'collect'; },
    (v: any) => { v.arcade.shooting = v.arcade.splitAsteroids = false; }, (v: any) => { v.version = 2; },
  ]) { const invalid = structuredClone(spec); mutate(invalid); assert.throws(() => validateGameSpec(invalid)); }
  assert.throws(() => updateAsteroidSettings(spec, { difficultyInterval: 121 }));
});

test('explicit advanced controls preserve authored plans, prizes and cooperative choices', () => {
  const old = asteroid(); old.progression = 'Authored route.'; old.levels![0].brief = 'Original first level.';
  const spec = updateAsteroidSettings(old, { endless: true, sizes: 3 });
  assert.deepEqual(spec.levels, old.levels); assert.equal(spec.progression, old.progression);
  assert.deepEqual(gameReviewLevelIds(spec), [old.levels![0].id]); assert.equal(isEndlessAsteroids(spec), true);
  const restored = updateAsteroidSettings(spec, { endless: false });
  assert.deepEqual(restored.levels, old.levels); assert.equal(restored.version, 6); assert.equal(gameReviewLevelIds(restored).length, 3);
  const enemies = updateAsteroidEnemies(spec, { hitPoints: 4 }); assert.equal(enemies.asteroids!.enemies.enabled, false);
  const coop = setCooperativeMode(spec, true), prizes = setPowerUpsEnabled(coop, true);
  assert.equal(prizes.version, 6); assert.deepEqual(prizes.asteroids, spec.asteroids);
  assert.equal(updatePowerUps(prizes, { duration: 12 }).powerUps!.duration, 12);
  assert.deepEqual(setCooperativeMode(setPowerUpsEnabled(prizes, false), false).asteroids, spec.asteroids);
  assert.equal(updateArcadeLevelPlan(spec, spec.levels!).version, 6);
  const changed = reconcileArcadeFormat({ ...prizes, genre: 'platformer', arcade: undefined });
  assert.equal(changed.version, 4); assert.equal(changed.asteroids, undefined); assert.equal(changed.powerUps, undefined); assert.deepEqual(changed.levels, old.levels);
});

test('advanced descriptions do not change timers or authored levels and honor negation', () => {
  const old = asteroid(); old.levels![0].brief = 'A custom route.';
  const spec = designGame('Add medium enemy ships with 3 hit points, spawn interval 9 seconds, max 4 enemy ships, ramp every 25 seconds.', old).spec as ArcadeGameSpec;
  assert.equal(spec.version, 6); assert.equal(spec.rules.timeLimit, old.rules.timeLimit); assert.equal(spec.rules.difficulty, old.rules.difficulty);
  assert.deepEqual(spec.levels, old.levels);
  assert.deepEqual(spec.asteroids!.enemies, { enabled: true, difficulty: 'medium', hitPoints: 3, spawnInterval: 9, maxShips: 4 });
  assert.equal(spec.asteroids!.difficultyInterval, 25);
  const off = designGame('No enemy ships. Endless false. Two asteroid sizes.', spec).spec as ArcadeGameSpec;
  assert.equal(off.asteroids!.enemies.enabled, false); assert.equal(off.asteroids!.endless, false); assert.equal(off.asteroids!.sizes, 2);
  const negated = designGame("Don't add enemy ships. Not an endless game.", spec).spec as ArcadeGameSpec;
  assert.equal(negated.asteroids!.enemies.enabled, false); assert.equal(negated.asteroids!.endless, false);
  const forever = designGame('No time limit.', off).spec as ArcadeGameSpec;
  assert.equal(forever.asteroids!.endless, true);
  for (const message of ['Title: Endless enemy ships', 'Description: Three asteroid sizes with enemy ships', 'Call it “Perpetual enemy ships”.']) assert.notEqual(designGame(message, old).spec.version, 6, message);
  assert.equal((designGame('Title: A new title', spec).spec as ArcadeGameSpec).asteroids!.enemies.hitPoints, 3);
});

test('browser and API advanced planners return identical specs and replies', () => {
  const old = asteroid(), current = advanced();
  const cases = [
    { message: 'An Asteroids arcade game with 3 levels, endless survival, three asteroid sizes, shields and triple shot, medium enemy ships with 2 hit points, high scores and rotating shooting.' },
    { message: 'Perpetual Asteroids with three sizes and hard enemy ships.' },
    { message: 'No time limit. No enemy ships.', current: old },
    { message: 'Endless false and enemy ships off.', current },
    { message: "Don't add enemy ships. Not an endless game.", current },
    { message: 'I don’t want any enemy ships. Disable perpetual play.', current },
    { message: 'Add medium enemy ships with 3 hit points, spawn interval 9 seconds, max 4 enemy ships, ramp every 25 seconds.', current: old },
    { message: 'Enemy difficulty hard. Enemy hit points 10. Enemy ships every 60 seconds. Maximum ships 6. Difficulty interval 120 seconds.', current },
    { message: 'Enemy hit points 11. Spawn interval 1 seconds. Max 9 ships. Difficulty interval 5 seconds.', current },
    { message: 'Title: Endless enemy ships', current: old }, { message: 'Description: Three asteroid sizes with enemy ships', current: old },
    { message: 'Call it “Perpetual enemy ships”.', current: old },
    { message: 'Title: New name', current }, { message: 'Shuffle layouts.', current },
    { message: 'Level 2 harder.', current }, { message: 'No prizes. Add cooperation.', current },
    { message: 'Add prizes. No multiplayer.', current }, { message: 'Disable shooting.', current },
    { message: 'Switch to a collection game.', current }, { message: 'Restore timed levels.', current },
  ];
  const python = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('advanced_parity',Path.cwd()/'backend/nce_api/games.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps([m.design_game(c['message'],c.get('current')) for c in json.load(sys.stdin)],ensure_ascii=False))`;
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify(cases), encoding: 'utf8' }));
  cases.forEach((entry, i) => assert.deepEqual(actual[i], designGame(entry.message, entry.current), entry.message));
  const example = designGame(cases[0].message).spec as ArcadeGameSpec;
  assert.match(example.instructions, /two medium, then four small/); assert.match(example.instructions, /medium enemy ships take 2 hits; they track you/); assert.ok(example.instructions.length <= 300);
});
