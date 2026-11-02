import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultGameSpec, planGameLevels, updateAsteroidSettings, validateGameSpec } from '../src/lib/game-design';
import { createPlatformerSpec } from '../src/lib/game-flow';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../src/lib/multi-game';
import { leaderboardRanking, leaderboardValue, qualifiesLeaderboard, validateLeaderboardName, validateLeaderboardResult } from '../src/lib/game-leaderboard';
import type { ArcadeGameSpec, GameResult, GameSpec, WordGameSpec } from '../src/lib/game-types';
import type { MultiGameResult } from '../src/lib/multi-game-session';

const ordinary = defaultGameSpec();
const arcade = validateGameSpec({ ...ordinary, genre: 'dodge', theme: 'space', arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: false } }) as ArcadeGameSpec;
const campaign = planGameLevels(arcade, 3, 'leaderboard fixture');
const cooperative = validateGameSpec({ ...campaign, version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } }) as ArcadeGameSpec;
const endless = updateAsteroidSettings(arcade, { endless: true });
const survival = validateGameSpec({ ...endless, arcade: { ...endless.arcade!, scoring: false } }) as ArcadeGameSpec;
const platformer = createPlatformerSpec();
const words = ['crossword', 'word-search', 'mad-libs'].map(genre => defaultWordGameSpec(genre as WordGameSpec['genre']));
const puzzleSize = (spec: WordGameSpec) => spec.genre === 'crossword' ? spec.puzzle.entries.length : spec.genre === 'word-search' ? spec.puzzle.words.length : spec.puzzle.blanks.length;
const wordWin = (spec: WordGameSpec): GameResult => ({ outcome: 'won', elapsed: 2, score: puzzleSize(spec), reviewedLevelIds: ['level-1'] });
const lost: GameResult = { outcome: 'lost', elapsed: 10, score: 0, points: 100, reviewedLevelIds: ['level-1'] };
const multi = defaultMultiGameSpec();
const childGames = multi.steps.flatMap(step => step.type === 'game' && step.spec.version === 3 ? [{ stepId: step.id, result: wordWin(step.spec) }] : []);
const journey: MultiGameResult = { outcome: 'won', elapsed: 4, wallElapsed: 4, score: childGames.reduce((sum, child) => sum + child.result.score, 0), points: childGames.reduce((sum, child) => sum + child.result.score * 10, 0), games: childGames, materials: [] };

test('every fixed format has a board, independent of the old high-score switch', () => {
  for (const spec of [ordinary, ...words]) assert.equal(leaderboardRanking(spec), 'time');
  for (const spec of [arcade, campaign, cooperative, endless, platformer, multi]) assert.equal(leaderboardRanking(spec), 'points');
  assert.equal(leaderboardRanking(survival), 'survival');
  assert.equal(leaderboardValue(words[0], wordWin(words[0])), 2);
  assert.equal(leaderboardValue(arcade, lost), 100);
});

test('new eight-character names preserve arbitrary printable text, case, Unicode and punctuation', () => {
  for (const [input, expected] of [[' Pilot ', 'Pilot'], ['\ufeffPilot\ufeff', 'Pilot'], ['<script>', '<script>'], ['猫🙂£!?', '猫🙂£!?'], ['A  b', 'A  b'], ['e\u0301', 'é'], ['🙂'.repeat(8), '🙂'.repeat(8)]]) assert.equal(validateLeaderboardName(input), expected);
  for (const value of ['', ' ', '123456789', '🙂'.repeat(9), '\nPilot', 'Pilot\t', 'x\u202ey', 'x\u2067y', '\u200d', '\u0301', '\u2028', '\ud800', null, true, 42]) assert.throws(() => validateLeaderboardName(value));
});

test('time boards admit completed puzzles and reject reveals, quick losses and unknown fields', () => {
  for (const spec of words) {
    assert.deepEqual(validateLeaderboardResult(spec, wordWin(spec)), wordWin(spec));
    for (const bad of [{ ...wordWin(spec), outcome: 'lost' }, { ...wordWin(spec), score: 0 }, { ...wordWin(spec), elapsed: 0 }, { ...wordWin(spec), points: 1 }, { ...wordWin(spec), answers: [] }, { ...wordWin(spec), reviewedLevelIds: ['level-2'] }]) assert.equal(validateLeaderboardResult(spec, bad), undefined);
  }
  assert.ok(validateLeaderboardResult(ordinary, { outcome: 'won', elapsed: 8, score: ordinary.rules.goal, reviewedLevelIds: ['level-1'] }));
  assert.equal(validateLeaderboardResult(ordinary, { ...lost, points: undefined }), undefined);
});

test('point boards accept terminal zero-point runs but retain campaign and exact result bounds', () => {
  assert.ok(validateLeaderboardResult(arcade, { ...lost, points: 0 }));
  for (const bad of [{ ...lost, outcome: 'level-complete' }, { ...lost, elapsed: 0 }, { ...lost, points: -1 }, { ...lost, points: 2_147_483_648 }, { ...lost, points: 1.5 }, { ...lost, score: true }, { ...lost, token: 'unexpected' }]) assert.equal(validateLeaderboardResult(arcade, bad), undefined);
  const partial = { ...lost, reviewedLevelIds: ['level-1', 'level-2'], score: campaign.levels![0].rules.goal };
  assert.ok(validateLeaderboardResult(campaign, partial));
  assert.equal(validateLeaderboardResult(campaign, { ...partial, score: 0 }), undefined);
  assert.equal(validateLeaderboardResult(campaign, { ...partial, reviewedLevelIds: ['level-2', 'level-1'] }), undefined);
  assert.equal(validateLeaderboardResult(campaign, { ...partial, outcome: 'won' }), undefined);
});

test('platformer and cooperative results use their published per-player scoring rules', () => {
  const pixel = { ...lost, score: 2, points: 20 };
  assert.ok(validateLeaderboardResult(platformer, pixel));
  assert.equal(validateLeaderboardResult(platformer, { ...pixel, points: 21 }), undefined);
  assert.ok(validateLeaderboardResult(cooperative, { ...lost, points: 1_000_000 }));
  assert.equal(validateLeaderboardResult(cooperative, { ...lost, points: 1_000_001 }), undefined);
});

test('endless games without points rank longest survival and never invent a successful finish', () => {
  const value = { outcome: 'lost', elapsed: 40, score: 0, reviewedLevelIds: ['level-1'] };
  assert.ok(validateLeaderboardResult(survival, value));
  for (const bad of [{ ...value, outcome: 'won' }, { ...value, elapsed: 0 }, { ...value, points: 0 }]) assert.equal(validateLeaderboardResult(survival, bad), undefined);
});

test('multi-game boards count only validated main games and preserve required material gates', () => {
  assert.deepEqual(validateLeaderboardResult(multi, journey), journey);
  for (const bad of [{ ...journey, points: journey.points + 1 }, { ...journey, elapsed: 5 }, { ...journey, games: [...journey.games].reverse() }, { ...journey, player: 'unexpected' }]) assert.equal(validateLeaderboardResult(multi, bad), undefined);
  const withMaterial = validateGameSpec({ ...multi, steps: [multi.steps[0], { id: 'step-2', type: 'material', kind: 'content', title: 'Client object', reference: 'client-object', required: true }, { ...multi.steps[1], id: 'step-3' }] });
  const completed = { ...journey, wallElapsed: 5, games: [{ ...journey.games[0] }, { ...journey.games[1], stepId: 'step-3' }], materials: [{ path: ['step-2'], status: 'completed', elapsed: 1 }] };
  assert.ok(validateLeaderboardResult(withMaterial, completed));
  assert.equal(validateLeaderboardResult(withMaterial, { ...completed, materials: [] }), undefined);
  assert.equal(validateLeaderboardResult(withMaterial, { ...completed, materials: [{ ...completed.materials[0], status: 'skipped' }] }), undefined);
  const withFreePlay = validateGameSpec({ ...multi, steps: [...multi.steps, { id: 'step-3', type: 'free-play', spec: endless }] });
  assert.ok(validateLeaderboardResult(withFreePlay, journey));
  assert.equal(validateLeaderboardResult(withFreePlay, { ...journey, games: [...journey.games, { stepId: 'step-3', result: lost }] }), undefined);
  const leveled = validateGameSpec({ ...multi, steps: [{ id: 'step-1', type: 'game', spec: campaign }] });
  const badPrefix = { ...lost, reviewedLevelIds: ['level-1', 'level-2'] };
  assert.equal(validateLeaderboardResult(leveled, { outcome: 'lost', elapsed: 10, wallElapsed: 10, score: 0, points: 100, games: [{ stepId: 'step-1', result: badPrefix }], materials: [] }), undefined);
});

test('qualification follows rank direction and keeps existing ties ahead of later runs', () => {
  const pointBoard = { ranking: 'points' as const, entries: Array.from({ length: 10 }, (_, index) => ({ points: 100 - index })) };
  assert.equal(qualifiesLeaderboard(pointBoard, { ...lost, points: 91 }), false);
  assert.equal(qualifiesLeaderboard(pointBoard, { ...lost, points: 92 }), true);
  const timeBoard = { ranking: 'time' as const, entries: Array.from({ length: 10 }, (_, index) => ({ elapsed: index + 1 })) };
  assert.equal(qualifiesLeaderboard(timeBoard, { ...wordWin(words[0]), elapsed: 10 }), false);
  assert.equal(qualifiesLeaderboard(timeBoard, { ...wordWin(words[0]), elapsed: 9 }), true);
  assert.equal(qualifiesLeaderboard(timeBoard, { ...lost, elapsed: 0.1 }), false);
  const survivalBoard = { ranking: 'survival' as const, entries: Array.from({ length: 10 }, (_, index) => ({ elapsed: 100 - index })) };
  assert.equal(qualifiesLeaderboard(survivalBoard, { ...lost, elapsed: 91 }), false);
  assert.equal(qualifiesLeaderboard(survivalBoard, { ...lost, elapsed: 92 }), true);
});

test('TypeScript and the real Python leaderboard validators agree on all formats and Unicode names', () => {
  const cases: { spec: GameSpec; result: unknown }[] = [
    { spec: arcade, result: lost }, { spec: arcade, result: { ...lost, points: 0 } }, { spec: cooperative, result: { ...lost, points: 1_000_000 } },
    { spec: cooperative, result: { ...lost, points: 1_000_001 } }, { spec: platformer, result: { ...lost, score: 1, points: 10 } },
    { spec: survival, result: { outcome: 'lost', elapsed: 100, score: 0, reviewedLevelIds: ['level-1'] } }, { spec: multi, result: journey },
    ...words.map(spec => ({ spec, result: wordWin(spec) })),
  ];
  for (const entry of [...cases]) for (const change of [{ elapsed: 0 }, { elapsed: -1 }, { elapsed: null }, { score: true }, { points: -1 }, { outcome: 'level-complete' }, { unknown: 1 }]) cases.push({ spec: entry.spec, result: { ...(entry.result as object), ...change } });
  const names: unknown[] = ['Pilot', '\ufeffPilot\ufeff', '🙂'.repeat(8), '<script>', '猫🙂£!?', 'e\u0301', 'A  b', '123456789', '\nPilot', '\u200d', '\u0301', '\ud800', 'x\u202ey', null, 4];
  const directory = mkdtempSync(join(tmpdir(), 'game-leaderboard-parity-'));
  try {
    const file = join(directory, 'synthetic.json'); writeFileSync(file, JSON.stringify({ cases, names }));
    const script = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('parity_scores',Path.cwd()/'backend/nce_api/game_scores.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ndata=json.load(open(sys.argv[1]))\ndef valid(c):\n try:\n  spec=m.games().validate_spec(c['spec']); r=m.validate_result(c['result'],spec)\n  return bool(r['elapsed']>0 and (m.ranking(spec)!='time' or r['outcome']=='won'))\n except (m.ScoreError,m.games().GameError,KeyError,TypeError,ValueError):return False\ndef name(v):\n try:return m.validate_name(v)\n except m.ScoreError:return None\nprint(json.dumps({'valid':[valid(c) for c in data['cases']],'rankings':[m.ranking(m.games().validate_spec(c['spec'])) for c in data['cases']],'names':[name(v) for v in data['names']]},ensure_ascii=True))`;
    const actual = JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));
    assert.deepEqual(actual.valid, cases.map(entry => !!validateLeaderboardResult(entry.spec, entry.result)));
    assert.deepEqual(actual.rankings, cases.map(entry => leaderboardRanking(entry.spec)));
    assert.deepEqual(actual.names, names.map(value => { try { return validateLeaderboardName(value); } catch { return null; } }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
