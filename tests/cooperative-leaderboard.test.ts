import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCooperativeLeaderboardTracker } from '../src/lib/cooperative-leaderboard.ts';
import { createCooperativeEngine, validateCooperativeState, type CooperativeState } from '../src/lib/game-cooperative.ts';
import { defaultGameSpec, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { validateLeaderboardResult } from '../src/lib/game-leaderboard.ts';
import type { CooperativeGameSpec } from '../src/lib/game-types.ts';

function game(count = 2, scoring = true): CooperativeGameSpec {
  const planned = planGameLevels({ ...defaultGameSpec(), genre: 'dodge', rules: { goal: 3, timeLimit: 60, lives: 3, difficulty: 1 }, arcade: { rotation: false, shooting: true, splitAsteroids: true, scoring, highScores: false } }, count, 'synthetic cooperative score campaign');
  return validateArcadeGameSpec({ ...planned, version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } }) as CooperativeGameSpec;
}
function advanced(endless: boolean): CooperativeGameSpec {
  return validateArcadeGameSpec({ ...game(2), version: 6, asteroids: { endless, difficultyInterval: 30, sizes: 3, enemies: { enabled: false, difficulty: 'easy', hitPoints: 1, spawnInterval: 10, maxShips: 1 } } }) as CooperativeGameSpec;
}
function snapshot(spec: CooperativeGameSpec, index = 0, outcome: CooperativeState['outcome'] = 'playing', elapsed = outcome === 'playing' ? 0 : 10, points: [number, number] = [100, 250]): CooperativeState {
  const engine = createCooperativeEngine(), state = engine.create(spec, index);
  state.running = true; state.paused = false; state.elapsed = elapsed; state.outcome = outcome;
  state.players.forEach((player, seat) => { player.points = points[seat]; player.score = outcome === 'won' ? spec.levels[index].rules.goal : seat; if (outcome === 'lost') player.lives = 0; });
  const result = engine.snapshot(state); assert.ok(validateCooperativeState(result, spec), 'the test uses valid fixed-engine snapshots'); return result;
}

test('host and guest record only their own final campaign totals after the observed contiguous prefix', () => {
  const spec = game(), trackers = [createCooperativeLeaderboardTracker(spec, 0), createCooperativeLeaderboardTracker(spec, 1)];
  for (const state of [snapshot(spec, 0), snapshot(spec, 0, 'won', 11.125), snapshot(spec, 0, 'won', 11.125), snapshot(spec, 1)]) for (const tracker of trackers) assert.equal(tracker.observe(state), undefined);
  const final = snapshot(spec, 1, 'won', 22.375, [40, 600]);
  const [host, guest] = trackers.map(tracker => tracker.observe(final));
  assert.deepEqual(host, { outcome: 'won', elapsed: 33.5, score: 6, points: 140, reviewedLevelIds: ['level-1', 'level-2'] });
  assert.deepEqual(guest, { outcome: 'won', elapsed: 33.5, score: 6, points: 850, reviewedLevelIds: ['level-1', 'level-2'] });
  assert.deepEqual(validateLeaderboardResult(spec, host), host); assert.deepEqual(validateLeaderboardResult(spec, guest), guest);
  for (const tracker of trackers) { assert.equal(tracker.observe(final), undefined); assert.equal(tracker.observe(structuredClone(final)), undefined); }
});

test('a failed attempted level includes only its own latest attempt and previously won levels', () => {
  const spec = game(), tracker = createCooperativeLeaderboardTracker(spec, 1);
  tracker.observe(snapshot(spec, 0)); tracker.observe(snapshot(spec, 0, 'won', 9, [20, 40])); tracker.observe(snapshot(spec, 1));
  assert.deepEqual(tracker.observe(snapshot(spec, 1, 'lost', 15, [100, 70])), { outcome: 'lost', elapsed: 24, score: 4, points: 110, reviewedLevelIds: ['level-1', 'level-2'] });
  assert.equal(tracker.observe(snapshot(spec, 1, 'lost', 15, [100, 70])), undefined);
  tracker.observe(snapshot(spec, 1, 'playing', 0, [0, 0]));
  assert.deepEqual(tracker.observe(snapshot(spec, 1, 'won', 5, [10, 30])), { outcome: 'won', elapsed: 14, score: 6, points: 70, reviewedLevelIds: ['level-1', 'level-2'] });
});

test('restarting the current won level replaces its row while preserving earlier completed prefix', () => {
  const spec = game(3), tracker = createCooperativeLeaderboardTracker(spec, 0);
  tracker.observe(snapshot(spec, 0)); tracker.observe(snapshot(spec, 0, 'won', 10, [20, 30]));
  tracker.observe(snapshot(spec, 1)); tracker.observe(snapshot(spec, 1, 'won', 20, [100, 300]));
  tracker.observe(snapshot(spec, 1, 'playing', 0, [0, 0])); tracker.observe(snapshot(spec, 1, 'won', 5, [40, 60]));
  tracker.observe(snapshot(spec, 2));
  assert.deepEqual(tracker.observe(snapshot(spec, 2, 'won', 7, [80, 90])), { outcome: 'won', elapsed: 22, score: 9, points: 140, reviewedLevelIds: ['level-1', 'level-2', 'level-3'] });
});

test('joining midway, skipping a level or missing its win never manufactures the missing prefix', () => {
  const spec = game(3);
  for (const states of [
    [snapshot(spec, 1), snapshot(spec, 1, 'won'), snapshot(spec, 2), snapshot(spec, 2, 'won')],
    [snapshot(spec, 0), snapshot(spec, 2), snapshot(spec, 2, 'won')],
    [snapshot(spec, 0), snapshot(spec, 1), snapshot(spec, 1, 'won'), snapshot(spec, 2), snapshot(spec, 2, 'won')],
    [snapshot(spec, 0, 'won'), snapshot(spec, 1), snapshot(spec, 1, 'won'), snapshot(spec, 2), snapshot(spec, 2, 'won')],
  ]) {
    const tracker = createCooperativeLeaderboardTracker(spec, 0);
    for (const state of states) assert.equal(tracker.observe(state), undefined);
  }
});

test('an index rollback clears old campaign rows, and a fresh level zero playing snapshot rearms the run', () => {
  const spec = game(3), tracker = createCooperativeLeaderboardTracker(spec, 0);
  tracker.observe(snapshot(spec, 0)); tracker.observe(snapshot(spec, 0, 'won', 10)); tracker.observe(snapshot(spec, 1)); tracker.observe(snapshot(spec, 1, 'won', 10)); tracker.observe(snapshot(spec, 2));
  assert.equal(tracker.observe(snapshot(spec, 1, 'won', 10)), undefined);
  tracker.observe(snapshot(spec, 2)); assert.equal(tracker.observe(snapshot(spec, 2, 'won', 10)), undefined);
  tracker.observe(snapshot(spec, 0, 'playing', 0, [0, 0])); tracker.observe(snapshot(spec, 0, 'won', 2, [10, 10])); tracker.observe(snapshot(spec, 1)); tracker.observe(snapshot(spec, 1, 'won', 3, [20, 20])); tracker.observe(snapshot(spec, 2));
  assert.equal(tracker.observe(snapshot(spec, 2, 'won', 4, [30, 30]))?.points, 60);
});

test('elapsed or entity-id rollback into playing resets only the current level without accepting terminal replays', () => {
  const spec = game(), tracker = createCooperativeLeaderboardTracker(spec, 0);
  tracker.observe(snapshot(spec, 0)); tracker.observe(snapshot(spec, 0, 'won', 10));
  const played = snapshot(spec, 1, 'playing', 20); played.nextId += 100; tracker.observe(played);
  const reset = snapshot(spec, 1, 'playing', 20); tracker.observe(reset);
  const final = snapshot(spec, 1, 'lost', 25, [50, 100]);
  assert.equal(tracker.observe(final)?.points, 150);
  const replay = structuredClone(final); replay.elapsed = 5;
  assert.equal(tracker.observe(replay), undefined, 'a terminal rollback cannot open a new score submission');
  assert.equal(tracker.observe(final), undefined);
});

test('invalid or nonterminal snapshots never trigger completion, mutate caller state or add another player points', () => {
  const spec = game(1), tracker = createCooperativeLeaderboardTracker(spec, 0), initial = snapshot(spec), before = JSON.stringify(initial);
  assert.equal(tracker.observe(initial), undefined); assert.equal(JSON.stringify(initial), before);
  const final = snapshot(spec, 0, 'won', 5, [12, 999]);
  for (const invalid of [{ ...final, identity: 'not-allowed' }, { ...final, players: [{ ...final.players[0], points: -1 }, final.players[1]] }, { ...final, players: [{ ...final.players[0], score: 2 }, final.players[1]] }]) assert.equal(tracker.observe(invalid), undefined);
  const result = tracker.observe(final); assert.equal(result?.points, 12); assert.equal(result?.score, 3);
  final.players[0].points = 100; assert.equal(result?.points, 12); assert.equal(tracker.observe(final), undefined);
});

test('pointless cooperation reports successful completion time and omits a loss from the time leaderboard', () => {
  const spec = game(1, false), tracker = createCooperativeLeaderboardTracker(spec, 0);
  tracker.observe(snapshot(spec)); assert.equal(tracker.observe(snapshot(spec, 0, 'lost', 5)), undefined);
  tracker.observe(snapshot(spec, 0, 'playing', 0, [0, 0]));
  assert.deepEqual(tracker.observe(snapshot(spec, 0, 'won', 12.345)), { outcome: 'won', elapsed: 12.345, score: 3, reviewedLevelIds: ['level-1'] });
});

test('endless cooperation submits only the local final loss and may start another run after restart', () => {
  const spec = advanced(true), tracker = createCooperativeLeaderboardTracker(spec, 1);
  tracker.observe(snapshot(spec, 0, 'playing', 0, [0, 0]));
  const ended = snapshot(spec, 0, 'lost', 120, [250, 600]);
  assert.deepEqual(tracker.observe(ended), { outcome: 'lost', elapsed: 120, score: 1, points: 600, reviewedLevelIds: ['level-1'] });
  assert.equal(tracker.observe(ended), undefined);
  tracker.observe(snapshot(spec, 0, 'playing', 0, [0, 0])); assert.equal(tracker.observe(snapshot(spec, 0, 'lost', 5, [10, 20]))?.points, 20);
});

test('pointless endless cooperation reports its terminal survival time without a points field', () => {
  const original = advanced(true), spec = validateArcadeGameSpec({ ...original, arcade: { ...original.arcade!, scoring: false, highScores: false } }) as CooperativeGameSpec;
  const tracker = createCooperativeLeaderboardTracker(spec, 1);
  tracker.observe(snapshot(spec, 0, 'playing', 0, [0, 0]));
  assert.deepEqual(tracker.observe(snapshot(spec, 0, 'lost', 18.5, [0, 0])), { outcome: 'lost', elapsed: 18.5, score: 1, reviewedLevelIds: ['level-1'] });
});

test('raw per-player cooperative ceilings remain valid for version4, prizes and advanced totals', () => {
  const base = game(1), prizes = validateArcadeGameSpec({ ...base, version: 5, powerUps: { spawnInterval: 10, duration: 8, types: ['shield'] } }) as CooperativeGameSpec;
  for (const spec of [base, prizes]) {
    const tracker = createCooperativeLeaderboardTracker(spec, 0); tracker.observe(snapshot(spec));
    assert.equal(tracker.observe(snapshot(spec, 0, 'lost', 1, [1000000, 0]))?.points, 1000000);
  }
  const spec = advanced(false), tracker = createCooperativeLeaderboardTracker(spec, 0);
  tracker.observe(snapshot(spec, 0)); tracker.observe(snapshot(spec, 0, 'won', 1, [4000, 0])); tracker.observe(snapshot(spec, 1));
  assert.equal(tracker.observe(snapshot(spec, 1, 'won', 1, [4000, 0]))?.points, 8000);
});

test('pause and resume preserve an eligible run, while an explicit tracker reset discards it', () => {
  const spec = game(), tracker = createCooperativeLeaderboardTracker(spec, 0);
  tracker.observe(snapshot(spec, 0)); tracker.observe(snapshot(spec, 0, 'won', 10));
  const paused = snapshot(spec, 1); paused.paused = true; tracker.observe(paused); tracker.observe(snapshot(spec, 1));
  assert.equal(tracker.observe(snapshot(spec, 1, 'won', 10))?.points, 200);
  tracker.reset(); assert.equal(tracker.observe(snapshot(spec, 1, 'won', 10)), undefined);
});

test('versus snapshots cannot enter a cooperative or solo campaign result tracker', () => {
  const spec = game(1), engine = createCooperativeEngine(), tracker = createCooperativeLeaderboardTracker(spec, 0);
  const match = { mode: 'versus' as const, lives: 1, timeLimit: 30 };
  const state = engine.create(spec, 0, match); state.running = true; state.paused = false;
  assert.ok(validateCooperativeState(engine.snapshot(state), spec, match));
  assert.equal(tracker.observe(engine.snapshot(state)), undefined);
  state.elapsed = 2; state.players[1].lives = 0; state.outcome = 'finished'; state.running = false;
  state.versus = { winner: 0, reason: 'elimination' };
  assert.ok(validateCooperativeState(engine.snapshot(state), spec, match));
  assert.equal(tracker.observe(engine.snapshot(state)), undefined);
  tracker.observe(snapshot(spec));
  assert.deepEqual(tracker.observe(snapshot(spec, 0, 'lost', 3, [20, 30])), { outcome: 'lost', elapsed: 3, score: 0, points: 20, reviewedLevelIds: ['level-1'] });
});
