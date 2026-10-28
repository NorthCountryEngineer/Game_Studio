import { validateGameSpec } from './game-design';
import type { WordSearchSpec, WordSearchSuggestionProposal, WordSearchSuggestionResponse, Game } from './game-types';
import { createWordGameEngine } from './word-game-engine';

export type { WordSearchSuggestionProposal, WordSearchSuggestionResponse } from './game-types';
export type WordSearchSuggestionContext = { game: Game; requestId: string; path: string[]; title: string; description: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const messageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-(?:idea|reply))?$/iu;
const engine = createWordGameEngine();
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Word-search suggestions have missing or unexpected fields.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value !== value.trim() || value.length > max || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f<>]|(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:javascript|data|vbscript|mailto|file|tel)\s*:)|\b(?:eval|fetch|import)\s*\(/iu.test(value)) throw new Error('Word-search suggestions must contain bounded plain text without links or code.');
  return value;
}
function path(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1 || [...value].some(id => typeof id !== 'string' || !/^step-(?:[1-9]|1[0-2])$/u.test(id))) throw new Error('Choose a word search or one word-search step in a multi-game journey.');
  return [...value];
}
/** Only validated, fitted model options cross the private API boundary. */
export function validateWordSearchSuggestionWords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 16) throw new Error('Choose 3 to 16 word-search words.');
  const words: string[] = [];
  for (const word of value) {
    if (typeof word !== 'string' || !/^[A-Z]{2,18}$/u.test(word)) throw new Error('Word-search words must use 2 to 18 uppercase ASCII letters.');
    words.push(word);
  }
  if (new Set(words).size !== words.length) throw new Error('Word-search words must be unique.');
  if (words.reduce((sum, word) => sum + word.length, 0) > 240) throw new Error('Suggested word-search words must total at most 240 letters.');
  return words;
}
export function validateWordSearchSuggestionProposal(value: unknown): WordSearchSuggestionProposal {
  const proposal = record(value, ['requestId', 'path', 'title', 'description', 'words']);
  if (typeof proposal.requestId !== 'string' || !uuid.test(proposal.requestId)) throw new Error('The word-search suggestion request identifier is invalid.');
  return { requestId: proposal.requestId, path: path(proposal.path), title: text(proposal.title, 80), description: text(proposal.description, 300, true), words: validateWordSearchSuggestionWords(proposal.words) };
}
export function wordSearchSuggestionTarget(game: Game, targetPath: string[]): WordSearchSpec {
  const cleanPath = path(targetPath), spec = validateGameSpec(game.spec);
  const target = cleanPath.length === 0 ? spec : spec.version === 8 ? spec.steps.find(step => step.id === cleanPath[0] && step.type === 'game') : undefined;
  const candidate = target && 'spec' in target ? target.spec : target;
  if (!candidate || !('version' in candidate) || candidate.version !== 3 || candidate.genre !== 'word-search') throw new Error('Choose a word search or one word-search step in a multi-game journey.');
  return candidate;
}
export function validateWordSearchSuggestionRequest(context: WordSearchSuggestionContext): void {
  if (typeof context.game.id !== 'string' || !uuid.test(context.game.id) || !Number.isSafeInteger(context.game.revision) || context.game.revision < 0 || typeof context.requestId !== 'string' || !uuid.test(context.requestId)) throw new Error('Reload the saved game before requesting word-search suggestions.');
  const target = wordSearchSuggestionTarget(context.game, context.path);
  if (text(context.title, 80) !== target.title || text(context.description, 300, true) !== target.description) throw new Error('Save the word-search title and description before generating suggestions.');
}
/** Selection keeps the saved seed, grid size, directions and authored metadata. */
export function applyWordSearchSuggestions(spec: WordSearchSpec, words: unknown): WordSearchSpec {
  const selected = validateWordSearchSuggestionWords(words);
  const clean = engine.validate({ ...spec, puzzle: { ...spec.puzzle, words: selected } });
  if (clean.genre !== 'word-search') throw new Error('Choose a word search before applying suggestions.');
  return clean;
}
function canonical(value: unknown): string {
  if (value && typeof value === 'object') return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Bind proposals to the saved parent, child target and original billable request. */
export function validateWordSearchSuggestionResponse(value: unknown, context: WordSearchSuggestionContext): WordSearchSuggestionResponse {
  validateWordSearchSuggestionRequest(context);
  const response = record(value, ['game', 'proposal']);
  const game = record(response.game, ['id', 'spec', 'revision', 'status', 'createdAt', 'updatedAt'], ['messages', 'testedRevision', 'publishedRevision', 'publishedAt', 'operationState', 'operationError']);
  const spec = validateGameSpec(game.spec), proposal = validateWordSearchSuggestionProposal(response.proposal);
  if (game.id !== context.game.id || !Number.isSafeInteger(game.revision) || (game.revision as number) < context.game.revision + 2 || canonical(spec) !== canonical(validateGameSpec(context.game.spec)) || proposal.requestId !== context.requestId || canonical(proposal.path) !== canonical(context.path) || proposal.title !== context.title || proposal.description !== context.description) throw new Error('These word-search suggestions belong to a different or changed draft. Reload before trying again.');
  if (!['Draft', 'Published'].includes(game.status as string) || typeof game.createdAt !== 'string' || typeof game.updatedAt !== 'string' || !Number.isFinite(Date.parse(game.createdAt)) || !Number.isFinite(Date.parse(game.updatedAt)) || game.createdAt !== context.game.createdAt) throw new Error('The word-search suggestion service returned an invalid game.');
  for (const key of ['testedRevision', 'publishedRevision']) if (Object.hasOwn(game, key) && (!Number.isSafeInteger(game[key]) || (game[key] as number) < 0 || (game[key] as number) > (game.revision as number))) throw new Error('The word-search suggestion service returned invalid review metadata.');
  if (Object.hasOwn(game, 'publishedAt') && (typeof game.publishedAt !== 'string' || !Number.isFinite(Date.parse(game.publishedAt)))) throw new Error('The word-search suggestion service returned invalid publication metadata.');
  if (Object.hasOwn(game, 'operationState') && !['pending', 'uncertain'].includes(game.operationState as string) || Object.hasOwn(game, 'operationError') && (typeof game.operationError !== 'string' || game.operationError.length > 2000)) throw new Error('The word-search suggestion service returned invalid operation metadata.');
  if (Object.hasOwn(game, 'messages')) {
    if (!Array.isArray(game.messages) || game.messages.length > 200) throw new Error('The word-search suggestion service returned invalid conversation metadata.');
    for (const input of game.messages) { const message = record(input, ['id', 'role', 'text']); if (typeof message.id !== 'string' || !messageId.test(message.id) || !['user', 'assistant'].includes(message.role as string) || typeof message.text !== 'string' || message.text.length > 20000) throw new Error('The word-search suggestion service returned invalid conversation metadata.'); }
  }
  applyWordSearchSuggestions(wordSearchSuggestionTarget(context.game, context.path), proposal.words);
  return { game: { ...structuredClone(game), spec } as Game, proposal };
}
