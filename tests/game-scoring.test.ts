import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { calculateProvisionalPoints, createPublicationBinding, gameObjectiveUnits, scorePublishedGame, selectScoringAttempt, validateScoringPolicy } from '../src/lib/integration.ts';
import { defaultGameSpec, planGameLevels } from '../src/lib/game-design.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';
import type { Game, GameResult, GameSpec } from '../src/lib/game-types.ts';

const policy = { version: 1, max_points: 25, method: 'proportional', rounding: 'hundredth', attempt_policy: 'best', max_attempts: 3 };
const result = (score: number, outcome: GameResult['outcome'] = 'lost', reviewedLevelIds = ['level-1']): GameResult => ({ outcome, elapsed: 12, score, reviewedLevelIds });
const publication = (spec: GameSpec): Game => ({ id: '11111111-1111-4111-8111-111111111111', spec, revision: 2, status: 'Published', publishedRevision: 2, createdAt: '2026-10-27T12:00:00+00:00', updatedAt: '2026-10-27T12:00:00+00:00', publishedAt: '2026-10-27T12:00:00+00:00' });

test('assignment policies are strict, bounded and default solution reveals to zero', () => {
  assert.deepEqual(validateScoringPolicy(policy), { ...policy, reveal_policy: 'zero' });
  assert.equal(validateScoringPolicy({ ...policy, reveal_policy: 'earned' }).reveal_policy, 'earned');
  for (const invalid of [null, [], { ...policy, version: 2 }, { ...policy, max_points: 0 }, { ...policy, max_points: 10001 }, { ...policy, max_points: true }, { ...policy, max_points: 1.5 }, { ...policy, max_attempts: 101 }, { ...policy, max_attempts: 0 }, { ...policy, rounding: 'bankers' }, { ...policy, method: { toString: () => 'completion' } }, { ...policy, reveal_policy: undefined }, { ...policy, arbitrary_code: 'anything' }, { ...policy, arcade_target: 500 }, { ...policy, method: 'arcade_target' }, { ...policy, method: 'arcade_target', arcade_target: Infinity }]) assert.throws(() => validateScoringPolicy(invalid));
  assert.equal(validateScoringPolicy({ ...policy, method: 'arcade_target', arcade_target: 500 }).arcade_target, 500);
});

test('partial arcade attempts use all saved levels as the denominator and apply reproducible 25/100 scales', () => {
  const spec = planGameLevels(defaultGameSpec(), 2, 'assignment');
  spec.levels![0].rules.goal = 10; spec.levels![1].rules.goal = 20;
  assert.equal(gameObjectiveUnits(spec), 30);
  const partial = result(5);
  assert.deepEqual(calculateProvisionalPoints(spec, partial, policy), { earned_points: 4.17, max_points: 25, numerator: 5, denominator: 30, method: 'proportional', provisional: true });
  assert.equal(calculateProvisionalPoints(spec, partial, { ...policy, max_points: 100 }).earned_points, 16.67);
  assert.equal(calculateProvisionalPoints(spec, result(30, 'won', ['level-1', 'level-2']), policy).earned_points, 25);
  assert.deepEqual(spec.levels!.map(level => level.rules.goal), [10, 20]);
});

test('whole and hundredth scales use half-up rounding with no hidden timing multiplier', () => {
  const spec = defaultGameSpec();
  assert.equal(calculateProvisionalPoints(spec, result(1), { ...policy, rounding: 'whole' }).earned_points, 3);
  assert.equal(calculateProvisionalPoints(spec, result(1), policy).earned_points, 2.5);
  spec.rules.goal = 3;
  assert.equal(calculateProvisionalPoints(spec, result(1), { ...policy, max_points: 100 }).earned_points, 33.33);
  assert.equal(calculateProvisionalPoints(spec, { ...result(1), elapsed: 59 }, { ...policy, max_points: 100 }).earned_points, 33.33);
});

test('completion scoring requires the full win and arcade target uses an explicit cap', () => {
  const spec = defaultGameSpec();
  assert.equal(calculateProvisionalPoints(spec, result(9), { ...policy, method: 'completion' }).earned_points, 0);
  assert.equal(calculateProvisionalPoints(spec, result(10, 'won'), { ...policy, method: 'completion' }).earned_points, 25);
  const arcade = { ...spec, genre: 'dodge' as const, arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true } };
  const target = { ...policy, method: 'arcade_target', arcade_target: 500 };
  assert.equal(calculateProvisionalPoints(arcade, { ...result(5), points: 250 }, target).earned_points, 12.5);
  assert.equal(calculateProvisionalPoints(arcade, { ...result(5), points: 600 }, target).earned_points, 25);
  assert.throws(() => calculateProvisionalPoints(spec, result(5), target));
  assert.throws(() => calculateProvisionalPoints(defaultWordGameSpec('word-search'), result(3, 'won'), target));
});

test('crossword reveals forfeit points by default and retain only pre-reveal counts when explicitly allowed', () => {
  const spec = defaultWordGameSpec('crossword');
  const total = gameObjectiveUnits(spec);
  assert.equal(calculateProvisionalPoints(spec, result(2), policy).earned_points, 0);
  const earned = calculateProvisionalPoints(spec, result(2), { ...policy, reveal_policy: 'earned' });
  assert.equal(earned.numerator, 2); assert.equal(earned.denominator, total); assert.ok(earned.earned_points > 0 && earned.earned_points < 25);
  assert.equal(calculateProvisionalPoints(spec, result(total), policy).earned_points, 0);
  assert.equal(calculateProvisionalPoints(spec, result(total, 'won'), policy).earned_points, 25);
});

test('word search and Mad Libs report bounded participation without sending or grading entered text', () => {
  for (const genre of ['word-search', 'mad-libs'] as const) {
    const spec = defaultWordGameSpec(genre), total = gameObjectiveUnits(spec), observed = result(total, 'won');
    assert.equal(calculateProvisionalPoints(spec, observed, policy).earned_points, 25);
    assert.equal(calculateProvisionalPoints(spec, observed, { ...policy, max_points: 100, method: 'completion' }).earned_points, 100);
    assert.throws(() => calculateProvisionalPoints(spec, { ...observed, answers: ['private word'] }, policy));
    assert.throws(() => calculateProvisionalPoints(spec, result(total + 1, 'won'), policy));
    assert.throws(() => calculateProvisionalPoints(spec, result(total - 1, 'won'), policy));
    assert.throws(() => calculateProvisionalPoints(spec, result(total - 1), policy));
  }
});

test('scaling rejects malformed, inflated, intermediate and authority-bearing observations', () => {
  const spec = defaultGameSpec();
  for (const invalid of [{ ...result(4), outcome: 'level-complete' }, result(11), { ...result(4), elapsed: Infinity }, { ...result(4), elapsed: 61 }, { ...result(4), reviewedLevelIds: ['level-2'] }, { ...result(4), points: 40 }, { ...result(4), maxScore: 4 }, { ...result(4), grade: 100 }, { ...result(4), score: '4' }, { ...result(4), reviewedLevelIds: ['level-1', 'level-1'] }, { ...result(4), elapsed: -1 }]) assert.throws(() => calculateProvisionalPoints(spec, invalid, policy));
  assert.throws(() => calculateProvisionalPoints({ ...spec, customScoring: { max: 25 } }, result(4), policy));
});

test('attempt policies order server ordinals, preserve earliest best ties and reject duplicate or invalid histories', () => {
  const attempts = [{ ordinal: 3, earned_points: 21 }, { ordinal: 1, earned_points: 19 }, { ordinal: 2, earned_points: 21 }];
  assert.deepEqual(selectScoringAttempt(attempts, policy), { ordinal: 2, earned_points: 21 });
  assert.deepEqual(selectScoringAttempt(attempts, { ...policy, attempt_policy: 'first' }), attempts[1]);
  assert.deepEqual(selectScoringAttempt(attempts, { ...policy, attempt_policy: 'latest' }), attempts[0]);
  assert.equal(selectScoringAttempt([], policy), undefined);
  assert.equal(attempts[0].ordinal, 3);
  assert.deepEqual(selectScoringAttempt([{ ordinal: 1, earned_points: 8.03 }], policy), { ordinal: 1, earned_points: 8.03 });
  for (const invalid of [[attempts[0], attempts[0]], [{ ordinal: 4, earned_points: 20 }], [{ ordinal: 1, earned_points: 25.01 }], [{ ordinal: 1, earned_points: 0.300000000001 }], [{ ordinal: 1, earned_points: NaN }], [{ ordinal: 1, earned_points: 8.001 }], [{ ordinal: 1, earned_points: 8, timestamp: 1 }], Array.from({ length: 4 }, (_, i) => ({ ordinal: i + 1, earned_points: 1 }))]) assert.throws(() => selectScoringAttempt(invalid, policy));
  assert.throws(() => selectScoringAttempt([{ ordinal: 1, earned_points: 8.03 }], { ...policy, rounding: 'whole' }));
});

test('publication hashes match Python canonical JSON for all supported formats and literal Unicode', async () => {
  const specs = [defaultGameSpec(), planGameLevels(defaultGameSpec(), 2, 'hash'), defaultWordGameSpec('crossword'), defaultWordGameSpec('word-search'), defaultWordGameSpec('mad-libs')];
  specs.forEach(spec => { spec.title = 'Café 🌎 lesson'; });
  const bindings = await Promise.all(specs.map(spec => createPublicationBinding(publication(spec))));
  const python = spawnSync('python3', ['-c', 'import hashlib,json,sys; print(json.dumps([hashlib.sha256(json.dumps(s,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest() for s in json.load(sys.stdin)]))'], { input: JSON.stringify(specs), encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(bindings.map(binding => binding.spec_sha256), JSON.parse(python.stdout));
  assert.ok(bindings.every(binding => binding.published_revision === 2));
  assert.equal(new Set(bindings.map(binding => binding.spec_sha256)).size, 5);
});

test('bound scoring rejects changed editions, identities, definitions, drafts and private data', async () => {
  const game = publication(defaultGameSpec()), binding = await createPublicationBinding(game);
  assert.equal((await scorePublishedGame(game, binding, result(4), policy)).earned_points, 10);
  await assert.rejects(scorePublishedGame(game, { ...binding, published_revision: 1 }, result(4), policy));
  await assert.rejects(scorePublishedGame(game, { ...binding, game_id: '22222222-2222-4222-8222-222222222222' }, result(4), policy));
  await assert.rejects(scorePublishedGame(game, { ...binding, spec_sha256: '0'.repeat(64) }, result(4), policy));
  await assert.rejects(scorePublishedGame({ ...game, spec: { ...game.spec, title: 'Changed edition' } }, binding, result(4), policy));
  await assert.rejects(createPublicationBinding({ ...game, status: 'Draft' }));
  await assert.rejects(createPublicationBinding({ ...game, revision: 3 }));
  await assert.rejects(createPublicationBinding({ ...game, messages: [{ text: 'Private design conversation' }] }));
  await assert.rejects(createPublicationBinding({ ...game, spec: { ...game.spec, title: '\ud800' } }));
});

test('bound scoring freezes validated inputs before asynchronous hashing yields', async () => {
  const game = publication(defaultGameSpec()), binding = await createPublicationBinding(game), observed = result(4), rules = { ...policy };
  const scoring = scorePublishedGame(game, binding, observed, rules);
  game.spec.title = 'Changed during hashing'; observed.score = 9; rules.max_points = 100; binding.published_revision = 50;
  assert.equal((await scoring).earned_points, 10);
});


test('cooperative editions cannot be combined into single-player assignment credit', () => {
  const solo = planGameLevels(defaultGameSpec(), 2, 'cooperative-scale');
  const cooperative = { ...solo, version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } };
  assert.throws(() => gameObjectiveUnits(cooperative), /per-player/);
  assert.throws(() => calculateProvisionalPoints(cooperative, result(1), policy), /do not award/);
});


test('prize-enabled solo editions retain whole-campaign scaling while cooperative prize editions reject credit', async () => {
  const levels = planGameLevels({ ...defaultGameSpec(), genre: 'dodge', arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true } }, 2, 'prize-scale');
  levels.levels![0].rules.goal = 10; levels.levels![1].rules.goal = 20;
  const spec = { ...levels, version: 5 as const, powerUps: { spawnInterval: 12, duration: 10, types: ['triple-shot', 'rapid-fire', 'shield', 'speed-boost'] } };
  assert.equal(gameObjectiveUnits(spec), 30);
  assert.equal(calculateProvisionalPoints(spec, { ...result(5), points: 50 }, policy).earned_points, 4.17);
  assert.equal(calculateProvisionalPoints(spec, { ...result(5), points: 50 }, { ...policy, max_points: 100 }).earned_points, 16.67);
  const game = publication(spec as GameSpec), binding = await createPublicationBinding(game);
  assert.equal((await scorePublishedGame(game, binding, { ...result(30, 'won', ['level-1', 'level-2']), points: 300 }, policy)).earned_points, 25);
  const coop = { ...spec, multiplayer: { mode: 'cooperative', maxPlayers: 2 } };
  assert.throws(() => gameObjectiveUnits(coop), /per-player/);
  assert.throws(() => calculateProvisionalPoints(coop, { ...result(5), points: 50 }, policy), /do not award/);
});
