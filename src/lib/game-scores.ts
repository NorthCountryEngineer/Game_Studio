import { coreRequest, isCore } from './core';
import { validateGameSpec } from './game-design';
import { leaderboardRanking, qualifiesLeaderboard, validateLeaderboardName, validateLeaderboardResult } from './game-leaderboard';
import type { Game, GameResult, GameSpec } from './game-types';
import type { MultiGameResult } from './multi-game-session';

export type GameScoreEntry = { name: string; points?: number; elapsed?: number; createdAt: string };
export type GameScoreBoard = { entries: GameScoreEntry[]; scope: 'shared' | 'browser'; publishedRevision: number; limit: 10; ranking: 'points' | 'time' | 'survival'; qualified?: boolean };
export type GameScoreReport = { requestId: string; name: string; result: GameResult | MultiGameResult };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Receipt = { id: string; report: string; qualified: boolean };
type StoredBoard = { gameId: string; publishedRevision: number; ranking: 'points' | 'time' | 'survival'; entries: GameScoreEntry[]; receipts: Receipt[] };
type State = { version: 2; boards: StoredBoard[] };
const storageKey = 'game-studio-game-scores:v2', legacyStorageKey = 'game-studio-game-scores:v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumBytes = 2_000_000, maximumBoards = 100, maximumReceipts = 500;
const maximumPoints = 2_147_483_647, maximumElapsed = 2_147_483_647;
const boardError = () => new Error('The leaderboard returned an invalid response. Reload the game and try again.');
function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function identifier(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
function revision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000_000; }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
/** Compatibility export; new submissions use the public eight-character nickname rules. */
export const validateArcadeName = validateLeaderboardName;
function publishedGame(game: Game): { spec: GameSpec; publishedRevision: number; ranking: 'points' | 'time' | 'survival' } {
  if (!game || !identifier(game.id) || game.status !== 'Published' || !revision(game.publishedRevision) || game.revision !== game.publishedRevision) throw new Error('Open the current published game before viewing or saving leaderboard results.');
  const spec = validateGameSpec(game.spec);
  return { spec, publishedRevision: game.publishedRevision, ranking: leaderboardRanking(spec) };
}
function cleanReport(game: Game, value: GameScoreReport): GameScoreReport {
  const { spec } = publishedGame(game);
  if (!fields(value, ['requestId', 'name', 'result']) || !identifier(value.requestId)) throw new Error('This result report is invalid. Finish a fresh round before saving it.');
  const result = validateLeaderboardResult(spec, value.result);
  if (!result) throw new Error('Finish a qualifying round before saving a leaderboard result.');
  return { requestId: value.requestId, name: validateLeaderboardName(value.name), result };
}
function storedName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Published legacy rows remain readable, but cannot grant longer new names.
  if (/^[A-Z0-9 _-]{1,16}$/.test(value) && value.trim() === value && !/  /.test(value)) return true;
  try { return validateLeaderboardName(value) === value; } catch { return false; }
}
function cleanEntries(value: unknown, ranking: 'points' | 'time' | 'survival', pointCeiling = maximumPoints): GameScoreEntry[] {
  if (!Array.isArray(value) || value.length > 10) throw boardError();
  let previous = ranking === 'time' ? -Infinity : Infinity;
  return value.map(item => {
    if (!fields(item, ['name', 'createdAt'], ['points', 'elapsed']) || !storedName(item.name) || !timestamp(item.createdAt)
      || item.points !== undefined && (typeof item.points !== 'number' || !Number.isSafeInteger(item.points) || item.points < 0 || item.points > pointCeiling)
      || item.elapsed !== undefined && (typeof item.elapsed !== 'number' || !Number.isFinite(item.elapsed) || item.elapsed <= 0 || item.elapsed > maximumElapsed)
      || ranking === 'points' && item.points === undefined || ranking !== 'points' && item.elapsed === undefined) throw boardError();
    const metric = (ranking === 'points' ? item.points : item.elapsed) as number;
    if (ranking === 'time' ? metric < previous : metric > previous) throw boardError();
    previous = metric;
    return { name: item.name, createdAt: item.createdAt, ...(item.points !== undefined ? { points: item.points as number } : {}), ...(item.elapsed !== undefined ? { elapsed: item.elapsed as number } : {}) };
  });
}
function sharedBoard(value: unknown, game: Game, submitted = false): GameScoreBoard {
  const current = publishedGame(game);
  if (!fields(value, ['entries', 'scope', 'publishedRevision', 'limit', 'ranking'], submitted ? ['qualified'] : []) || value.scope !== 'shared' || value.limit !== 10 || value.publishedRevision !== current.publishedRevision || value.ranking !== current.ranking || submitted && typeof value.qualified !== 'boolean') throw boardError();
  return { entries: cleanEntries(value.entries, current.ranking, maximumPoints), scope: 'shared', publishedRevision: current.publishedRevision, limit: 10, ranking: current.ranking, ...(submitted ? { qualified: value.qualified as boolean } : {}) };
}

/** Preview records are separate from identity and shared boards. V1 data is never rewritten. */
export class LocalGameScoreLibrary {
  constructor(private storage: StoragePort) {}
  private read(): State {
    const raw = this.storage.getItem(storageKey);
    if (!raw) return { version: 2, boards: [] };
    try {
      if (new TextEncoder().encode(raw).length > maximumBytes) throw new Error();
      const state: unknown = JSON.parse(raw);
      if (!fields(state, ['version', 'boards']) || state.version !== 2 || !Array.isArray(state.boards) || state.boards.length > maximumBoards) throw new Error();
      const boardIds = new Set<string>(), requestIds = new Set<string>();
      const boards = state.boards.map(value => {
        if (!fields(value, ['gameId', 'publishedRevision', 'ranking', 'entries', 'receipts']) || !identifier(value.gameId) || !revision(value.publishedRevision) || !['points', 'time', 'survival'].includes(value.ranking as string) || !Array.isArray(value.receipts) || value.receipts.length > maximumReceipts) throw new Error();
        const id = `${value.gameId}:${value.publishedRevision}`;
        if (boardIds.has(id)) throw new Error(); boardIds.add(id);
        const ranking = value.ranking as 'points' | 'time' | 'survival', entries = cleanEntries(value.entries, ranking);
        const receipts = value.receipts.map(receipt => {
          if (!fields(receipt, ['id', 'report', 'qualified']) || !identifier(receipt.id) || typeof receipt.report !== 'string' || receipt.report.length > 64_000 || typeof receipt.qualified !== 'boolean' || requestIds.has(receipt.id)) throw new Error();
          requestIds.add(receipt.id); return { id: receipt.id, report: receipt.report, qualified: receipt.qualified };
        });
        return { gameId: value.gameId, publishedRevision: value.publishedRevision, ranking, entries, receipts };
      });
      return { version: 2, boards };
    } catch { throw new Error('This browser’s saved leaderboard could not be read. Its existing data has not been changed.'); }
  }
  private legacy(game: Game): GameScoreEntry[] {
    const current = publishedGame(game);
    if (current.ranking !== 'points') return [];
    const raw = this.storage.getItem(legacyStorageKey);
    if (!raw) return [];
    try {
      if (new TextEncoder().encode(raw).length > maximumBytes) throw new Error();
      const state: unknown = JSON.parse(raw);
      if (!fields(state, ['version', 'boards']) || state.version !== 1 || !Array.isArray(state.boards) || state.boards.length > maximumBoards) throw new Error();
      const matching = state.boards.filter(value => fields(value, ['gameId', 'publishedRevision', 'entries', 'receipts']) && value.gameId === game.id && value.publishedRevision === current.publishedRevision);
      if (matching.length > 1) throw new Error();
      return matching.length ? cleanEntries(matching[0].entries, 'points', maximumPoints) : [];
    } catch { throw new Error('This browser’s saved high scores could not be read. Its existing data has not been changed.'); }
  }
  private output(board: StoredBoard | undefined, game: Game, qualified?: boolean): GameScoreBoard {
    const current = publishedGame(game);
    if (board && board.ranking !== current.ranking) throw boardError();
    return { entries: cleanEntries(board ? board.entries : this.legacy(game), current.ranking, maximumPoints), scope: 'browser', publishedRevision: current.publishedRevision, limit: 10, ranking: current.ranking, ...(qualified === undefined ? {} : { qualified }) };
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
      if (owner !== board || receipt.report !== body) throw new Error('This result request was already used for a different round or nickname.');
      return this.output(board, game, receipt.qualified);
    }
    if (!board) {
      if (state.boards.length >= maximumBoards) throw new Error('This browser’s leaderboard library is full. Its saved results have been preserved.');
      board = { gameId: game.id, publishedRevision: current.publishedRevision, ranking: current.ranking, entries: this.legacy(game), receipts: [] }; state.boards.push(board);
    }
    if (board.receipts.length >= maximumReceipts) throw new Error('This browser’s result history for this edition is full. Its saved results have been preserved.');
    const qualified = qualifiesLeaderboard(this.output(board, game), report.result);
    board.receipts.push({ id: report.requestId, report: body, qualified });
    if (qualified) {
      const entry = { name: report.name, elapsed: report.result.elapsed, ...(report.result.points === undefined ? {} : { points: report.result.points }), createdAt: new Date().toISOString() };
      board.entries = [...board.entries, entry].sort((a, b) => (current.ranking === 'points' ? b.points! - a.points! : current.ranking === 'survival' ? b.elapsed! - a.elapsed! : a.elapsed! - b.elapsed!) || a.createdAt.localeCompare(b.createdAt)).slice(0, 10);
    }
    const data = JSON.stringify(state);
    if (new TextEncoder().encode(data).length > maximumBytes) throw new Error('This browser’s leaderboard library is full. Its saved results have been preserved.');
    try { this.storage.setItem(storageKey, data); } catch { throw new Error('This browser could not save the result. Existing results have been preserved; try again.'); }
    return this.output(board, game, qualified);
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
  return sharedBoard(await coreRequest(`/game-scores/${encodeURIComponent(game.id)}`, 'POST', { publishedRevision, ...clean }, false), game, true);
}
