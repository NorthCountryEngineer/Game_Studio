import { validateGameSpec } from './game-design';
import { wordSearchSuggestionTarget, type WordSearchSuggestionContext } from './word-search-suggestions';
import type { Game } from './game-types';

/** Preserve the original request after a lost reply; metadata recovery is not a new paid request. */
export class WordSearchGenerationRequest {
  private pending?: { key: string; value: WordSearchSuggestionContext };
  get(game: Game, path: string[]): WordSearchSuggestionContext {
    const target = wordSearchSuggestionTarget(game, path);
    const key = JSON.stringify({ gameId: game.id, spec: validateGameSpec(game.spec), path });
    if (this.pending?.key === key) return structuredClone(this.pending.value);
    const value = { game: structuredClone(game), requestId: crypto.randomUUID(), path: [...path], title: target.title, description: target.description };
    this.pending = { key, value };
    return structuredClone(value);
  }
  clear(): void { this.pending = undefined; }
}
