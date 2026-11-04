import type { ArcadeGameSpec, GameSpec } from './game-types';

/** Immutable room settings; the published game and saved levels stay unchanged. */
export type VersusMatch = { mode: 'versus'; lives: number; timeLimit: number };

/** Self-contained so the same validator can run inside the fixed sandbox. */
export function validateVersusMatch(value: unknown): VersusMatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || !Object.keys(item).every(key => ['mode', 'lives', 'timeLimit'].includes(key)) || item.mode !== 'versus' || typeof item.lives !== 'number' || !Number.isInteger(item.lives) || item.lives < 1 || item.lives > 5 || typeof item.timeLimit !== 'number' || !Number.isInteger(item.timeLimit) || item.timeLimit < 30 || item.timeLimit > 180) return;
  return { mode: 'versus', lives: item.lives, timeLimit: item.timeLimit };
}

/** Eligibility follows the original validated edition, never room-provided data. */
export function isVersusEligible(spec: GameSpec): spec is ArcadeGameSpec {
  return [1, 2, 4, 5, 6].includes(spec.version) && spec.genre === 'dodge' && Boolean(spec.arcade?.shooting) && !spec.flow;
}
