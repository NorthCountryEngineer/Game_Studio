import { validateCooperativeState, type CooperativeState } from './game-cooperative';
import { isEndlessAsteroids, type CooperativeGameSpec, type GameResult } from './game-types';
import { validateLeaderboardResult } from './game-leaderboard';
import type { MultiplayerSeat } from './game-multiplayer';

type LevelResult = { elapsed: number; score: number; points: number };
type Snapshot = Pick<CooperativeState, 'levelIndex' | 'elapsed' | 'nextId' | 'outcome'>;

/** Local-seat casual results only. This neither submits scores nor emits SDK events. */
export function createCooperativeLeaderboardTracker(spec: CooperativeGameSpec, seat: MultiplayerSeat) {
  const endless = isEndlessAsteroids(spec), levels = endless ? spec.levels.slice(0, 1) : spec.levels;
  let previous: Snapshot | undefined, completed: LevelResult[] = [], eligible = false, notified = false;

  function reset() { previous = undefined; completed = []; eligible = false; notified = false; }

  function observe(value: unknown): GameResult | undefined {
    const state = validateCooperativeState(value, spec);
    if (!state) return;
    const index = state.levelIndex;
    const rolledBack = previous && (index < previous.levelIndex || index === previous.levelIndex && (state.elapsed < previous.elapsed || state.nextId < previous.nextId));
    const restarted = previous && index === previous.levelIndex && state.outcome === 'playing' && previous.outcome !== 'playing';

    if (!previous || index < previous.levelIndex || index > previous.levelIndex + 1) {
      // A late observer cannot invent results for the missed campaign prefix.
      completed = []; notified = false; eligible = index === 0 && state.outcome === 'playing';
    } else if (index > previous.levelIndex) {
      eligible = eligible && previous.outcome === 'won' && completed.length === index;
      notified = false;
    } else if (rolledBack || restarted) {
      completed = completed.slice(0, index); notified = false;
      // A reset needs a playing snapshot; replayed terminal state is not a run.
      eligible = state.outcome === 'playing' && (index === 0 || eligible && completed.length === index);
    }

    previous = { levelIndex: index, elapsed: state.elapsed, nextId: state.nextId, outcome: state.outcome };
    if (!eligible || notified || state.outcome === 'playing') return;
    if (completed.length !== index) return;

    const player = state.players[seat];
    const current = { elapsed: state.elapsed, score: player.score, points: player.points };
    if (state.outcome === 'won' && index < levels.length - 1) {
      completed.push(current);
      return;
    }
    notified = true;
    const rows = [...completed, current];
    const result: GameResult = {
      outcome: state.outcome,
      elapsed: Math.round(rows.reduce((sum, row) => sum + row.elapsed, 0) * 1000) / 1000,
      score: rows.reduce((sum, row) => sum + row.score, 0),
      ...(spec.arcade?.scoring ? { points: rows.reduce((sum, row) => sum + row.points, 0) } : {}),
      reviewedLevelIds: levels.slice(0, index + 1).map(level => level.id),
    };
    const checked = validateLeaderboardResult(spec, result);
    return checked && 'reviewedLevelIds' in checked ? checked : undefined;
  }

  return { observe, reset };
}
