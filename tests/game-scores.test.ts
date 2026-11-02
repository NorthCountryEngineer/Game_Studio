import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { defaultGameSpec, updateAsteroidSettings, validateGameSpec } from '../src/lib/game-design.ts';
import * as leaderboard from '../src/lib/game-leaderboard.ts';
import { setCooperativeMode } from '../src/lib/game-multiplayer-design.ts';
import { createPlatformerSpec } from '../src/lib/game-flow.ts';
import { defaultMultiGameSpec } from '../src/lib/multi-game.ts';
import { aggregateMultiGameResults } from '../src/lib/multi-game-session.ts';
import { createGameEngine } from '../src/lib/game-runtime.ts';
import type { ArcadeGameSpec, Game, GameResult, GameSpec } from '../src/lib/game-types.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';

const id = '11111111-1111-4111-8111-111111111111';
const request = (n = 1) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const v1 = 'game-studio-game-scores:v1', v2 = 'game-studio-game-scores:v2';
function game(revision = 2, spec: GameSpec = validateGameSpec({ ...defaultGameSpec(), genre: 'dodge', theme: 'space', arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: false } })): Game {
  return { id, revision, publishedRevision: revision, status: 'Published', createdAt: '2026-10-23T12:00:00Z', updatedAt: '2026-10-23T12:00:00Z', spec };
}
const result = (points = 100): GameResult => ({ outcome: 'lost', elapsed: 2, score: 0, reviewedLevelIds: ['level-1'], points });
const report = (n = 1, name = 'Pilot', points = 100) => ({ requestId: request(n), name, result: result(points) });
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const wordResult = (spec: GameSpec, elapsed = 20): GameResult => {
  assert.equal(spec.version, 3);
  const word = spec as ReturnType<typeof defaultWordGameSpec>;
  const score = word.genre === 'crossword' ? word.puzzle.entries.length : word.genre === 'word-search' ? word.puzzle.words.length : word.puzzle.blanks.length;
  return { outcome: 'won', elapsed, score, reviewedLevelIds: ['level-1'] };
};
function harness(connected = false) {
  const values = new Map<string, string>(), calls: any[][] = [];
  let response: unknown = { entries: [], scope: 'shared', publishedRevision: 2, limit: 10, ranking: 'points' };
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const core = { isCore: connected, coreRequest: async (...args: any[]) => { calls.push(args); if (response instanceof Error) throw response; return response; } };
  const source = readFileSync(new URL('../src/lib/game-scores.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api: any = {};
  const modules: Record<string, unknown> = { './core': core, './game-design': { validateGameSpec }, './game-leaderboard': leaderboard };
  vm.runInNewContext(js, { exports: api, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, localStorage: storage, TextEncoder, Date, JSON, Error });
  return { api, storage, values, calls, respond: (value: unknown) => { response = value; } };
}

test('new names preserve Unicode, punctuation, case and NFC while counting eight code points', () => {
  const { api } = harness();
  assert.equal(api.validateArcadeName('  Étoile! '), 'Étoile!');
  assert.equal(api.validateArcadeName('e\u0301🙂<>&'), 'é🙂<>&');
  assert.equal(api.validateArcadeName('🙂'.repeat(8)), '🙂'.repeat(8));
  assert.equal(api.validateArcadeName('<script>'), '<script>');
  for (const bad of ['', '   ', 'x'.repeat(9), '🙂'.repeat(9), 'A\nB', 'A\tB', '\ud800', 'A\u202eB', null, 42]) assert.throws(() => api.validateArcadeName(bad), /name/);
});

test('every published game exposes its own board regardless of legacy highScores or multiplayer options', () => {
  const h = harness();
  const specs: GameSpec[] = [defaultGameSpec(), defaultWordGameSpec('crossword'), defaultWordGameSpec('word-search'), defaultWordGameSpec('mad-libs'), createPlatformerSpec(), defaultMultiGameSpec(), game().spec,
    setCooperativeMode(game().spec, true)];
  for (const spec of specs) {
    const board = h.api.getLocalGameScores(game(2, spec));
    assert.equal(board.ranking, leaderboard.leaderboardRanking(spec)); assert.equal(board.entries.length, 0);
  }
  assert.equal(h.values.size, 0); assert.equal(h.calls.length, 0);
});

test('anonymous preview entries are per run, keep case and allow duplicate nicknames', () => {
  const h = harness(), current = game(); h.values.set('unrelated-posts', 'preserve me');
  assert.deepEqual(plain(h.api.getLocalGameScores(current)), { entries: [], scope: 'browser', publishedRevision: 2, limit: 10, ranking: 'points' });
  const first = h.api.saveLocalGameScore(current, report());
  assert.equal(first.qualified, true); assert.equal(first.entries[0].name, 'Pilot'); assert.equal(first.entries[0].elapsed, 2);
  h.api.saveLocalGameScore(current, report(2, 'Pilot', 50)); h.api.saveLocalGameScore(current, report(3, 'pilot', 200));
  const board = h.api.getLocalGameScores(current);
  assert.deepEqual(plain(board.entries.map((entry: any) => [entry.name, entry.points])), [['pilot', 200], ['Pilot', 100], ['Pilot', 50]]);
  first.entries[0].points = 9999; assert.equal(board.entries[0].points, 200);
  assert.equal(h.values.get('unrelated-posts'), 'preserve me'); assert.equal(h.calls.length, 0);
});

test('full top tens require strict improvement and retries retain their original qualification outcome', () => {
  const h = harness(), current = game();
  for (let i = 1; i <= 10; i++) assert.equal(h.api.saveLocalGameScore(current, report(i, 'Pilot', i * 10)).qualified, true);
  const tie = report(11, 'Tie', 10); assert.equal(h.api.saveLocalGameScore(current, tie).qualified, false);
  for (let i = 12; i <= 22; i++) h.api.saveLocalGameScore(current, report(i, 'Pilot', i * 10));
  assert.equal(h.api.saveLocalGameScore(current, report(1, 'Pilot', 10)).qualified, true, 'a qualifying original request stays qualified even after later displacement');
  assert.equal(h.api.saveLocalGameScore(current, tie).qualified, false);
  const board = h.api.getLocalGameScores(current);
  assert.equal(board.entries.length, 10); assert.equal(board.entries[0].points, 220);
  assert.equal(board.entries.some((entry: any) => entry.name === 'Tie'), false);
});

test('word games rank completed active time ascending and reject unfinished observations', () => {
  for (const genre of ['crossword', 'word-search', 'mad-libs'] as const) {
    const h = harness(), current = game(2, defaultWordGameSpec(genre));
    for (let n = 1; n <= 11; n++) h.api.saveLocalGameScore(current, { requestId: request(n), name: '🙂', result: wordResult(current.spec, 10 + n) });
    const board = h.api.getLocalGameScores(current);
    assert.equal(board.ranking, 'time'); assert.equal(board.entries.length, 10); assert.equal(board.entries[0].elapsed, 11); assert.equal(board.entries.at(-1).elapsed, 20);
    assert.equal(h.api.saveLocalGameScore(current, { requestId: request(12), name: 'Tie', result: wordResult(current.spec, 20) }).qualified, false);
    for (const invalid of [{ ...wordResult(current.spec), outcome: 'lost' }, { ...wordResult(current.spec), score: 0 }, { ...wordResult(current.spec), elapsed: 0 }]) assert.throws(() => h.api.saveLocalGameScore(current, { requestId: request(13), name: 'No', result: invalid }), /round/);
  }
});

test('unscored endless games rank terminal survival times descending', () => {
  const h = harness(), spec = updateAsteroidSettings(game().spec as ArcadeGameSpec, { endless: true });
  spec.arcade!.scoring = false; spec.arcade!.highScores = false;
  const current = game(2, validateGameSpec(spec));
  const run = (n: number, elapsed: number) => ({ requestId: request(n), name: 'Survivor', result: { outcome: 'lost', elapsed, score: 0, reviewedLevelIds: ['level-1'] } });
  h.api.saveLocalGameScore(current, run(1, 5)); h.api.saveLocalGameScore(current, run(2, 50));
  const board = h.api.getLocalGameScores(current);
  assert.equal(board.ranking, 'survival'); assert.deepEqual(plain(board.entries.map((entry: any) => entry.elapsed)), [50, 5]);
  assert.throws(() => h.api.saveLocalGameScore(current, { ...run(3, 60), result: { ...run(3, 60).result, outcome: 'won' } }), /round/);
});

test('finite multi-game results use aggregate points, never individual child or free-play reports', () => {
  const h = harness(), spec = defaultMultiGameSpec(), current = game(2, spec);
  const games = spec.steps.filter(step => step.type === 'game').map(step => ({ stepId: step.id, result: wordResult(step.spec) }));
  const combined = aggregateMultiGameResults(spec, games, [], 'won', 40); assert.ok(combined);
  const board = h.api.saveLocalGameScore(current, { requestId: request(), name: 'Multi', result: combined });
  assert.equal(board.ranking, 'points'); assert.equal(board.entries[0].points, combined.points); assert.equal(board.entries[0].elapsed, 40);
  for (const invalid of [games[0].result, { ...combined, freePlayPoints: 1000 }, { ...combined, points: combined.points + 1000 }, { ...combined, games: games.slice(0, 1) }]) assert.throws(() => h.api.saveLocalGameScore(current, { requestId: request(2), name: 'No', result: invalid }), /round/);
});

test('zero-point terminal results qualify but invalid or incomplete campaigns cannot be saved', () => {
  const h = harness(), current = game();
  assert.equal(h.api.saveLocalGameScore(current, report(1, 'Zero', 0)).entries[0].points, 0);
  const invalid = [{ ...report(2), requestId: 'not-a-uuid' }, { ...report(2), unexpected: 'payload' }, { ...report(2), result: { ...result(), secret: 'private' } },
    { ...report(2), result: { ...result(), outcome: 'level-complete' } }, { ...report(2), result: result(-1) }, { ...report(2), result: result(1.5) },
    { ...report(2), result: result(createGameEngine().maxPoints(current.spec) + 1) }, { ...report(2), result: { ...result(), elapsed: Infinity } },
    { ...report(2), result: { ...result(), elapsed: 0 } }, { ...report(2), result: { ...result(), reviewedLevelIds: ['wrong-level'] } }, { ...report(2), result: { ...result(), outcome: 'won', score: 0 } }];
  for (const value of invalid) assert.throws(() => h.api.saveLocalGameScore(current, value), /report|round|result/);
  const level = createGameEngine().getLevels(current.spec)[0];
  current.spec = validateGameSpec({ ...current.spec, version: 2, progression: 'Clear the next challenge.', levels: [level, { ...level, id: 'level-2', title: 'Second level', seed: 17032 }] });
  assert.throws(() => h.api.saveLocalGameScore(current, { ...report(3), result: { ...result(), reviewedLevelIds: ['level-1', 'level-2'] } }), /round/);
  assert.equal(h.api.saveLocalGameScore(current, { ...report(3), result: { ...result(), score: level.rules.goal, reviewedLevelIds: ['level-1', 'level-2'] } }).qualified, true);
});

test('published editions are isolated and private or stale metadata cannot read or write boards', () => {
  const h = harness(), current = game(); h.api.saveLocalGameScore(current, report());
  assert.equal(h.api.getLocalGameScores(game(3)).entries.length, 0);
  assert.equal(h.api.getLocalGameScores({ ...current, id: request(99) }).entries.length, 0);
  for (const changed of [{ ...current, status: 'Draft' }, { ...current, revision: 3 }, { ...current, publishedRevision: undefined }, { ...current, revision: 0, publishedRevision: 0 }, { ...current, revision: 1000000001, publishedRevision: 1000000001 }]) {
    assert.throws(() => h.api.getLocalGameScores(changed), /published/); assert.throws(() => h.api.saveLocalGameScore(changed, report(2)), /published/);
  }
});

test('request receipts reject changed results, names and cross-board identifier reuse', () => {
  const h = harness(), current = game(), original = h.api.saveLocalGameScore(current, report());
  assert.deepEqual(plain(h.api.saveLocalGameScore(current, report())), plain(original));
  for (const changed of [report(1, 'pilot'), report(1, 'Other'), report(1, 'Pilot', 200), { ...report(), result: { ...result(), elapsed: 3 } }]) assert.throws(() => h.api.saveLocalGameScore(current, changed), /already used/);
  assert.throws(() => h.api.saveLocalGameScore(game(3), report()), /already used/);
});

test('legacy v1 names and missing elapsed remain readable and only the relevant entries copy to v2', () => {
  const h = harness(), current = game();
  const legacy = JSON.stringify({ version: 1, boards: [
    { gameId: id, publishedRevision: 2, entries: [{ name: 'ABCDEFGHIJKLMNOP', points: 100, createdAt: '2026-10-23T12:00:00Z' }], receipts: [{ id: request(99), report: 'legacy report preserved in v1' }] },
    { gameId: request(100), publishedRevision: 7, entries: [{ name: 'OTHER', points: 200, createdAt: '2026-10-23T12:00:00Z' }], receipts: [] },
  ] });
  h.values.set(v1, legacy); h.values.set('unrelated', 'keep');
  assert.equal(h.api.getLocalGameScores(current).entries[0].name, 'ABCDEFGHIJKLMNOP'); assert.equal(h.values.has(v2), false);
  h.api.saveLocalGameScore(current, report(1, 'New', 200));
  const state = JSON.parse(h.values.get(v2)!);
  assert.equal(state.version, 2); assert.equal(state.boards.length, 1); assert.equal(state.boards[0].entries[1].name, 'ABCDEFGHIJKLMNOP');
  assert.equal(h.values.get(v1), legacy); assert.equal(h.values.get('unrelated'), 'keep');
  assert.throws(() => h.api.saveLocalGameScore(current, report(2, 'ABCDEFGHIJKLMNOP')), /name/);
});

test('corrupt browser state, exhausted history and failed writes preserve existing bytes', () => {
  const h = harness(), current = game(); h.api.saveLocalGameScore(current, report()); const raw = h.values.get(v2)!;
  h.values.set(v2, '{'); assert.throws(() => h.api.getLocalGameScores(current), /could not be read/); assert.equal(h.values.get(v2), '{');
  const state = JSON.parse(raw); state.boards[0].entries[0].ownerId = 'never-public'; h.values.set(v2, JSON.stringify(state)); assert.throws(() => h.api.getLocalGameScores(current), /could not be read/);
  h.values.set(v2, raw);
  const failed = new h.api.LocalGameScoreLibrary({ getItem: h.storage.getItem, setItem: () => { throw new Error('quota'); } });
  assert.throws(() => failed.save(current, report(2, 'Second')), /could not save/); assert.equal(h.values.get(v2), raw);
  const full = JSON.parse(raw); full.boards[0].receipts = Array.from({ length: 500 }, (_, i) => ({ id: request(i + 100), report: 'existing report', qualified: false })); h.values.set(v2, JSON.stringify(full));
  const before = h.values.get(v2); assert.throws(() => h.api.saveLocalGameScore(current, report(9999)), /history.*full/); assert.equal(h.values.get(v2), before);
});

test('shared reads and submissions are anonymous and contain only normalized public result fields', async () => {
  const h = harness(true), current = game();
  assert.equal((await h.api.getGameScores(current)).scope, 'shared'); assert.deepEqual(h.calls[0], [`/game-scores/${id}?revision=2`, 'GET', undefined, false]);
  h.respond({ entries: [{ name: 'é🙂<>&', points: 100, elapsed: 2, createdAt: '2026-10-23T12:00:00.123456+00:00' }], scope: 'shared', publishedRevision: 2, limit: 10, ranking: 'points', qualified: true });
  const board = await h.api.submitGameScore(current, report(1, ' e\u0301🙂<>& '));
  assert.equal(board.entries[0].name, 'é🙂<>&'); assert.equal(board.qualified, true);
  assert.deepEqual(plain(h.calls[1]), [`/game-scores/${id}`, 'POST', { publishedRevision: 2, requestId: request(), name: 'é🙂<>&', result: result() }, false]);
  assert.equal(h.values.size, 0);
});

test('shared boards validate privacy, edition, ranking, ordering and bounded exact public fields', async () => {
  const h = harness(true), current = game(), entry = { name: 'Pilot', points: 100, elapsed: 2, createdAt: '2026-10-23T12:00:00Z' };
  const valid = { entries: [entry], scope: 'shared', publishedRevision: 2, limit: 10, ranking: 'points' };
  const invalid = [{ ...valid, ownerId: 'private' }, { ...valid, qualified: true }, { ...valid, publishedRevision: 1 }, { ...valid, scope: 'browser' }, { ...valid, limit: 20 }, { ...valid, ranking: 'time' },
    { ...valid, entries: [{ ...entry, ownerId: 'private' }] }, { ...valid, entries: [{ ...entry, name: '🙂'.repeat(9) }] }, { ...valid, entries: [{ ...entry, name: 'e\u0301' }] },
    { ...valid, entries: [{ ...entry, points: -1 }] }, { ...valid, entries: [{ ...entry, points: 2_147_483_648 }] }, { ...valid, entries: [{ ...entry, elapsed: 0 }] },
    { ...valid, entries: [{ ...entry, createdAt: 'yesterday' }] }, { ...valid, entries: [{ ...entry, createdAt: '2026-02-31T12:00:00Z' }] }, { ...valid, entries: Array.from({ length: 11 }, () => entry) }, { ...valid, entries: [entry, { ...entry, points: 200 }] }];
  for (const value of invalid) { h.respond(value); await assert.rejects(h.api.getGameScores(current)); }
  h.respond({ ...valid, entries: [entry, entry] }); assert.equal((await h.api.getGameScores(current)).entries.length, 2);
  h.respond({ ...valid, entries: [{ name: 'ABCDEFGHIJKLMNOP', points: 100, createdAt: entry.createdAt }] }); assert.equal((await h.api.getGameScores(current)).entries[0].elapsed, undefined);
  h.respond({ ...valid, entries: [{ ...entry, name: '<script>' }] }); assert.equal((await h.api.getGameScores(current)).entries[0].name, '<script>');
});

test('POST requires explicit qualification and shared failures never become browser writes', async () => {
  const h = harness(true), current = game(), base = { entries: [], scope: 'shared', publishedRevision: 2, limit: 10, ranking: 'points' };
  for (const response of [base, { ...base, qualified: 'yes' }]) { h.respond(response); await assert.rejects(h.api.submitGameScore(current, report())); }
  const denied = Object.assign(new Error('The public board is temporarily unavailable.'), { status: 503 }); h.respond(denied);
  await assert.rejects(h.api.submitGameScore(current, report()), (error: any) => error === denied && error.status === 503); assert.equal(h.values.size, 0);
  h.respond({ ...base, qualified: false }); assert.equal((await h.api.submitGameScore(current, report())).qualified, false);
  assert.deepEqual(plain(h.calls.at(-2)![2]), plain(h.calls.at(-1)![2])); assert.equal(h.values.size, 0);
});
