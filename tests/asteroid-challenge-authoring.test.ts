import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AsteroidChallengeEditor } from '../src/components/AsteroidChallengeEditor.tsx';
import { AsteroidPrizeEditor, AsteroidPrizeGuide } from '../src/components/AsteroidPrizeEditor.tsx';
import { acceptEndlessPlaytestReview, arcadeAuthoringInstructions } from '../src/lib/asteroid-authoring.ts';
import { designArcadeGame, getGameLevels, updateAsteroidEnemies, updateAsteroidSettings, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { setCooperativeMode, setPowerUpsEnabled, updatePowerUps } from '../src/lib/game-multiplayer-design.ts';
import type { ArcadeGameSpec } from '../src/lib/game-types.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';

const asteroid = () => designArcadeGame('Asteroids shooting with four levels, points, and high scores.').spec;
type Element = { type: unknown; props: Record<string, any> };
function elements(value: any): Element[] { return Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : []; }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' ? value : ''; }
function inputFor(tree: any, label: string) { const match = elements(tree).find(node => node.type === 'label' && text(node).includes(label)); assert.ok(match, label); const control = elements(match).find(node => node.type === 'input' || node.type === 'select'); assert.ok(control, label); return control; }

test('viewing advanced choices never upgrades an existing game; an explicit control preserves the authored plan', () => {
  const spec = asteroid(); spec.levels![1].title = 'My special middle level'; spec.levels![1].seed = 1421; spec.instructions = 'My authored instructions.';
  const before = structuredClone(spec), changes: ArcadeGameSpec[] = [];
  const tree = AsteroidChallengeEditor({ spec, change: value => changes.push(value) });
  assert.deepEqual(spec, before); assert.deepEqual(changes, []);
  assert.equal(inputFor(tree, 'Endless survival').props.checked, false);
  inputFor(tree, 'Endless survival').props.onChange({ target: { checked: true } });
  assert.equal(changes.length, 1); assert.equal(changes[0].version, 6); assert.equal(changes[0].asteroids?.endless, true);
  assert.deepEqual(changes[0].levels, before.levels); assert.equal(changes[0].progression, before.progression); assert.equal(changes[0].instructions, before.instructions);
  assert.deepEqual(spec, before); validateArcadeGameSpec(changes[0]);
  const restored = updateAsteroidSettings(changes[0], { endless: false }); assert.deepEqual(restored.levels, before.levels);
});

test('advanced form exposes bounded enemy behavior, durability, population and active-play timing', () => {
  const spec = updateAsteroidEnemies(updateAsteroidSettings(asteroid(), { endless: true, sizes: 3 }), { enabled: true, difficulty: 'hard', hitPoints: 10, maxShips: 6, spawnInterval: 60 });
  const html = renderToStaticMarkup(createElement(AsteroidChallengeEditor, { spec, change() {} }));
  for (const label of ['Endless survival', 'Increase difficulty every', 'Asteroid sizes', 'large → medium → small', 'Add enemy ships', 'Enemy behavior', 'Shots to defeat an enemy', 'Enemy ships at once', 'Send an enemy every', 'pursue your ship, aim, and fire', 'rest of your level plan stays saved']) assert.ok(html.includes(label), label);
  assert.match(html, /type="range" min="10" max="120" step="1"/); assert.match(html, /type="range" min="5" max="60" step="1"/); assert.match(html, /value="10"/);
  assert.match(html, /medium rock 30/); assert.match(html, /easy 100, medium 200, hard 300/);
  const withoutSplitting = { ...spec, arcade: { ...spec.arcade!, splitAsteroids: false } };
  assert.equal(inputFor(AsteroidChallengeEditor({ spec: withoutSplitting, change() {} }), 'Asteroid sizes').props.disabled, true);
});

test('v6 prizes can be removed without losing endless/enemy/cooperative settings or authored levels', () => {
  const advanced = updateAsteroidEnemies(updateAsteroidSettings(asteroid(), { endless: true, sizes: 3 }), { enabled: true });
  const spec = setPowerUpsEnabled(setCooperativeMode(advanced, true), true), changes: ArcadeGameSpec[] = [];
  const editor = AsteroidPrizeEditor({ spec, change: value => changes.push(value) });
  inputFor(editor, 'Drop prizes during the game').props.onChange({ target: { checked: false } });
  assert.equal(changes.length, 1); assert.equal(changes[0].version, 6); assert.equal(changes[0].powerUps, undefined);
  assert.deepEqual(changes[0].asteroids, spec.asteroids); assert.deepEqual(changes[0].levels, spec.levels); assert.deepEqual(changes[0].multiplayer, spec.multiplayer);
  validateArcadeGameSpec(changes[0]);
  const endless = renderToStaticMarkup(createElement(AsteroidPrizeEditor, { spec, change() {} }));
  assert.doesNotMatch(endless, /Timed effects last/); assert.match(endless, /Any damaging hit clears all boosts/);
  const guide = renderToStaticMarkup(createElement(AsteroidPrizeGuide, { spec })); assert.match(guide, /Boosts stay active until your ship takes a hit/); assert.match(guide, /shield absorbs that hit/);
  const finite = updateAsteroidSettings(spec, { endless: false });
  assert.match(renderToStaticMarkup(createElement(AsteroidPrizeEditor, { spec: finite, change() {} })), /Timed effects last/);
});

test('refreshed instructions describe the enabled mechanics and remain within the saved text limit', () => {
  for (const endless of [false, true]) for (const sizes of [2, 3] as const) for (const difficulty of ['easy', 'medium', 'hard'] as const) for (const rotation of [false, true]) {
    let spec = updateAsteroidEnemies(updateAsteroidSettings(asteroid(), { endless, sizes, difficultyInterval: 120 }), { enabled: true, difficulty });
    spec = updatePowerUps(setPowerUpsEnabled(spec, true), { duration: 30 });
    spec.arcade!.rotation = rotation; spec.objects.collectible = 'x'.repeat(30);
    const instructions = arcadeAuthoringInstructions(spec);
    assert.ok(instructions.length <= 300, `${instructions.length}: ${instructions}`);
    assert.match(instructions, /Touch controls below/); assert.match(instructions, /Space shoots/);
    assert.match(instructions, sizes === 3 ? /large→medium→small/ : /large→small/);
    if (endless) { assert.match(instructions, /No timer\/goal/); assert.match(instructions, /120s/); assert.match(instructions, /Any hit clears all/); assert.doesNotMatch(instructions, /to finish each level/); }
    else { assert.match(instructions, /to finish each level/); assert.match(instructions, /30s/); assert.doesNotMatch(instructions, /No timer\/goal|Any hit clears all/); }
    if (difficulty === 'hard') assert.match(instructions, /chase, aim and fire/);
  }
});

test('private endless review accepts only the saved starting level after active play and never creates a terminal result', () => {
  const spec = updateAsteroidSettings(asteroid(), { endless: true });
  const first = getGameLevels(spec)[0].id, review = { elapsed: 5, reviewedLevelIds: [first] };
  assert.deepEqual(acceptEndlessPlaytestReview(spec, review), [first]);
  assert.deepEqual(Object.keys(review).sort(), ['elapsed', 'reviewedLevelIds']);
  assert.deepEqual(acceptEndlessPlaytestReview(spec, { ...review, elapsed: 2_147_483_647 }), [first]);
  for (const invalid of [{ ...review, elapsed: 4.99 }, { ...review, elapsed: NaN }, { ...review, elapsed: Infinity }, { ...review, elapsed: 2_147_483_648 }, { ...review, reviewedLevelIds: [] }, { ...review, reviewedLevelIds: ['level-2'] }, { ...review, reviewedLevelIds: [first, first] }, { ...review, reviewedLevelIds: getGameLevels(spec).map(level => level.id) }]) assert.deepEqual(acceptEndlessPlaytestReview(spec, invalid), []);
  assert.deepEqual(acceptEndlessPlaytestReview(updateAsteroidSettings(spec, { endless: false }), review), []);
  assert.deepEqual(acceptEndlessPlaytestReview(defaultWordGameSpec('crossword'), review), []);
});
