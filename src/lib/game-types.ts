export type GameSpriteRole = 'player' | 'asteroid' | 'reward' | 'enemy';
export type GameSprite = { width: number; height: number; pixels: string };
export type GameSprites = Partial<Record<GameSpriteRole, GameSprite>>;
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
export type GameFlowNode =
  | { id: string; type: 'level'; levelId: string }
  | { id: string; type: 'material'; title: string; kind: 'lesson' | 'video' | 'exercise'; reference: string; required: boolean }
  | { id: string; type: 'menu'; title: string };
export type GameFlow = { version: 1; nodes: GameFlowNode[] };
export type ArcadeGameSpec = {
  version: 1 | 2 | 4 | 5 | 6 | 7;
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
  sprites?: GameSprites;
  flow?: GameFlow;
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
export type SingleGameSpec = ArcadeGameSpec | WordGameSpec;
export type MultiGameStep =
  | { id: string; type: 'game'; spec: SingleGameSpec }
  | { id: string; type: 'material'; title: string; kind: 'content' | 'video' | 'interactive'; reference: string; required: boolean }
  | { id: string; type: 'free-play'; spec: ArcadeGameSpec };
export type MultiGameSpec = { version: 8; genre: 'multi-game'; title: string; description: string; instructions: string; steps: MultiGameStep[] };
export type GameSpec = SingleGameSpec | MultiGameSpec;
export function isWordGameSpec(spec: GameSpec): spec is WordGameSpec { return spec.version === 3; }
export function isMultiGameSpec(spec: GameSpec): spec is MultiGameSpec { return spec.version === 8; }
export function isArcadeGameSpec(spec: GameSpec): spec is ArcadeGameSpec { return spec.version !== 3 && spec.version !== 8; }
export function isEndlessAsteroids(spec: GameSpec): boolean { return spec.version === 6 && !!spec.asteroids?.endless; }
export function gameReviewLevelIds(spec: GameSpec): string[] { return spec.version === 8 ? spec.steps.map(step => step.id) : spec.version === 3 || spec.version === 1 ? ['level-1'] : (isEndlessAsteroids(spec) ? (spec.levels || []).slice(0, 1) : spec.levels || []).map(level => level.id); }

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
