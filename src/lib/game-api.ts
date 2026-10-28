import { coreRequest, isCore } from './core';
import { LocalGameLibrary, validateGameConfig } from './game-local';
import { validateGameSpec } from './game-design';
import type { Game, GameConfig, GameSettings, GameSpec } from './game-types';
import { validateCrosswordSuggestionRequest, validateCrosswordSuggestionResponse, type CrosswordSuggestionResponse } from './crossword-suggestions';

function local(): LocalGameLibrary {
  if (import.meta.env.VITE_APP_MODE === 'cloud') throw new Error('The game studio requires the NCE Core API deployment. Games are unavailable in the legacy backend.');
  return new LocalGameLibrary(localStorage);
}
export async function getGameSettings(): Promise<GameSettings> { return isCore ? coreRequest('/games/settings') : local().settings(); }
export async function saveGameSettings(config: GameConfig, expectedRevision: number): Promise<GameSettings> {
  const clean = validateGameConfig(config);
  return isCore ? coreRequest('/games/settings', 'PUT', { config: clean, expectedRevision }) : local().saveSettings(clean, expectedRevision);
}
export async function listGames(published = false): Promise<Game[]> {
  if (!isCore) return local().list(published);
  const games: Game[] = [], seen = new Set<string>(); let cursor: string | undefined;
  do {
    const query = new URLSearchParams();
    if (published) query.set('specVersion', 'all');
    if (cursor) query.set('cursor', cursor);
    const page: { games: Game[]; cursor?: string } = await coreRequest(`/games${published ? '/published' : ''}${query.size ? `?${query}` : ''}`, 'GET', undefined, !published);
    games.push(...page.games); cursor = page.cursor;
    if (cursor && seen.has(cursor)) throw new Error('The game library returned a repeated page. Reload and try again.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return games;
}
export async function getGame(id: string, published = false): Promise<Game> { return isCore ? coreRequest(`/games/${published ? 'published/' : ''}${encodeURIComponent(id)}`, 'GET', undefined, !published) : local().get(id, published); }
export async function createGame(id: string, prompt: string): Promise<Game> { return isCore ? coreRequest('/games', 'POST', { id, prompt }) : local().create(id, prompt); }
export async function saveGame(game: Game, spec: GameSpec): Promise<Game> { const clean = validateGameSpec(spec); return isCore ? coreRequest(`/games/${encodeURIComponent(game.id)}`, 'PUT', { revision: game.revision, spec: clean }) : local().save(game.id, game.revision, clean); }
export async function sendGameMessage(game: Game, requestId: string, message: string): Promise<Game> { return isCore ? coreRequest(`/games/${encodeURIComponent(game.id)}/message`, 'POST', { revision: game.revision, requestId, message }) : local().message(game.id, game.revision, requestId, message); }
export async function generateCrosswordSuggestions(game: Game, requestId: string, path: string[], title: string, description: string): Promise<CrosswordSuggestionResponse> {
  const context = { game: structuredClone(game), requestId, path: [...path], title, description };
  validateCrosswordSuggestionRequest(context);
  if (!isCore) throw new Error('AI crossword suggestions require the connected site and an administrator-configured model. Local preview makes no model calls.');
  const response = await coreRequest<unknown>(`/games/${encodeURIComponent(context.game.id)}/crossword-suggestions`, 'POST', { revision: context.game.revision, requestId, path: context.path, title, description });
  return validateCrosswordSuggestionResponse(response, context);
}
export async function markGameTested(game: Game, reviewedLevelIds?: string[]): Promise<Game> { return isCore ? coreRequest(`/games/${encodeURIComponent(game.id)}/test`, 'POST', { revision: game.revision, ...(reviewedLevelIds ? { reviewedLevelIds } : {}) }) : local().test(game.id, game.revision, reviewedLevelIds); }
export async function publishGame(game: Game): Promise<Game> { return isCore ? coreRequest(`/games/${encodeURIComponent(game.id)}/publish`, 'POST', { revision: game.revision }) : local().publish(game.id, game.revision); }
export async function unpublishGame(game: Game): Promise<Game> { return isCore ? coreRequest(`/games/${encodeURIComponent(game.id)}/unpublish`, 'POST', { revision: game.revision }) : local().unpublish(game.id, game.revision); }
export async function duplicateGame(game: Game, id = crypto.randomUUID()): Promise<Game> { return isCore ? coreRequest(`/games/${encodeURIComponent(game.id)}/duplicate`, 'POST', { revision: game.revision, id }) : local().duplicate(game.id, game.revision, id); }
export async function deleteGame(game: Game): Promise<void> { if (isCore) { await coreRequest(`/games/${encodeURIComponent(game.id)}`, 'DELETE', { revision: game.revision }); return; } local().delete(game.id, game.revision); }
