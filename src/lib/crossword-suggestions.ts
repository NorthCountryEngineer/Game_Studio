import { validateGameSpec } from './game-design';
import type { CrosswordEntry, CrosswordSpec, CrosswordSuggestionProposal, CrosswordSuggestionResponse, Game } from './game-types';
import { createWordGameEngine } from './word-game-engine';

export type { CrosswordSuggestionProposal, CrosswordSuggestionResponse } from './game-types';
export type CrosswordSuggestionContext = { game: Game; requestId: string; path: string[]; title: string; description: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const messageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-(?:idea|reply))?$/iu;
const engine = createWordGameEngine();
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Crossword suggestions have missing or unexpected fields.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value !== value.trim() || value.length > max || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f<>]|(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:javascript|data|vbscript|mailto|file|tel)\s*:)|\b(?:eval|fetch|import)\s*\(/iu.test(value)) throw new Error('Crossword suggestions must contain bounded plain text without links or code.');
  return value;
}
function path(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1 || value.some(id => typeof id !== 'string' || !/^step-(?:[1-9]|1[0-2])$/u.test(id))) throw new Error('Choose a crossword or one crossword step in a multi-game journey.');
  return [...value];
}
/** Candidate vocabulary stays separate from the saved and published game. */
export function validateCrosswordSuggestionEntries(value: unknown): CrosswordEntry[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 16) throw new Error('Choose 3 to 16 crossword entries.');
  const entries = value.map(input => {
    const entry = record(input, ['answer', 'clue']);
    if (typeof entry.answer !== 'string' || !/^[A-Z]{2,18}$/u.test(entry.answer)) throw new Error('Crossword answers must use 2 to 18 uppercase ASCII letters.');
    return { answer: entry.answer, clue: text(entry.clue, 140) };
  });
  if (new Set(entries.map(entry => entry.answer)).size !== entries.length) throw new Error('Crossword answers must be unique.');
  if (entries.reduce((sum, entry) => sum + entry.answer.length, 0) > 200) throw new Error('Crossword answers must total at most 200 letters.');
  return entries;
}
export function validateCrosswordSuggestionProposal(value: unknown): CrosswordSuggestionProposal {
  const proposal = record(value, ['requestId', 'path', 'title', 'description', 'entries']);
  if (typeof proposal.requestId !== 'string' || !uuid.test(proposal.requestId)) throw new Error('The crossword suggestion request identifier is invalid.');
  return { requestId: proposal.requestId, path: path(proposal.path), title: text(proposal.title, 80), description: text(proposal.description, 300, true), entries: validateCrosswordSuggestionEntries(proposal.entries) };
}
export function crosswordSuggestionTarget(game: Game, targetPath: string[]): CrosswordSpec {
  const cleanPath = path(targetPath), spec = validateGameSpec(game.spec);
  const target = cleanPath.length === 0 ? spec : spec.version === 8 ? spec.steps.find(step => step.id === cleanPath[0] && step.type === 'game') : undefined;
  const candidate = target && 'spec' in target ? target.spec : target;
  if (!candidate || !('version' in candidate) || candidate.version !== 3 || candidate.genre !== 'crossword') throw new Error('Choose a crossword or one crossword step in a multi-game journey.');
  return candidate;
}
export function validateCrosswordSuggestionRequest(context: CrosswordSuggestionContext): void {
  if (typeof context.game.id !== 'string' || !uuid.test(context.game.id) || !Number.isSafeInteger(context.game.revision) || context.game.revision < 0 || typeof context.requestId !== 'string' || !uuid.test(context.requestId)) throw new Error('Reload the saved game before requesting crossword suggestions.');
  const target = crosswordSuggestionTarget(context.game, context.path);
  if (text(context.title, 80) !== target.title || text(context.description, 300, true) !== target.description) throw new Error('Save the crossword title and description before generating suggestions.');
}
/** Existing deterministic layout validation must accept every selected answer. */
export function applyCrosswordSuggestions(spec: CrosswordSpec, entries: unknown): CrosswordSpec {
  const selected = validateCrosswordSuggestionEntries(entries);
  const clean = engine.validate({ ...spec, puzzle: { seed: spec.puzzle.seed, entries: selected } });
  if (clean.genre !== 'crossword') throw new Error('Choose a crossword before applying suggestions.');
  return clean;
}
function canonical(value: unknown): string {
  if (value && typeof value === 'object') return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Bind a model proposal to the exact saved draft, target and user request. */
export function validateCrosswordSuggestionResponse(value: unknown, context: CrosswordSuggestionContext): CrosswordSuggestionResponse {
  validateCrosswordSuggestionRequest(context);
  const response = record(value, ['game', 'proposal']);
  const game = record(response.game, ['id', 'spec', 'revision', 'status', 'createdAt', 'updatedAt'], ['messages', 'testedRevision', 'publishedRevision', 'publishedAt', 'operationState', 'operationError']);
  const spec = validateGameSpec(game.spec), proposal = validateCrosswordSuggestionProposal(response.proposal);
  if (game.id !== context.game.id || !Number.isSafeInteger(game.revision) || (game.revision as number) < context.game.revision + 2 || canonical(spec) !== canonical(validateGameSpec(context.game.spec)) || proposal.requestId !== context.requestId || canonical(proposal.path) !== canonical(context.path) || proposal.title !== context.title || proposal.description !== context.description) throw new Error('These crossword suggestions belong to a different or changed draft. Reload before trying again.');
  if (!['Draft', 'Published'].includes(game.status as string) || typeof game.createdAt !== 'string' || typeof game.updatedAt !== 'string' || !Number.isFinite(Date.parse(game.createdAt)) || !Number.isFinite(Date.parse(game.updatedAt)) || game.createdAt !== context.game.createdAt) throw new Error('The crossword suggestion service returned an invalid game.');
  for (const key of ['testedRevision', 'publishedRevision']) if (Object.hasOwn(game, key) && (!Number.isSafeInteger(game[key]) || (game[key] as number) < 0 || (game[key] as number) > (game.revision as number))) throw new Error('The crossword suggestion service returned invalid review metadata.');
  if (Object.hasOwn(game, 'publishedAt') && (typeof game.publishedAt !== 'string' || !Number.isFinite(Date.parse(game.publishedAt)))) throw new Error('The crossword suggestion service returned invalid publication metadata.');
  if (Object.hasOwn(game, 'operationState') && !['pending', 'uncertain'].includes(game.operationState as string) || Object.hasOwn(game, 'operationError') && (typeof game.operationError !== 'string' || game.operationError.length > 2000)) throw new Error('The crossword suggestion service returned invalid operation metadata.');
  if (Object.hasOwn(game, 'messages')) {
    if (!Array.isArray(game.messages) || game.messages.length > 200) throw new Error('The crossword suggestion service returned invalid conversation metadata.');
    for (const input of game.messages) { const message = record(input, ['id', 'role', 'text']); if (typeof message.id !== 'string' || !messageId.test(message.id) || !['user', 'assistant'].includes(message.role as string) || typeof message.text !== 'string' || message.text.length > 20000) throw new Error('The crossword suggestion service returned invalid conversation metadata.'); }
  }
  applyCrosswordSuggestions(crosswordSuggestionTarget(context.game, context.path), proposal.entries);
  return { game: { ...structuredClone(game), spec } as Game, proposal };
}
