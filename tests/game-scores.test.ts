import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { defaultGameSpec, updateAsteroidSettings, validateGameSpec } from '../src/lib/game-design.ts';
import { createGameEngine, validateGameResult } from '../src/lib/game-runtime.ts';
import type { Game, GameResult } from '../src/lib/game-types.ts';
import type { ArcadeGameSpec } from '../src/lib/game-types.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';

const id = '11111111-1111-4111-8111-111111111111';
const request = (n = 1) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
function game(revision = 2): Game {
  return { id, revision, publishedRevision: revision, status: 'Published', createdAt: '2026-10-23T12:00:00Z', updatedAt: '2026-10-23T12:00:00Z', spec: validateGameSpec({ ...defaultGameSpec(), genre: 'dodge', theme: 'space', arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true } }) };
}
const result = (points = 100): GameResult => ({ outcome: 'lost', elapsed: 2, score: 0, reviewedLevelIds: ['level-1'], points });
const report = (n = 1, name = 'Gill Pilot', points = 100) => ({ requestId: request(n), name, result: result(points) });
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function harness(connected = false) {
  const values = new Map<string, string>(), calls: any[][] = [];
  let response: unknown = { entries: [], scope: 'shared', publishedRevision: 2, limit: 10 };
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const core = { isCore: connected, coreRequest: async (...args: any[]) => { calls.push(args); if (response instanceof Error) throw response; return response; } };
  const source = readFileSync(new URL('../src/lib/game-scores.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api: any = {};
  vm.runInNewContext(js, { exports: api, require: (name: string) => name === './core' ? core : name === './game-design' ? { validateGameSpec } : name === './game-runtime' ? { createGameEngine, validateGameResult } : {}, localStorage: storage, TextEncoder, Date, JSON, Error });
  return { api, storage, values, calls, respond: (value: unknown) => { response = value; } };
}

test('endless editions retain casual boards, reject invented wins and preserve existing saved scores', () => {
  const h = harness(), legacy = game();
  h.api.saveLocalGameScore(legacy, report());
  const endless: Game = { ...game(3), spec: updateAsteroidSettings(game().spec as ArcadeGameSpec, { endless: true }) };
  const run = { requestId: request(50), name: 'Long Run', result: { outcome: 'lost', elapsed: 100000, score: 1000, points: 1500000, reviewedLevelIds: ['level-1'] } };
  assert.equal(h.api.saveLocalGameScore(endless, run).entries[0].points, 1500000);
  for (const invalid of [{ ...run.result, outcome: 'won' }, { ...run.result, outcome: 'level-complete' }, { ...run.result, elapsed: 1, points: 1000000 }, { ...run.result, reviewedLevelIds: ['level-2'] }]) assert.throws(() => h.api.saveLocalGameScore(endless, { ...run, requestId: request(51), result: invalid }));
  assert.equal(h.api.getLocalGameScores(legacy).entries[0].points, 100);
  assert.equal(h.api.getLocalGameScores(endless).entries[0].points, 1500000);
  const cooperative = { ...endless, spec: { ...endless.spec, multiplayer: { mode: 'cooperative', maxPlayers: 2 } } };
  assert.throws(() => h.api.getLocalGameScores(cooperative), /disabled/);
});

test('arcade names are bounded, plain ASCII nicknames with consistent normalization', () => {
  const { api } = harness();
  assert.equal(api.validateArcadeName(' gill  pilot '), 'GILL PILOT');
  assert.equal(api.validateArcadeName('axolotl_1-x'), 'AXOLOTL_1-X');
  for (const bad of ['', '   ', 'x'.repeat(17), '<script>', 'Gill\nPilot', '\tPilot', 'Lótl', '鱼', null, 42]) assert.throws(() => api.validateArcadeName(bad), /arcade name/);
});

test('word games cannot read or submit arcade boards and leave existing boards intact', () => {
  const h = harness(), arcade = game();
  h.api.saveLocalGameScore(arcade, report());
  const original = [...h.values.entries()];
  for (const genre of ['crossword', 'word-search', 'mad-libs'] as const) {
    const puzzle = { ...game(), spec: defaultWordGameSpec(genre) };
    assert.throws(() => h.api.getLocalGameScores(puzzle), /disabled/);
    assert.throws(() => h.api.saveLocalGameScore(puzzle, report(2)), /disabled/);
  }
  assert.deepEqual([...h.values.entries()], original);
  assert.equal(h.calls.length, 0);
});

test('browser scores stay separate from newsroom data and retain each nickname’s best top-ten result', () => {
  const h = harness(), current = game(); h.values.set('unrelated-posts', 'preserve me');
  assert.deepEqual(plain(h.api.getLocalGameScores(current)), { entries: [], scope: 'browser', publishedRevision: 2, limit: 10 });
  const first = h.api.saveLocalGameScore(current, report());
  assert.equal(first.entries[0].name, 'GILL PILOT'); assert.equal(first.entries[0].points, 100);
  h.api.saveLocalGameScore(current, report(2, 'gill pilot', 50));
  assert.equal(h.api.getLocalGameScores(current).entries.length, 1);
  assert.equal(h.api.getLocalGameScores(current).entries[0].points, 100);
  h.api.saveLocalGameScore(current, report(3, 'Gill Pilot', 200));
  for (let i = 4; i < 18; i++) h.api.saveLocalGameScore(current, report(i, `Pilot ${i}`, i * 20));
  const board = h.api.getLocalGameScores(current);
  assert.equal(board.entries.length, 10); assert.equal(board.entries[0].points, 340);
  assert.ok(board.entries.every((entry: any, i: number) => !i || board.entries[i - 1].points >= entry.points));
  first.entries[0].points = 9999; assert.equal(h.api.getLocalGameScores(current).entries[0].points, 340);
  assert.equal(h.values.get('unrelated-posts'), 'preserve me'); assert.equal(h.calls.length, 0);
});

test('published editions and games have separate browser boards and stale or private metadata is rejected', () => {
  const h = harness(), current = game(); h.api.saveLocalGameScore(current, report());
  assert.equal(h.api.getLocalGameScores(game(3)).entries.length, 0);
  assert.equal(h.api.getLocalGameScores({ ...current, id: request(99) }).entries.length, 0);
  for (const changed of [{ ...current, status: 'Draft' }, { ...current, revision: 3 }, { ...current, publishedRevision: undefined }, { ...current, revision: 0, publishedRevision: 0 }, { ...current, revision: 1000000001, publishedRevision: 1000000001 }, { ...current, spec: { ...current.spec, arcade: { ...current.spec.arcade!, highScores: false } } }]) assert.throws(() => h.api.saveLocalGameScore(changed, report(2)), /published|disabled/);
});

test('browser score retries are idempotent and identifiers cannot be reused for a different report or board', () => {
  const h = harness(), current = game(), original = h.api.saveLocalGameScore(current, report());
  assert.deepEqual(plain(h.api.saveLocalGameScore(current, { ...report(), name: 'gill pilot' })), plain(original));
  for (const changed of [report(1, 'Another'), report(1, 'Gill Pilot', 200), { ...report(), result: { ...result(), elapsed: 3 } }]) assert.throws(() => h.api.saveLocalGameScore(current, changed), /already used/);
  assert.throws(() => h.api.saveLocalGameScore(game(3), report()), /already used/);
  assert.equal(h.api.getLocalGameScores(current).entries.length, 1);
});

test('only valid completed campaign reports with bounded positive points can be saved', () => {
  const h = harness(), current = game(), ceiling = createGameEngine().maxPoints(current.spec);
  const invalid = [
    { ...report(), requestId: 'not-a-uuid' },
    { ...report(), unexpected: 'payload' },
    { ...report(), result: { ...result(), secret: 'private' } },
    { ...report(), result: { ...result(), outcome: 'level-complete' } },
    { ...report(), result: result(0) },
    { ...report(), result: result(-1) },
    { ...report(), result: result(1.5) },
    { ...report(), result: result(ceiling + 1) },
    { ...report(), result: { ...result(), elapsed: Infinity } },
    { ...report(), result: { ...result(), elapsed: 0 } },
    { ...report(), result: { ...result(), reviewedLevelIds: ['wrong-level'] } },
    { ...report(), result: { ...result(), outcome: 'won', score: 0 } },
  ];
  for (const value of invalid) assert.throws(() => h.api.saveLocalGameScore(current, value), /report|round|score/);
  assert.equal(h.values.size, 0);
});

test('corrupt or overfull browser storage and failed writes preserve existing data', () => {
  const h = harness(), current = game(); h.api.saveLocalGameScore(current, report());
  const [key, raw] = [...h.values][0];
  h.values.set(key, '{'); assert.throws(() => h.api.getLocalGameScores(current), /could not be read/); assert.equal(h.values.get(key), '{');
  const state = JSON.parse(raw); state.boards[0].entries[0].ownerId = 'never-public'; h.values.set(key, JSON.stringify(state));
  assert.throws(() => h.api.getLocalGameScores(current), /could not be read/);
  h.values.set(key, raw);
  const failed = new h.api.LocalGameScoreLibrary({ getItem: (name: string) => h.values.get(name) ?? null, setItem: () => { throw new Error('quota'); } });
  assert.throws(() => failed.save(current, report(2, 'Second')), /could not save/); assert.equal(h.values.get(key), raw);
  const full = JSON.parse(raw); full.boards[0].receipts = Array.from({ length: 500 }, (_, i) => ({ id: request(i + 100), report: 'existing report' })); h.values.set(key, JSON.stringify(full));
  const before = h.values.get(key); assert.throws(() => h.api.saveLocalGameScore(current, report(9999)), /history.*full/); assert.equal(h.values.get(key), before);
});

test('shared reads are public, submissions are authenticated and contain only normalized score fields', async () => {
  const h = harness(true), current = game();
  assert.equal((await h.api.getGameScores(current)).scope, 'shared');
  assert.deepEqual(h.calls[0], [`/game-scores/${id}?revision=2`, 'GET', undefined, false]);
  h.respond({ entries: [{ name: 'GILL PILOT', points: 100, createdAt: '2026-10-23T12:00:00.123456+00:00' }], scope: 'shared', publishedRevision: 2, limit: 10 });
  const board = await h.api.submitGameScore(current, report());
  assert.equal(board.entries[0].name, 'GILL PILOT');
  const [path, method, body, authorized] = h.calls[1];
  assert.equal(path, `/game-scores/${id}`); assert.equal(method, 'POST'); assert.equal(authorized, undefined);
  assert.deepEqual(plain(body), { publishedRevision: 2, requestId: request(), name: 'GILL PILOT', result: result() });
  assert.equal(h.values.size, 0);
});

test('shared response privacy, current edition, bounds, ordering, and exact fields are validated', async () => {
  const h = harness(true), current = game();
  const entry = { name: 'GILL PILOT', points: 100, createdAt: '2026-10-23T12:00:00Z' };
  const valid = { entries: [entry], scope: 'shared', publishedRevision: 2, limit: 10 };
  const invalid = [
    { ...valid, ownerId: 'private' }, { ...valid, publishedRevision: 1 }, { ...valid, scope: 'browser' }, { ...valid, limit: 20 },
    { ...valid, entries: [{ ...entry, ownerId: 'private' }] },
    { ...valid, entries: [{ ...entry, name: '<script>' }] },
    { ...valid, entries: [{ ...entry, name: 'lowercase' }] },
    { ...valid, entries: [{ ...entry, points: -1 }] },
    { ...valid, entries: [{ ...entry, points: createGameEngine().maxPoints(current.spec) + 1 }] },
    { ...valid, entries: [{ ...entry, createdAt: 'yesterday' }] },
    { ...valid, entries: [{ ...entry, createdAt: '2026-02-31T12:00:00Z' }] },
    { ...valid, entries: Array.from({ length: 11 }, () => entry) },
    { ...valid, entries: [entry, { ...entry, points: 200 }] },
  ];
  for (const value of invalid) { h.respond(value); await assert.rejects(h.api.getGameScores(current)); }
  h.respond({ ...valid, entries: [entry, entry] }); assert.equal((await h.api.getGameScores(current)).entries.length, 2, 'Different accounts may choose the same nickname.');
});

test('shared failures never fall back to browser writes and exact request retries stay stable', async () => {
  const h = harness(true), current = game(), denied = Object.assign(new Error('Sign in again.'), { status: 401 });
  h.respond(denied);
  await assert.rejects(h.api.submitGameScore(current, report()), (error: any) => error === denied && error.status === 401);
  assert.equal(h.values.size, 0);
  h.respond({ entries: [], scope: 'shared', publishedRevision: 2, limit: 10 });
  await h.api.submitGameScore(current, report()); assert.deepEqual(plain(h.calls[0][2]), plain(h.calls[1][2]));
});


test('a lost multi-level score includes collection progress from completed earlier levels', () => {
  const h = harness(), current = game();
  const level = createGameEngine().getLevels(current.spec)[0];
  current.spec = validateGameSpec({ ...current.spec, version: 2, progression: 'Learn the controls, then clear the next challenge.', levels: [level, { ...level, id: 'level-2', title: 'Second level', seed: 17032 }] });
  const played = { ...result(), reviewedLevelIds: ['level-1', 'level-2'] };
  assert.throws(() => h.api.saveLocalGameScore(current, { ...report(), result: played }), /previous levels/);
  assert.equal(h.values.size, 0);
  const board = h.api.saveLocalGameScore(current, { ...report(), result: { ...played, score: level.rules.goal } });
  assert.equal(board.entries[0].points, 100);
});
