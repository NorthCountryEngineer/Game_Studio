import { defaultPowerUps, getGameLevels, reconcileArcadeFormat } from './game-design';
import type { ArcadeGameSpec, GameLevel, GamePowerUps, GamePowerUpType, GameSpec } from './game-types';
const defaultProgression = 'Learn the controls, build confidence, and finish your adventure one level at a time.';
/** Preserve the saved level data when the optional cooperative format is changed. */
export function setCooperativeMode(spec: GameSpec, enabled: boolean): ArcadeGameSpec {
  if (spec.version === 3) throw new Error('Two-player mode is available for arcade adventures.');
  const { multiplayer: _previous, ...arcade } = structuredClone(spec);
  return { ...arcade, version: spec.version === 6 ? 6 : spec.version === 5 ? 5 : enabled ? 4 : 2, levels: getGameLevels(spec), progression: spec.progression ?? defaultProgression, ...(enabled ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 } as const } : {}) };
}
export function updateArcadeLevelPlan(spec: GameSpec, levels: GameLevel[], progression = spec.version === 3 ? defaultProgression : spec.progression ?? defaultProgression): ArcadeGameSpec {
  if (spec.version === 3) throw new Error('Word games do not have an arcade level plan.');
  return { ...spec, version: spec.version === 6 ? 6 : spec.version === 5 ? 5 : spec.version === 4 ? 4 : 2, levels, progression };
}

/** New prize editions always copy the authored plan rather than re-generating it. */
export function setPowerUpsEnabled(spec: GameSpec, enabled: boolean): ArcadeGameSpec {
  if (spec.version === 3) throw new Error('Periodic prizes are available for Asteroids arcade games.');
  if (enabled && (spec.genre !== 'dodge' || !spec.arcade?.shooting)) throw new Error('Enable Asteroids shooting before adding periodic prizes.');
  const { powerUps: previous, ...arcade } = structuredClone(spec);
  if (!enabled && spec.version !== 5 && spec.version !== 6) return arcade;
  return {
    ...arcade, version: spec.version === 6 ? 6 : enabled ? 5 : spec.multiplayer ? 4 : 2,
    levels: getGameLevels(spec), progression: spec.progression ?? defaultProgression,
    ...(enabled ? { powerUps: previous ?? defaultPowerUps() } : {}),
  };
}

export function updatePowerUps(spec: GameSpec, patch: Partial<GamePowerUps>): ArcadeGameSpec {
  if ((spec.version !== 5 && spec.version !== 6) || !spec.powerUps) throw new Error('Enable periodic prizes before changing their settings.');
  const powerUps = { ...spec.powerUps, ...patch };
  if (!Number.isInteger(powerUps.spawnInterval) || powerUps.spawnInterval < 5 || powerUps.spawnInterval > 60 || !Number.isInteger(powerUps.duration) || powerUps.duration < 3 || powerUps.duration > 30) throw new Error('Choose a prize interval of 5–60 seconds and duration of 3–30 seconds.');
  if (!Array.isArray(powerUps.types) || !powerUps.types.length || powerUps.types.length > 4 || new Set(powerUps.types).size !== powerUps.types.length || powerUps.types.some(type => !defaultPowerUps().types.includes(type))) throw new Error('Choose one to four different supported prizes.');
  // Validate these controls without blocking other unfinished text in the form.
  return { ...spec, powerUps: { ...powerUps, types: [...powerUps.types] } };
}

export function setPowerUpType(spec: GameSpec, type: GamePowerUpType, enabled: boolean): ArcadeGameSpec {
  if ((spec.version !== 5 && spec.version !== 6) || !spec.powerUps) throw new Error('Enable periodic prizes before choosing them.');
  if (!defaultPowerUps().types.includes(type)) throw new Error('Choose a supported periodic prize.');
  const types = spec.powerUps.types.filter(item => item !== type);
  if (enabled) types.push(type);
  if (!types.length) throw new Error('Choose at least one periodic prize.');
  return updatePowerUps(spec, { types });
}

/** Changing the underlying game style can remove an incompatible prize mechanic. */
export function removeUnsupportedPowerUps(spec: ArcadeGameSpec): ArcadeGameSpec {
  return reconcileArcadeFormat(spec);
}
