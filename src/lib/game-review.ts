import { gameReviewLevelIds, isEndlessAsteroids, type GameSpec } from './game-types';

export type GameReview = { elapsed: number; reviewedLevelIds: string[] };

export function gamePlayerLoadMessage(spec: GameSpec, nonce: string, levelId?: string, playtest = false) {
  // The older word-player protocol deliberately accepts no preview-only flags.
  return { type: 'axolotl-game-load', nonce, spec, levelId, ...(spec.version !== 3 ? { playtest } : {}) };
}

/** Private preview acknowledgement, deliberately separate from a game result. */
export function validateGameReview(value: unknown, spec: GameSpec, levelId?: string): GameReview | undefined {
  if (!isEndlessAsteroids(spec) || !value || typeof value !== 'object' || Array.isArray(value)) return;
  const review = value as Record<string, unknown>;
  if (Object.keys(review).sort().join(',') !== 'elapsed,reviewedLevelIds' || typeof review.elapsed !== 'number' || !Number.isFinite(review.elapsed) || review.elapsed < 5 || review.elapsed > 2_147_483_647) return;
  const allowed = levelId ? spec.version !== 3 && spec.levels?.some(level => level.id === levelId) ? [levelId] : [] : gameReviewLevelIds(spec);
  if (!Array.isArray(review.reviewedLevelIds) || review.reviewedLevelIds.length !== 1 || allowed.length !== 1 || review.reviewedLevelIds[0] !== allowed[0]) return;
  return { elapsed: review.elapsed, reviewedLevelIds: [allowed[0]] };
}
