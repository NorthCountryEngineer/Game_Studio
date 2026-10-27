import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AsteroidPrizeEditor } from '../src/components/AsteroidPrizeEditor.tsx';
import { defaultGameSpec, designArcadeGame, getGameLevels, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { removeUnsupportedPowerUps, setCooperativeMode, setPowerUpsEnabled, setPowerUpType, updateArcadeLevelPlan, updatePowerUps } from '../src/lib/game-multiplayer-design.ts';
import { isCooperativeGameSpec, type GamePowerUpType } from '../src/lib/game-types.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';

const asteroid = () => designArcadeGame('Asteroids shooting with three levels, points, and high scores.').spec;

test('prizes are opt-in and conversion preserves authored levels, seeds, prose, and cooperative setting', () => {
  const original = asteroid(); original.levels![1].title = 'My middle chapter'; original.levels![1].seed = 927;
  const encoded = JSON.stringify(original), prizes = setPowerUpsEnabled(original, true);
  assert.equal(prizes.version, 5); assert.equal(isCooperativeGameSpec(prizes), false);
  assert.deepEqual(prizes.powerUps, { spawnInterval: 12, duration: 10, types: ['triple-shot', 'rapid-fire', 'shield', 'speed-boost'] });
  assert.deepEqual(prizes.levels, original.levels); assert.equal(prizes.instructions, original.instructions); assert.equal(JSON.stringify(original), encoded); validateArcadeGameSpec(prizes);
  const cooperative = setCooperativeMode(prizes, true); assert.equal(cooperative.version, 5); assert.equal(isCooperativeGameSpec(cooperative), true);
  assert.deepEqual(cooperative.powerUps, prizes.powerUps); assert.deepEqual(cooperative.levels, original.levels); validateArcadeGameSpec(cooperative);
  const reordered = updateArcadeLevelPlan(cooperative, [...getGameLevels(cooperative)].reverse(), 'My original progression.');
  assert.equal(reordered.version, 5); assert.deepEqual(reordered.powerUps, prizes.powerUps); assert.deepEqual(reordered.multiplayer, cooperative.multiplayer); assert.equal(reordered.levels![1].seed, 927);
  const noCoop = setCooperativeMode(reordered, false); assert.equal(noCoop.version, 5); assert.equal(Object.hasOwn(noCoop, 'multiplayer'), false); assert.deepEqual(noCoop.powerUps, prizes.powerUps); validateArcadeGameSpec(noCoop);
  const noPrizes = setPowerUpsEnabled(cooperative, false); assert.equal(noPrizes.version, 4); assert.equal(Object.hasOwn(noPrizes, 'powerUps'), false); assert.deepEqual(noPrizes.multiplayer, cooperative.multiplayer); assert.deepEqual(noPrizes.levels, original.levels); validateArcadeGameSpec(noPrizes);
  const plain = setPowerUpsEnabled(prizes, false); assert.equal(plain.version, 2); assert.deepEqual(plain.levels, original.levels); validateArcadeGameSpec(plain);
  assert.deepEqual(setPowerUpsEnabled(original, false), original); assert.deepEqual(removeUnsupportedPowerUps(original), original);
});

test('prize editing enforces choices and bounds without mutating the saved edition', () => {
  const original = setPowerUpsEnabled(asteroid(), true), encoded = JSON.stringify(original);
  const configured = updatePowerUps(original, { spawnInterval: 5, duration: 30, types: ['shield'] });
  assert.equal(configured.powerUps?.spawnInterval, 5); assert.deepEqual(configured.powerUps?.types, ['shield']); assert.equal(JSON.stringify(original), encoded);
  assert.throws(() => setPowerUpType(configured, 'shield', false), /at least one/);
  assert.deepEqual(setPowerUpType(configured, 'rapid-fire', true).powerUps?.types, ['shield', 'rapid-fire']);
  assert.throws(() => setPowerUpType(configured, 'unknown' as GamePowerUpType, false), /supported/);
  for (const patch of [{ spawnInterval: 4 }, { spawnInterval: 61 }, { duration: 2 }, { duration: 31 }, { types: [] }, { types: ['shield', 'shield'] as GamePowerUpType[] }]) assert.throws(() => updatePowerUps(original, patch));
  assert.throws(() => updatePowerUps(asteroid(), { duration: 4 }), /Enable/);
  assert.throws(() => setPowerUpsEnabled(defaultGameSpec(), true), /shooting/);
  assert.throws(() => setPowerUpsEnabled(defaultWordGameSpec('crossword'), true), /Asteroids/);
  const shootingOff = removeUnsupportedPowerUps({ ...original, arcade: { ...original.arcade!, shooting: false, splitAsteroids: false } });
  assert.equal(shootingOff.version, 2); assert.equal(Object.hasOwn(shootingOff, 'powerUps'), false); assert.deepEqual(shootingOff.levels, original.levels); validateArcadeGameSpec(shootingOff);
  const genreChanged = { ...setCooperativeMode(original, true), genre: 'collect' as const }; delete genreChanged.arcade;
  const cleared = removeUnsupportedPowerUps(genreChanged); assert.equal(cleared.version, 4); assert.equal(isCooperativeGameSpec(cleared), true); assert.deepEqual(cleared.levels, original.levels); validateArcadeGameSpec(cleared);
});

test('prize form presents four effects, valid timing choices, and keeps one prize selected', () => {
  const original = asteroid();
  const disabled = renderToStaticMarkup(createElement(AsteroidPrizeEditor, { spec: original, change() {} }));
  assert.match(disabled, /Drop prizes during the game/); assert.doesNotMatch(disabled, /Prizes that may appear/);
  const spec = updatePowerUps(setPowerUpsEnabled(original, true), { types: ['shield'] });
  const markup = renderToStaticMarkup(createElement(AsteroidPrizeEditor, { spec, change() {} }));
  for (const label of ['Triple shot', 'Rapid fire', 'Shield', 'Speed boost', 'Drop a prize every', 'Timed effects last', 'only the ship that collects it', 'Save, playtest and publish']) assert.ok(markup.includes(label));
  assert.match(markup, /disabled="" checked=""/); assert.match(markup, /value="5"/); assert.match(markup, /value="60"/); assert.match(markup, /value="3"/); assert.match(markup, /value="30"/);
  assert.equal(renderToStaticMarkup(createElement(AsteroidPrizeEditor, { spec: defaultGameSpec(), change() {} })), '');
});
