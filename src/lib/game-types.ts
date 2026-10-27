export type GameRules = { goal: number; timeLimit: number; lives: number; difficulty: number };
export type GameArcadeOptions = { rotation: boolean; shooting: boolean; splitAsteroids: boolean; scoring: boolean; highScores: boolean };
export type GamePowerUpType = 'triple-shot' | 'rapid-fire' | 'shield' | 'speed-boost';
export type GamePowerUps = { spawnInterval: number; duration: number; types: GamePowerUpType[] };
export type GameAsteroidEnemies = { enabled: boolean; difficulty: 'easy' | 'medium' | 'hard'; hitPoints: number; spawnInterval: number; maxShips: number };
export type GameAsteroidSettings = { endless: boolean; difficultyInterval: number; sizes: 2 | 3; enemies: GameAsteroidEnemies };
export type GameLevel = {
  id: string;
  title: string;
  brief: string;
  theme: 'pond' | 'space' | 'garden';
  rules: GameRules;
  seed: number;
};
export type ArcadeGameSpec = {
  version: 1 | 2 | 4 | 5 | 6;
  title: string;
  description: string;
  genre: 'collect' | 'dodge' | 'platformer';
  theme: 'pond' | 'space' | 'garden';
  player: { name: string; color: string; speed: number; jump: number };
  rules: GameRules;
  objects: { collectible: string; hazard: string };
  instructions: string;
  arcade?: GameArcadeOptions;
  progression?: string;
  levels?: GameLevel[];
  multiplayer?: { mode: 'cooperative'; maxPlayers: 2 };
  powerUps?: GamePowerUps;
  asteroids?: GameAsteroidSettings;
};

export type CooperativeGameSpec = ArcadeGameSpec & { version: 4 | 5 | 6; progression: string; levels: GameLevel[]; multiplayer: { mode: 'cooperative'; maxPlayers: 2 } };
export function isCooperativeGameSpec(spec: GameSpec): spec is CooperativeGameSpec { return spec.version === 4 || (spec.version === 5 || spec.version === 6) && !!spec.multiplayer; }

export type WordGenre = 'crossword' | 'word-search' | 'mad-libs';
type WordBase = { version: 3; title: string; description: string; instructions: string };
export type CrosswordEntry = { answer: string; clue: string };
export type CrosswordSpec = WordBase & { genre: 'crossword'; puzzle: { seed: number; entries: CrosswordEntry[] } };
export type WordSearchSpec = WordBase & { genre: 'word-search'; puzzle: { seed: number; size: number; allowBackwards: boolean; words: string[] } };
export type MadLibBlank = { id: string; label: string };
export type MadLibsSpec = WordBase & { genre: 'mad-libs'; puzzle: { template: string; blanks: MadLibBlank[] } };
export type WordGameSpec = CrosswordSpec | WordSearchSpec | MadLibsSpec;
export type GameSpec = ArcadeGameSpec | WordGameSpec;
export function isWordGameSpec(spec: GameSpec): spec is WordGameSpec { return spec.version === 3; }
export function isEndlessAsteroids(spec: GameSpec): boolean { return spec.version === 6 && !!spec.asteroids?.endless; }
export function gameReviewLevelIds(spec: GameSpec): string[] { return spec.version === 3 || spec.version === 1 ? ['level-1'] : (isEndlessAsteroids(spec) ? (spec.levels || []).slice(0, 1) : spec.levels || []).map(level => level.id); }

export type GameMessage = { id: string; role: 'user' | 'assistant'; text: string };
export type Game = {
  id: string;
  spec: GameSpec;
  revision: number;
  status: 'Draft' | 'Published';
  messages?: GameMessage[];
  testedRevision?: number;
  publishedRevision?: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  operationState?: 'pending' | 'uncertain';
  operationError?: string;
};
export type GameConfig = { version: 1; revision: number; creationEnabled: boolean; assistantModeId: string };
export type GameSettings = { config: GameConfig; canCreate: boolean; canPublish: boolean; canManage: boolean; canAdminContent: boolean };
export type GameResult = { outcome: 'level-complete' | 'won' | 'lost'; elapsed: number; score: number; points?: number; reviewedLevelIds: string[] };
