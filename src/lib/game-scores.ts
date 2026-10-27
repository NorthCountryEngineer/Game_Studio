import { coreRequest, isCore } from './core';
import { validateGameSpec } from './game-design';
import { createGameEngine, validateGameResult } from './game-runtime';
import type { ArcadeGameSpec, Game, GameResult } from './game-types';

export type GameScoreEntry = { name: string; points: number; createdAt: string };
export type GameScoreBoard = { entries: GameScoreEntry[]; scope: 'shared' | 'browser'; publishedRevision: number; limit: 10 };
export type GameScoreReport = { requestId: string; name: string; result: GameResult };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Receipt = { id: string; report: string };
type StoredBoard = { gameId: string; publishedRevision: number; entries: GameScoreEntry[]; receipts: Receipt[] };
type State = { version: 1; boards: StoredBoard[] };
const storageKey = 'game-studio-game-scores:v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumBytes = 2_000_000, maximumBoards = 100, maximumReceipts = 500;
const boardError = () => new Error('The high-score board returned an invalid response. Reload the game and try again.');
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','));
}
function identifier(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
function revision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000_000; }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
export function validateArcadeName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9 _-]{1,16}$/.test(value)) throw new Error('Choose an arcade name with 1–16 letters, numbers, spaces, underscores, or hyphens.');
  const name = value.trim().replace(/ +/g, ' ').toUpperCase();
  if (!name) throw new Error('Choose an arcade name with 1–16 letters, numbers, spaces, underscores, or hyphens.');
  return name;
}
function publishedGame(game: Game): { spec: ArcadeGameSpec; publishedRevision: number; maximumPoints: number } {
  if (!game || !identifier(game.id) || game.status !== 'Published' || !revision(game.publishedRevision) || game.revision !== game.publishedRevision) throw new Error('Open the current published game before viewing or saving high scores.');
  const spec = validateGameSpec(game.spec);
  if (spec.version === 3 || spec.version === 4 || !spec.arcade?.scoring || !spec.arcade.highScores) throw new Error('High scores are disabled for this game.');
  return { spec, publishedRevision: game.publishedRevision, maximumPoints: createGameEngine().maxPoints(spec) };
}
function cleanReport(game: Game, value: GameScoreReport): GameScoreReport {
  const { spec } = publishedGame(game);
  if (!exact(value, ['requestId', 'name', 'result']) || !identifier(value.requestId) || !exact(value.result, ['outcome', 'elapsed', 'score', 'reviewedLevelIds', 'points'])) throw new Error('This score report is invalid. Finish a fresh round before saving your score.');
  const result = validateGameResult(value.result, spec);
  if (!result || result.outcome === 'level-complete' || !result.points || result.points <= 0 || result.elapsed <= 0) throw new Error('Finish a round with a positive point score before saving it.');
  const played = createGameEngine().getLevels(spec).slice(0, result.reviewedLevelIds.length);
  if (result.score < played.slice(0, -1).reduce((total, level) => total + level.rules.goal, 0)) throw new Error('Complete previous levels before saving this round’s score.');
  return { requestId: value.requestId.toLowerCase(), name: validateArcadeName(value.name), result };
}
function cleanEntries(value: unknown, maximumPoints: number, uniqueNames: boolean): GameScoreEntry[] {
  if (!Array.isArray(value) || value.length > 10) throw boardError();
  const names = new Set<string>();
  let previousPoints = Infinity;
  return value.map(item => {
    if (!exact(item, ['name', 'points', 'createdAt']) || typeof item.name !== 'string' || validateArcadeName(item.name) !== item.name || typeof item.points !== 'number' || !Number.isSafeInteger(item.points) || item.points <= 0 || item.points > maximumPoints || item.points > previousPoints || !timestamp(item.createdAt) || uniqueNames && names.has(item.name)) throw boardError();
    previousPoints = item.points; names.add(item.name);
    return { name: item.name, points: item.points, createdAt: item.createdAt };
  });
}
function sharedBoard(value: unknown, game: Game): GameScoreBoard {
  const current = publishedGame(game);
  if (!exact(value, ['entries', 'scope', 'publishedRevision', 'limit']) || value.scope !== 'shared' || value.limit !== 10 || value.publishedRevision !== current.publishedRevision) throw boardError();
  return { entries: cleanEntries(value.entries, current.maximumPoints, false), scope: 'shared', publishedRevision: current.publishedRevision, limit: 10 };
}

/** Local arcade records stay separate from games, posts, identity, and shared scores. */
export class LocalGameScoreLibrary {
  constructor(private storage: StoragePort) {}
  private read(): State {
    const raw = this.storage.getItem(storageKey);
    if (!raw) return { version: 1, boards: [] };
    try {
      if (raw.length > maximumBytes) throw new Error();
      const state: unknown = JSON.parse(raw);
      if (!exact(state, ['version', 'boards']) || state.version !== 1 || !Array.isArray(state.boards) || state.boards.length > maximumBoards) throw new Error();
      const boardIds = new Set<string>(), requestIds = new Set<string>();
      const boards = state.boards.map(value => {
        if (!exact(value, ['gameId', 'publishedRevision', 'entries', 'receipts']) || !identifier(value.gameId) || !revision(value.publishedRevision) || !Array.isArray(value.receipts) || value.receipts.length > maximumReceipts) throw new Error();
        const id = `${value.gameId}:${value.publishedRevision}`;
        if (boardIds.has(id)) throw new Error(); boardIds.add(id);
        const entries = cleanEntries(value.entries, Number.MAX_SAFE_INTEGER, true);
        const receipts = value.receipts.map(receipt => {
          if (!exact(receipt, ['id', 'report']) || !identifier(receipt.id) || typeof receipt.report !== 'string' || receipt.report.length > 4_000 || requestIds.has(receipt.id)) throw new Error();
          requestIds.add(receipt.id); return { id: receipt.id, report: receipt.report };
        });
        return { gameId: value.gameId, publishedRevision: value.publishedRevision, entries, receipts };
      });
      return { version: 1, boards };
    } catch { throw new Error('This browser’s saved high scores could not be read. Its existing data has not been changed.'); }
  }
  private output(board: StoredBoard | undefined, game: Game): GameScoreBoard {
    const current = publishedGame(game);
    return { entries: cleanEntries(board?.entries ?? [], current.maximumPoints, true), scope: 'browser', publishedRevision: current.publishedRevision, limit: 10 };
  }
  get(game: Game): GameScoreBoard {
    const current = publishedGame(game), state = this.read();
    return this.output(state.boards.find(item => item.gameId === game.id && item.publishedRevision === current.publishedRevision), game);
  }
  save(game: Game, value: GameScoreReport): GameScoreBoard {
    const current = publishedGame(game), report = cleanReport(game, value), state = this.read();
    let board = state.boards.find(item => item.gameId === game.id && item.publishedRevision === current.publishedRevision);
    const body = JSON.stringify({ gameId: game.id, publishedRevision: current.publishedRevision, name: report.name, result: report.result });
    const owner = state.boards.find(item => item.receipts.some(receipt => receipt.id === report.requestId));
    const receipt = owner?.receipts.find(item => item.id === report.requestId);
    if (receipt) {
      if (owner !== board || receipt.report !== body) throw new Error('This score request was already used for a different round or arcade name.');
      return this.output(board, game);
    }
    if (!board) {
      if (state.boards.length >= maximumBoards) throw new Error('This browser’s high-score library is full. Its saved scores have been preserved.');
      board = { gameId: game.id, publishedRevision: current.publishedRevision, entries: [], receipts: [] }; state.boards.push(board);
    }
    if (board.receipts.length >= maximumReceipts) throw new Error('This browser’s score history for this edition is full. Its saved scores have been preserved.');
    this.output(board, game);
    board.receipts.push({ id: report.requestId, report: body });
    const previous = board.entries.find(entry => entry.name === report.name);
    if (!previous || report.result.points! > previous.points) {
      board.entries = [...board.entries.filter(entry => entry.name !== report.name), { name: report.name, points: report.result.points!, createdAt: new Date().toISOString() }]
        .sort((a, b) => b.points - a.points || a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name)).slice(0, 10);
    }
    const data = JSON.stringify(state);
    if (new TextEncoder().encode(data).length > maximumBytes) throw new Error('This browser’s high-score library is full. Its saved scores have been preserved.');
    try { this.storage.setItem(storageKey, data); } catch { throw new Error('This browser could not save the score. Existing scores have been preserved; try again.'); }
    return this.output(board, game);
  }
}

export function getLocalGameScores(game: Game): GameScoreBoard { return new LocalGameScoreLibrary(localStorage).get(game); }
export function saveLocalGameScore(game: Game, report: GameScoreReport): GameScoreBoard { return new LocalGameScoreLibrary(localStorage).save(game, report); }
export async function getGameScores(game: Game): Promise<GameScoreBoard> {
  const { publishedRevision } = publishedGame(game);
  if (!isCore) return getLocalGameScores(game);
  return sharedBoard(await coreRequest(`/game-scores/${encodeURIComponent(game.id)}?revision=${publishedRevision}`, 'GET', undefined, false), game);
}
export async function submitGameScore(game: Game, report: GameScoreReport): Promise<GameScoreBoard> {
  const { publishedRevision } = publishedGame(game), clean = cleanReport(game, report);
  if (!isCore) return saveLocalGameScore(game, clean);
  return sharedBoard(await coreRequest(`/game-scores/${encodeURIComponent(game.id)}`, 'POST', { publishedRevision, ...clean }), game);
}
