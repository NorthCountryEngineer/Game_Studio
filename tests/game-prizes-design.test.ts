import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { defaultPowerUps, designArcadeGame, getGameLevels, planGameLevels, validateGameSpec } from '../src/lib/game-design.ts';
import { isCooperativeGameSpec, type ArcadeGameSpec } from '../src/lib/game-types.ts';

function prizes(cooperative = false): ArcadeGameSpec {
  return designArcadeGame(`Asteroids with three levels and periodic prizes${cooperative ? ' and two-player cooperation' : ''}.`).spec;
}

test('prize format is explicit, bounded, copied, and compatible with optional cooperation', () => {
  for (const cooperative of [false, true]) {
    const spec = prizes(cooperative), clean = validateGameSpec(spec);
    assert.equal(clean.version, 5); assert.deepEqual(clean.powerUps, defaultPowerUps());
    assert.equal(isCooperativeGameSpec(clean), cooperative);
    assert.equal(clean.levels!.length, 3); assert.deepEqual(getGameLevels(spec), spec.levels);
    clean.powerUps!.types.pop(); assert.equal(spec.powerUps!.types.length, 4);
  }
  const normal = designArcadeGame('Asteroids with three levels.').spec;
  assert.equal(normal.version, 2); assert.equal(normal.powerUps, undefined);
});

test('prize schemas reject malformed settings, executable fields, unsupported styles and cross-version contamination', () => {
  const spec = prizes();
  for (const powerUps of [null, [], {}, { ...defaultPowerUps(), code: 'eval()' }, { ...defaultPowerUps(), spawnInterval: 4 }, { ...defaultPowerUps(), spawnInterval: 61 }, { ...defaultPowerUps(), spawnInterval: true }, { ...defaultPowerUps(), duration: 2 }, { ...defaultPowerUps(), duration: 31 }, { ...defaultPowerUps(), duration: 3.5 }, { ...defaultPowerUps(), types: [] }, { ...defaultPowerUps(), types: ['shield', 'shield'] }, { ...defaultPowerUps(), types: ['eval()'] }, { ...defaultPowerUps(), types: [null] }]) assert.throws(() => validateGameSpec({ ...spec, powerUps }));
  for (const edit of [{ genre: 'platformer' }, { genre: 'collect' }, { arcade: { ...spec.arcade, shooting: false, splitAsteroids: false } }, { multiplayer: undefined }, { multiplayer: { mode: 'cooperative', maxPlayers: 3 } }, { version: 2 }, { version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } }]) assert.throws(() => validateGameSpec({ ...spec, ...edit }));
  const { powerUps: _powerUps, ...missing } = spec; assert.throws(() => validateGameSpec(missing));
  for (const version of [1, 2, 4]) {
    const clean = designArcadeGame(version === 4 ? 'Asteroids with multiplayer.' : 'Asteroids.').spec;
    if (version === 1) { clean.version = 1; delete clean.levels; delete clean.progression; }
    assert.throws(() => validateGameSpec({ ...clean, powerUps: defaultPowerUps() }));
  }
});

test('unrelated edits preserve custom prize values, cooperation and authored levels', () => {
  const original = prizes(true);
  original.powerUps = { spawnInterval: 27, duration: 18, types: ['shield', 'triple-shot'] };
  original.progression = 'My custom campaign.';
  original.levels![1].brief = 'My hand written challenge.';
  for (const message of ['Title: Twin rockets', 'Level 2 harder', '4 levels', 'Collect 7', 'shuffle layouts']) {
    const next = designArcadeGame(message, original).spec;
    assert.equal(next.version, 5); assert.deepEqual(next.powerUps, original.powerUps); assert.deepEqual(next.multiplayer, original.multiplayer);
    if (message !== 'shuffle layouts') assert.deepEqual(next.levels!.slice(0, 3).map(level => level.seed), original.levels!.map(level => level.seed));
    if (message.startsWith('Title:')) assert.deepEqual(next.levels, original.levels);
  }
  assert.deepEqual(planGameLevels(original, 4, 'preserve').powerUps, original.powerUps);
  const solo = designArcadeGame('Disable multiplayer.', original).spec;
  assert.equal(solo.version, 5); assert.equal(solo.multiplayer, undefined); assert.deepEqual(solo.powerUps, original.powerUps);
  const without = designArcadeGame('Disable prizes.', original).spec;
  assert.equal(without.version, 4); assert.equal(without.powerUps, undefined); assert.deepEqual(without.levels, original.levels);
  for (const message of ['Shooting off.', 'Make it a platformer.', 'Switch to a collection game.']) {
    const next = designArcadeGame(message, original).spec;
    assert.equal(next.version, 4); assert.equal(next.powerUps, undefined); assert.deepEqual(next.multiplayer, original.multiplayer);
  }
});

test('named prize requests work, while story metadata does not enable prizes', () => {
  const original = designArcadeGame('Asteroids.').spec;
  for (const message of ['Add power-ups.', 'Add triple-shot.', 'Enable rapid fire.', 'Add shields.', 'Add speed boost.']) assert.equal(designArcadeGame(message, original).spec.version, 5, message);
  for (const message of ['Title: The prize shield', 'Description: Collect a shield prize.', 'Instructions: Follow the shield.', 'Call it “The Shield Prize”']) {
    const next = designArcadeGame(message, original).spec;
    assert.equal(next.powerUps, undefined, message); assert.equal(next.version, 2, message);
  }
});

test('browser and backend agree on prize planning and malformed versioned schemas', () => {
  const original = prizes(true), cases = [
    { message: 'Asteroids with prizes and two-player cooperation.' },
    ...['Title: Twin rockets', 'Level 2 harder', '4 levels', 'shuffle layouts', 'Disable prizes.', 'Disable multiplayer.', 'Shooting off.', 'Make it a platformer.', 'Add triple-shot.', 'Instructions: shield prize'].map(message => ({ message, current: original })),
    { message: 'Title: Prize shield', current: designArcadeGame('Asteroids.').spec },
  ];
  const valid = [prizes(), original], invalid = [
    ...[4, 61, true].map(spawnInterval => ({ ...original, powerUps: { ...defaultPowerUps(), spawnInterval } })),
    ...[2, 31, false].map(duration => ({ ...original, powerUps: { ...defaultPowerUps(), duration } })),
    ...[[], ['shield', 'shield'], ['other'], [null]].map(types => ({ ...original, powerUps: { ...defaultPowerUps(), types } })),
    { ...original, version: 4 }, { ...original, powerUps: null }, { ...original, multiplayer: { mode: 'cooperative', maxPlayers: 3 } },
  ];
  const python = `import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('prize_parity',Path.cwd()/'backend/nce_api/games.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
data=json.load(sys.stdin)
def valid(value):
 try: m.validate_spec(value);return True
 except m.GameError:return False
print(json.dumps({'plans':[m.design_game(c['message'],c.get('current')) for c in data['cases']],'valid':[valid(v) for v in data['specs']]}))`;
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify({ cases, specs: [...valid, ...invalid] }), encoding: 'utf8' }));
  cases.forEach((entry, index) => assert.deepEqual(actual.plans[index], designArcadeGame(entry.message, entry.current), entry.message));
  assert.deepEqual(actual.valid, [...valid, ...invalid].map(value => { try { validateGameSpec(value); return true; } catch { return false; } }));
});
