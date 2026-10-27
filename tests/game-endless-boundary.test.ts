import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designGame, updateAsteroidSettings } from '../src/lib/game-design.ts';
import { gamePlayerLoadMessage, validateGameReview } from '../src/lib/game-review.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';
import { LocalGameLibrary } from '../src/lib/game-local.ts';
import { calculateProvisionalPoints, gameObjectiveUnits, parseGameStudioEvent } from '../src/lib/integration.ts';
import type { ArcadeGameSpec } from '../src/lib/game-types.ts';

const endless = () => updateAsteroidSettings(designGame('An asteroids game with shooting').spec as ArcadeGameSpec, { endless: true });
const gameId = '11111111-1111-4111-8111-111111111111';
test('private arcade review flags never change the existing strict word-player load protocol', () => {
  for (const genre of ['crossword', 'word-search', 'mad-libs'] as const) for (const playtest of [false, true]) {
    const load = gamePlayerLoadMessage(defaultWordGameSpec(genre), 'test-nonce', undefined, playtest);
    assert.deepEqual(Object.keys(load).sort(), ['levelId', 'nonce', 'spec', 'type']);
  }
  assert.equal(gamePlayerLoadMessage(endless(), 'test-nonce', undefined, true).playtest, true);
});
test('endless preview reviews require actual play time and an exact allowed level without result authority', () => {
  const spec = endless(), review = { elapsed: 5, reviewedLevelIds: ['level-1'] };
  assert.deepEqual(validateGameReview(review, spec), review);
  for (const invalid of [null, [], { ...review, elapsed: 4.99 }, { ...review, elapsed: Infinity }, { ...review, elapsed: 2_147_483_648 }, { ...review, score: 200 }, { ...review, outcome: 'won' }, { ...review, reviewedLevelIds: [] }, { ...review, reviewedLevelIds: ['level-2'] }, { ...review, reviewedLevelIds: ['level-1', 'level-1'] }]) assert.equal(validateGameReview(invalid, spec), undefined);
  assert.equal(validateGameReview(review, updateAsteroidSettings(spec, { endless: false })), undefined);
  assert.equal(validateGameReview(review, spec, 'level-8'), undefined);
});

test('local publication reviews the endless baseline while preserving all saved level data', () => {
  const values = new Map<string, string>();
  const library = new LocalGameLibrary({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  const draft = library.create(gameId, 'An asteroids shooting game with three levels');
  const spec = updateAsteroidSettings(draft.spec as ArcadeGameSpec, { endless: true });
  const levels = structuredClone(spec.levels);
  const saved = library.save(gameId, draft.revision, spec);
  assert.throws(() => library.test(gameId, saved.revision, []), /review/);
  const reviewed = library.test(gameId, saved.revision, ['level-1']);
  const published = library.publish(gameId, reviewed.revision);
  assert.deepEqual(published.spec.version === 3 ? [] : published.spec.levels, levels);
  assert.equal(published.spec.version, 6);
  assert.equal(library.get(gameId, true).publishedRevision, published.publishedRevision);
});

test('endless observations require an explicitly chosen arcade target for provisional points', () => {
  const spec = endless();
  const observed = { outcome: 'lost', elapsed: 100, score: 12, points: 250, reviewedLevelIds: ['level-1'] };
  const policy = { version: 1, max_points: 100, method: 'proportional', rounding: 'whole', attempt_policy: 'best', max_attempts: 3 };
  assert.throws(() => gameObjectiveUnits(spec), /no finite/);
  for (const method of ['proportional', 'completion']) assert.throws(() => calculateProvisionalPoints(spec, observed, { ...policy, method }), /explicit arcade target/);
  assert.equal(calculateProvisionalPoints(spec, observed, { ...policy, method: 'arcade_target', arcade_target: 500 }).earned_points, 50);
  assert.throws(() => calculateProvisionalPoints(spec, { ...observed, outcome: 'won' }, { ...policy, method: 'arcade_target', arcade_target: 500 }));
});

test('extended Asteroids completion events are explicit and leave the original host contract bounded', () => {
  const event = { source: 'nce-game-studio', version: 2, specVersion: 6, mode: 'endless', channel: 'test-channel', type: 'completed', gameId, publishedRevision: 2, result: { outcome: 'lost', elapsed: 100000, score: 1000, points: 1500000, reviewedLevelIds: ['level-1'] } };
  assert.ok(parseGameStudioEvent(event));
  for (const patch of [{ version: 1 }, { specVersion: 5 }, { mode: 'anything' }, { type: 'ready' }, { token: 'private' }]) assert.equal(parseGameStudioEvent({ ...event, ...patch }), undefined);
  for (const result of [{ ...event.result, outcome: 'won' }, { ...event.result, elapsed: Infinity }, { ...event.result, score: 2_147_483_648 }, { ...event.result, points: 2_147_483_648 }, { ...event.result, reviewedLevelIds: ['level-1', 'level-2'] }]) assert.equal(parseGameStudioEvent({ ...event, result }), undefined);
  assert.ok(parseGameStudioEvent({ ...event, result: { ...event.result, reviewedLevelIds: ['level-3'] } }));
  const { specVersion: _spec, mode: _mode, ...legacy } = event;
  assert.equal(parseGameStudioEvent({ ...legacy, version: 1 }), undefined);
});
