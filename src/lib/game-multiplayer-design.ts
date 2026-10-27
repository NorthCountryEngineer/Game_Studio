import { getGameLevels } from './game-design';
import type { ArcadeGameSpec, GameLevel, GameSpec } from './game-types';
const defaultProgression = 'Learn the controls, build confidence, and finish your adventure one level at a time.';
/** Preserve the saved level data when the optional cooperative format is changed. */
export function setCooperativeMode(spec: GameSpec, enabled: boolean): ArcadeGameSpec {
  if (spec.version === 3) throw new Error('Two-player mode is available for arcade adventures.');
  const { multiplayer: _previous, ...arcade } = structuredClone(spec);
  return { ...arcade, version: enabled ? 4 : 2, levels: getGameLevels(spec), progression: spec.progression ?? defaultProgression, ...(enabled ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 } as const } : {}) };
}
export function updateArcadeLevelPlan(spec: GameSpec, levels: GameLevel[], progression = spec.version === 3 ? defaultProgression : spec.progression ?? defaultProgression): ArcadeGameSpec {
  if (spec.version === 3) throw new Error('Word games do not have an arcade level plan.');
  return { ...spec, version: spec.version === 4 ? 4 : 2, levels, progression };
}
