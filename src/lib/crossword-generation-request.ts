import { validateGameSpec } from './game-design';
import { crosswordSuggestionTarget, type CrosswordSuggestionContext } from './crossword-suggestions';
import type { Game } from './game-types';

/** Keep the original request body when only billing metadata changed after a lost reply. */
export class CrosswordGenerationRequest {
  private pending?: { key: string; value: CrosswordSuggestionContext };
  get(game: Game, path: string[]): CrosswordSuggestionContext {
    const target = crosswordSuggestionTarget(game, path);
    const key = JSON.stringify({ gameId: game.id, spec: validateGameSpec(game.spec), path });
    if (this.pending?.key === key) return structuredClone(this.pending.value);
    const value = { game: structuredClone(game), requestId: crypto.randomUUID(), path: [...path], title: target.title, description: target.description };
    this.pending = { key, value };
    return structuredClone(value);
  }
  clear(): void { this.pending = undefined; }
}
