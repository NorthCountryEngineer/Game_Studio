import { isEndlessAsteroids, type ArcadeGameSpec, type GameSpec } from './game-types';
import { validateGameReview, type GameReview } from './game-review';

export type PrivatePlaytestReview = GameReview;

/** An explicit refresh changes instructions; opening the form never rewrites them. */
export function arcadeAuthoringInstructions(spec: ArcadeGameSpec): string {
  const endless = isEndlessAsteroids(spec);
  const parts = [spec.arcade?.rotation ? `A/D turn; W/S thrust/reverse${spec.arcade.shooting ? '; Space shoots' : ''}.` : spec.genre === 'platformer' ? 'Arrows/WASD move; Space jumps.' : `Arrows/WASD move${spec.arcade?.shooting ? '; Space shoots' : ''}.`];
  parts.push(endless ? `Survive. No timer/goal; difficulty rises every ${spec.asteroids!.difficultyInterval}s.` : `Collect ${spec.objects.collectible}s to finish each level.`);
  if (spec.arcade?.shooting) parts.push(spec.arcade.splitAsteroids ? spec.version === 6 && spec.asteroids?.sizes === 3 ? 'Rocks: large→medium→small; one shot per stage.' : 'Rocks: large→small; one shot per stage.' : 'Shoot rocks to destroy them.');
  if (spec.version === 6 && spec.asteroids?.enemies.enabled) parts.push(spec.asteroids.enemies.difficulty === 'hard' ? 'Enemy ships chase, aim and fire.' : spec.asteroids.enemies.difficulty === 'medium' ? 'Enemy ships track your ship.' : 'Enemy ships wander.');
  if (spec.powerUps) parts.push(endless ? 'Shoot or collect boosts until hit. Any hit clears all; shield blocks one hit.' : `Shoot or collect boosts: ${spec.powerUps.duration}s; shield blocks one hit.`);
  if (spec.arcade?.scoring) parts.push('Earn points.');
  parts.push('Touch controls below.');
  return parts.join(' ');
}

/** Private review is separate from a terminal result and can never become a score. */
export function acceptEndlessPlaytestReview(spec: GameSpec, review: PrivatePlaytestReview): string[] {
  return validateGameReview(review, spec)?.reviewedLevelIds ?? [];
}
