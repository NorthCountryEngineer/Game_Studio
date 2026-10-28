import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyWordSearchSuggestions, validateWordSearchSuggestionWords, validateWordSearchSuggestionProposal, validateWordSearchSuggestionRequest, validateWordSearchSuggestionResponse, wordSearchSuggestionTarget } from '../src/lib/word-search-suggestions';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../src/lib/multi-game';
import { createWordGameEngine } from '../src/lib/word-game-engine';
import type { Game, GameSpec, WordSearchSpec, WordSearchSuggestionProposal } from '../src/lib/game-types';

const gameId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-28T12:00:00.000Z', options = ['PLANET', 'STAR', 'ORBIT', 'MOON', 'COMET'];
function game(spec: GameSpec = defaultWordGameSpec('word-search')): Game { return { id: gameId, spec, revision: 3, status: 'Draft', messages: [], createdAt: stamp, updatedAt: stamp }; }
function context(draft = game(), path: string[] = []) { const target = wordSearchSuggestionTarget(draft, path); return { game: draft, requestId, path, title: target.title, description: target.description }; }
function proposal(draft = game(), path: string[] = []): WordSearchSuggestionProposal { const target = wordSearchSuggestionTarget(draft, path); return { requestId, path, title: target.title, description: target.description, words: [...options] }; }
function response(draft = game(), path: string[] = []) { return { game: { ...structuredClone(draft), revision: draft.revision + 2 }, proposal: proposal(draft, path) }; }

test('word-search options stay separate until a creator applies a selection; seed, size, directions and metadata stay authored', () => {
  const saved = defaultWordGameSpec('word-search') as WordSearchSpec;
  saved.puzzle.seed = 4242; saved.puzzle.size = 14; saved.puzzle.allowBackwards = true;
  const draft = game(saved), before = structuredClone(draft), result = validateWordSearchSuggestionResponse(response(draft), context(draft));
  assert.deepEqual(draft, before); assert.deepEqual(result.game.spec, draft.spec);
  assert.notDeepEqual(result.proposal.words, saved.puzzle.words);
  const selected = applyWordSearchSuggestions(saved, result.proposal.words.slice(0, 3));
  assert.deepEqual(selected, { ...saved, puzzle: { ...saved.puzzle, words: options.slice(0, 3) } });
  assert.deepEqual(draft, before);
  selected.puzzle.words[0] = 'EDIT'; assert.equal(result.proposal.words[0], options[0]);
  result.game.spec.title = 'Edited returned copy'; assert.equal(draft.spec.title, before.spec.title);
});

test('suggested word limits reject malformed words, duplicates, sparse arrays, excessive count and letter overflow', () => {
  const sparse = ['PLANET', 'STAR', 'ORBIT']; delete sparse[1];
  for (const invalid of [null, {}, [], options.slice(0, 2), Array.from({ length: 17 }, (_, index) => `A${String.fromCharCode(65 + index)}`), [null, ...options.slice(1)], ['star', ...options.slice(1)], ['STÁR', ...options.slice(1)], ['ＡＢ', ...options.slice(1)], ['MOON STAR', ...options.slice(1)], ['MOON-STAR', ...options.slice(1)], ['<script>', ...options.slice(1)], ['https://example.invalid', ...options.slice(1)], ['fetch(secret)', ...options.slice(1)], ['A', ...options.slice(1)], ['A'.repeat(19), ...options.slice(1)], [...options, options[0]], sparse, Array.from({ length: 16 }, (_, index) => `${'A'.repeat(17)}${String.fromCharCode(65 + index)}`)]) assert.throws(() => validateWordSearchSuggestionWords(invalid));
  const boundary = Array.from({ length: 16 }, (_, index) => `${'A'.repeat(14)}${String.fromCharCode(65 + index)}`);
  assert.equal(boundary.join('').length, 240); assert.deepEqual(validateWordSearchSuggestionWords(boundary), boundary);
  const clean = validateWordSearchSuggestionWords(options); clean[0] = 'EDIT'; assert.equal(options[0], 'PLANET');
});

test('selected suggestions must fit the saved grid count and word length without changing public engine limits', () => {
  const saved = defaultWordGameSpec('word-search') as WordSearchSpec;
  saved.puzzle.size = 10;
  assert.throws(() => applyWordSearchSuggestions(saved, ['ABCDEFGHIJK', 'STAR', 'MOON']), /fit the grid/);
  const eleven = Array.from({ length: 11 }, (_, index) => `A${String.fromCharCode(65 + index)}`);
  assert.throws(() => applyWordSearchSuggestions(saved, eleven), /grid rows/);
  const max = Array.from({ length: 16 }, (_, index) => `${'A'.repeat(14)}${String.fromCharCode(65 + index)}`);
  const larger = { ...saved, puzzle: { ...saved.puzzle, size: 24 } }, selected = applyWordSearchSuggestions(larger, max);
  const engine = createWordGameEngine(); assert.equal(engine.wordSearch(selected).placements.length, 16);
  assert.deepEqual(engine.wordSearch(selected), engine.wordSearch(selected));
  // The 240-letter suggestion budget does not alter ordinary authored games.
  const authored = Array.from({ length: 16 }, (_, index) => `${'A'.repeat(17)}${String.fromCharCode(65 + index)}`);
  assert.equal(engine.validate({ ...larger, puzzle: { ...larger.puzzle, words: authored } }).genre, 'word-search');
});

test('proposal shape and standalone or one-child target path are strict and genre bound', () => {
  const valid = proposal(); assert.deepEqual(validateWordSearchSuggestionProposal(valid), valid);
  for (const invalid of [{ ...valid, requestId: 'bad' }, { ...valid, path: ['step-13'] }, { ...valid, path: ['step-1', 'step-2'] }, { ...valid, path: [1] }, { ...valid, path: Array(1) }, { ...valid, path: 'step-1' }, { ...valid, entries: [] }, { ...valid, title: ' ' }, { ...valid, title: 'https://example.invalid' }, { ...valid, description: 'x'.repeat(301) }, { ...valid, words: undefined }]) assert.throws(() => validateWordSearchSuggestionProposal(invalid));
  const multi = game(defaultMultiGameSpec()); assert.equal(wordSearchSuggestionTarget(multi, ['step-2']).genre, 'word-search');
  assert.throws(() => wordSearchSuggestionTarget(multi, []), /Choose a word search/);
  assert.throws(() => wordSearchSuggestionTarget(multi, ['step-1']), /Choose a word search/);
  assert.throws(() => wordSearchSuggestionTarget(game(), ['step-2']), /Choose a word search/);
  assert.throws(() => wordSearchSuggestionTarget(game(defaultWordGameSpec('crossword')), []), /Choose a word search/);
  validateWordSearchSuggestionRequest(context()); validateWordSearchSuggestionRequest(context(multi, ['step-2']));
  assert.throws(() => validateWordSearchSuggestionRequest({ ...context(), title: 'Unsaved title' }), /Save/);
  assert.throws(() => validateWordSearchSuggestionRequest({ ...context(), description: 'Unsaved topic' }), /Save/);
  assert.throws(() => validateWordSearchSuggestionRequest({ ...context(), requestId: 'bad' }), /Reload/);
  assert.throws(() => validateWordSearchSuggestionRequest({ ...context(), game: { ...game(), revision: Number.NaN } }), /Reload/);
});

test('responses bind the full saved parent, request, path and topic while admitting usage-only revision recovery', () => {
  const draft = game(defaultMultiGameSpec()), expected = context(draft, ['step-2']), valid = response(draft, ['step-2']);
  assert.equal(validateWordSearchSuggestionResponse(valid, expected).game.revision, draft.revision + 2);
  assert.equal(validateWordSearchSuggestionResponse({ ...valid, game: { ...valid.game, revision: draft.revision + 8 } }, expected).game.revision, draft.revision + 8);
  const changedSibling = structuredClone(draft.spec) as ReturnType<typeof defaultMultiGameSpec>;
  if (changedSibling.steps[0].type === 'game') changedSibling.steps[0].spec.title = 'Changed sibling';
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, game: { ...valid.game, id: requestId } },
    { ...valid, game: { ...valid.game, revision: draft.revision + 1 } },
    { ...valid, game: { ...valid.game, revision: Number.POSITIVE_INFINITY } },
    { ...valid, game: { ...valid.game, spec: { ...draft.spec, title: 'A changed parent' } } },
    { ...valid, game: { ...valid.game, spec: changedSibling } },
    { ...valid, proposal: { ...valid.proposal, requestId: gameId } },
    { ...valid, proposal: { ...valid.proposal, path: [] } },
    { ...valid, proposal: { ...valid.proposal, path: ['step-1'] } },
    { ...valid, proposal: { ...valid.proposal, title: 'Different title' } },
    { ...valid, proposal: { ...valid.proposal, description: 'Different description' } },
    { ...valid, proposal: { ...valid.proposal, words: ['ABCDEFGHIJKLM', 'STAR', 'MOON'] } },
  ]) assert.throws(() => validateWordSearchSuggestionResponse(invalid, expected));
  const reordered = { ...valid, game: { ...valid.game, spec: Object.fromEntries(Object.entries(valid.game.spec).reverse()) } };
  assert.deepEqual(validateWordSearchSuggestionResponse(reordered, expected).game.spec, valid.game.spec);
});

test('response game metadata accepts existing IDs and rejects malformed fields without exposing private state', () => {
  const draft = game(); draft.messages = [
    { id: `${gameId}-idea`, role: 'user', text: 'Create a word search' },
    { id: `${gameId}-reply`, role: 'assistant', text: 'Created an editable starter.' },
    { id: requestId, role: 'user', text: 'Keep the words.' },
    { id: `${requestId}-reply`, role: 'assistant', text: 'Kept the saved words.' },
  ];
  const valid = response(draft), expected = context(draft);
  assert.deepEqual(validateWordSearchSuggestionResponse(valid, expected).game.messages, draft.messages);
  for (const patch of [
    { createdAt: 'bad' }, { createdAt: '2026-10-27T12:00:00Z' }, { updatedAt: 'bad' }, { status: 'Unknown' },
    { testedRevision: valid.game.revision + 1 }, { publishedRevision: -1 }, { publishedAt: 'bad' },
    { operationState: 'Unknown' }, { operationError: 1 }, { _owner: 'unexpected private metadata' },
    { messages: [{ id: requestId, role: 'system', text: 'bad' }] },
    { messages: [{ id: 'unbound-id', role: 'assistant', text: 'bad' }] },
    { messages: [{ id: requestId, role: 'assistant', text: 'bad', extra: true }] },
  ]) assert.throws(() => validateWordSearchSuggestionResponse({ ...valid, game: { ...valid.game, ...patch } }, expected));
});
