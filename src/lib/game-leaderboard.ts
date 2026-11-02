import { validateGameSpec } from './game-design';
import { createGameEngine, validateGameResult } from './game-runtime';
import { validateMultiGameResult, type MultiGameResult } from './multi-game-session';
import { isCooperativeGameSpec, isEndlessAsteroids, type ArcadeGameSpec, type GameResult, type GameSpec } from './game-types';

export type LeaderboardRanking = 'points' | 'time' | 'survival';
export type LeaderboardResult = GameResult | MultiGameResult;
export type LeaderboardCandidateBoard = { ranking: LeaderboardRanking; entries: { points?: number; elapsed?: number }[] };

/** Ranking follows the fixed game's scoring rules, never a player's request. */
export function leaderboardRanking(spec: GameSpec): LeaderboardRanking {
  if (spec.version === 8 || spec.version === 7 || spec.version !== 3 && !!spec.arcade?.scoring) return 'points';
  return isEndlessAsteroids(spec) ? 'survival' : 'time';
}

/** Count Unicode code points, preserving case, punctuation and emoji as text. */
export function validateLeaderboardName(value: unknown): string {
  const invalid = () => new Error('Choose a name with 1–8 printable characters.');
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value)) throw invalid();
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 8 || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(name)) throw invalid();
  return name;
}

const exact = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

function playedLevels(spec: ArcadeGameSpec, result: GameResult) {
  const stored = createGameEngine().getLevels(spec);
  const order = spec.flow ? spec.flow.nodes.filter(node => node.type === 'level').map(node => stored.find(level => level.id === node.levelId)!) : stored;
  return order.slice(0, result.reviewedLevelIds.length);
}
function hasCompletedPrefix(spec: ArcadeGameSpec, result: GameResult): boolean {
  return isEndlessAsteroids(spec) || result.score >= playedLevels(spec, result).slice(0, -1).reduce((sum, level) => sum + level.rules.goal, 0);
}

/** Casual results stay separate from host assessment and private playtest review. */
export function validateLeaderboardResult(specValue: GameSpec, value: unknown): LeaderboardResult | undefined {
  try {
    const spec = validateGameSpec(specValue);
    if (spec.version === 8) {
      const result = validateMultiGameResult(spec, value);
      if (!result || result.elapsed <= 0) return;
      for (const observation of result.games) {
        const step = spec.steps.find(step => step.id === observation.stepId);
        if (!step || step.type !== 'game' || step.spec.version !== 3 && !hasCompletedPrefix(step.spec, observation.result)) return;
      }
      return result;
    }
    const points = leaderboardRanking(spec) === 'points';
    if (!exact(value, ['outcome', 'elapsed', 'score', 'reviewedLevelIds', ...(points ? ['points'] : [])]) || !['won', 'lost'].includes(value.outcome as string)) return;
    // Cooperative snapshots use the relay's per-player ceilings. Check the
    // ordinary campaign structure independently, then the real point total.
    const cooperative = isCooperativeGameSpec(spec);
    const checked = validateGameResult(cooperative && points ? { ...value, points: 0 } : value, spec);
    if (!checked || checked.elapsed <= 0 || leaderboardRanking(spec) === 'time' && checked.outcome !== 'won') return;
    if (spec.version === 3) return checked;
    const played = playedLevels(spec, checked);
    if (!hasCompletedPrefix(spec, checked)) return;
    if (cooperative && points) {
      const count = played.length;
      const ceiling = spec.version === 6
        ? Math.min(2_147_483_647, Math.ceil(checked.elapsed * 2000) + 2000 * count + (isEndlessAsteroids(spec) ? 0 : count - 1))
        : 1_000_000 * count;
      if (typeof value.points !== 'number' || !Number.isSafeInteger(value.points) || value.points < 0 || value.points > ceiling) return;
      checked.points = value.points;
    }
    return checked;
  } catch { return; }
}

export function leaderboardValue(spec: GameSpec, result: LeaderboardResult): number {
  return leaderboardRanking(spec) === 'points' ? result.points ?? 0 : result.elapsed;
}

/** Equal results keep the earlier entry; a later tie cannot displace tenth. */
export function qualifiesLeaderboard(board: LeaderboardCandidateBoard, result: LeaderboardResult): boolean {
  const value = board.ranking === 'points' ? result.points : result.elapsed;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || board.ranking !== 'points' && value <= 0 || board.ranking === 'time' && result.outcome !== 'won') return false;
  if (board.ranking === 'points' && !Number.isSafeInteger(value)) return false;
  if (board.entries.length < 10) return true;
  const last = board.entries.at(-1)!, cutoff = board.ranking === 'points' ? last.points : last.elapsed;
  return typeof cutoff === 'number' && (board.ranking === 'time' ? value < cutoff : value > cutoff);
}
