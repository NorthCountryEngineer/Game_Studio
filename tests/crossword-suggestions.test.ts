import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCrosswordSuggestions, crosswordSuggestionTarget, validateCrosswordSuggestionEntries, validateCrosswordSuggestionProposal, validateCrosswordSuggestionRequest, validateCrosswordSuggestionResponse } from '../src/lib/crossword-suggestions.ts';
import { LocalGameLibrary, validateGameConfig } from '../src/lib/game-local.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';
import { defaultMultiGameSpec } from '../src/lib/multi-game.ts';
import type { CrosswordSpec, CrosswordSuggestionProposal, Game, GameSpec } from '../src/lib/game-types.ts';

const gameId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-28T12:00:00.000Z';
function game(spec: GameSpec = defaultWordGameSpec('crossword')): Game { return { id: gameId, spec, revision: 3, status: 'Draft', messages: [], createdAt: stamp, updatedAt: stamp }; }
function context(draft = game(), path: string[] = []) { const target = crosswordSuggestionTarget(draft, path); return { game: draft, requestId, path, title: target.title, description: target.description }; }
function proposal(draft = game(), path: string[] = []): CrosswordSuggestionProposal { const target = crosswordSuggestionTarget(draft, path); return { requestId, path, title: target.title, description: target.description, entries: structuredClone((defaultWordGameSpec('crossword', 'space') as CrosswordSpec).puzzle.entries) }; }
function response(draft = game(), path: string[] = []) { return { game: { ...structuredClone(draft), revision: draft.revision + 2 }, proposal: proposal(draft, path) }; }

test('suggestion contracts preserve authored entries until a creator explicitly applies a valid selection', () => {
  const draft = game(), original = structuredClone(draft), result = validateCrosswordSuggestionResponse(response(draft), context(draft));
  assert.deepEqual(draft, original); assert.deepEqual(result.game.spec, draft.spec);
  assert.notDeepEqual(result.proposal.entries, (draft.spec as CrosswordSpec).puzzle.entries);
  const selected = applyCrosswordSuggestions(draft.spec as CrosswordSpec, result.proposal.entries.slice(0, 3));
  assert.equal(selected.puzzle.seed, (draft.spec as CrosswordSpec).puzzle.seed);
  assert.equal(selected.title, draft.spec.title); assert.equal(selected.description, draft.spec.description); assert.equal(selected.instructions, draft.spec.instructions);
  assert.equal(selected.puzzle.entries.length, 3); assert.deepEqual(draft, original);
  selected.puzzle.entries[0].clue = 'Edited by the creator'; assert.notEqual(result.proposal.entries[0].clue, selected.puzzle.entries[0].clue);
});

test('selection must fit the existing fixed connected layout using the saved seed', () => {
  const crossword = defaultWordGameSpec('crossword') as CrosswordSpec;
  assert.throws(() => applyCrosswordSuggestions(crossword, [{ answer: 'AA', clue: 'a' }, { answer: 'BB', clue: 'b' }, { answer: 'CC', clue: 'c' }]), /connected|layout/);
  assert.throws(() => applyCrosswordSuggestions(crossword, crossword.puzzle.entries.slice(0, 2)), /3 to 16/);
  const entries = [{ answer: 'WATER', clue: 'Water without any claim of certainty' }, { answer: 'RAIN', clue: 'Falls from clouds' }, { answer: 'TREE', clue: 'A tall plant' }];
  const result = applyCrosswordSuggestions(crossword, entries);
  assert.deepEqual(result.puzzle.entries, entries); assert.equal(result.puzzle.seed, crossword.puzzle.seed);
});

test('candidate entries reject malformed data, unsafe clues, duplicate answers and total letter overflow', () => {
  const entries = (defaultWordGameSpec('crossword') as CrosswordSpec).puzzle.entries;
  for (const invalid of [null, {}, [], entries.slice(0, 2), Array(17).fill(entries[0]), [{ ...entries[0], surprise: true }, ...entries.slice(1)], [{ ...entries[0], answer: 'water' }, ...entries.slice(1)], [{ ...entries[0], answer: 'WÁTÉR' }, ...entries.slice(1)], [{ ...entries[0], answer: 'A' }, ...entries.slice(1)], [{ ...entries[0], answer: 'A'.repeat(19) }, ...entries.slice(1)], [{ ...entries[0], clue: '' }, ...entries.slice(1)], [{ ...entries[0], clue: ' '.repeat(3) }, ...entries.slice(1)], [{ ...entries[0], clue: 'x'.repeat(141) }, ...entries.slice(1)], [{ ...entries[0], clue: '<script>bad</script>' }, ...entries.slice(1)], [{ ...entries[0], clue: 'https://example.invalid' }, ...entries.slice(1)], [{ ...entries[0], clue: 'fetch(secret)' }, ...entries.slice(1)], [{ ...entries[0], clue: '\ud800' }, ...entries.slice(1)], [...entries, entries[0]], Array.from({ length: 16 }, (_, index) => ({ answer: `${'A'.repeat(17)}${String.fromCharCode(65 + index)}`, clue: 'A synthetic option' }))]) assert.throws(() => validateCrosswordSuggestionEntries(invalid));
  const clean = validateCrosswordSuggestionEntries(entries); clean[0].clue = 'Changed'; assert.notEqual(clean[0].clue, entries[0].clue);
});

test('proposal shapes and target paths reject unsupported nesting and cross-game targets', () => {
  const valid = proposal(); assert.deepEqual(validateCrosswordSuggestionProposal(valid), valid);
  for (const invalid of [{ ...valid, requestId: 'wrong' }, { ...valid, requestId: undefined }, { ...valid, path: ['step-13'] }, { ...valid, path: ['step-1', 'step-2'] }, { ...valid, path: [1] }, { ...valid, path: 'step-1' }, { ...valid, extra: true }, { ...valid, title: ' ' }, { ...valid, description: 'x'.repeat(301) }]) assert.throws(() => validateCrosswordSuggestionProposal(invalid));
  const multi = game(defaultMultiGameSpec()), target = crosswordSuggestionTarget(multi, ['step-1']); assert.equal(target.genre, 'crossword');
  assert.throws(() => crosswordSuggestionTarget(multi, []), /Choose a crossword/);
  assert.throws(() => crosswordSuggestionTarget(multi, ['step-2']), /Choose a crossword/);
  assert.throws(() => crosswordSuggestionTarget(game(), ['step-1']), /Choose a crossword/);
  const root = context(), nested = context(multi, ['step-1']);
  validateCrosswordSuggestionRequest(root); validateCrosswordSuggestionRequest(nested);
  assert.throws(() => validateCrosswordSuggestionRequest({ ...root, title: 'Unsaved title' }), /Save/);
  assert.throws(() => validateCrosswordSuggestionRequest({ ...root, description: 'Unsaved description' }), /Save/);
  assert.throws(() => validateCrosswordSuggestionRequest({ ...root, game: { ...root.game, revision: Number.NaN } }), /Reload/);
});

test('responses bind request, game, full saved spec, path and metadata even after usage-only revisions', () => {
  const draft = game(defaultMultiGameSpec()), expected = context(draft, ['step-1']), valid = response(draft, ['step-1']);
  assert.equal(validateCrosswordSuggestionResponse(valid, expected).game.revision, draft.revision + 2);
  assert.equal(validateCrosswordSuggestionResponse({ ...valid, game: { ...valid.game, revision: draft.revision + 8 } }, expected).game.revision, draft.revision + 8);
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, game: { ...valid.game, id: requestId } },
    { ...valid, game: { ...valid.game, revision: draft.revision + 1 } },
    { ...valid, game: { ...valid.game, revision: Number.POSITIVE_INFINITY } },
    { ...valid, game: { ...valid.game, spec: { ...valid.game.spec, title: 'A changed draft' } } },
    { ...valid, game: { ...valid.game, spec: { ...valid.game.spec, steps: (valid.game.spec as ReturnType<typeof defaultMultiGameSpec>).steps.map(step => step.id === 'step-2' && step.type === 'game' ? { ...step, spec: { ...step.spec, title: 'A changed sibling game' } } : step) } } },
    { ...valid, proposal: { ...valid.proposal, requestId: gameId } },
    { ...valid, proposal: { ...valid.proposal, path: [] } },
    { ...valid, proposal: { ...valid.proposal, title: 'Different title' } },
    { ...valid, proposal: { ...valid.proposal, description: 'Different description' } },
    { ...valid, proposal: { ...valid.proposal, entries: [{ answer: 'AA', clue: 'a' }, { answer: 'BB', clue: 'b' }, { answer: 'CC', clue: 'c' }] } },
    { ...valid, game: { ...valid.game, createdAt: 'invalid' } },
    { ...valid, game: { ...valid.game, createdAt: '2026-10-27T12:00:00Z' } },
    { ...valid, game: { ...valid.game, status: 'Unknown' } },
    { ...valid, game: { ...valid.game, testedRevision: valid.game.revision + 1 } },
    { ...valid, game: { ...valid.game, messages: [{ id: requestId, role: 'system', text: 'bad' }] } },
    { ...valid, game: { ...valid.game, _owner: 'unexpected private metadata' } },
  ]) assert.throws(() => validateCrosswordSuggestionResponse(invalid, expected));
  const reordered = { ...valid, game: { ...valid.game, spec: Object.fromEntries(Object.entries(valid.game.spec).reverse()) } };
  assert.deepEqual(validateCrosswordSuggestionResponse(reordered, expected).game.spec, valid.game.spec);
});

test('response metadata accepts existing server idea/reply identifiers and browser UUIDs', () => {
  const draft = game(); draft.messages = [
    { id: `${gameId}-idea`, role: 'user', text: 'Make a crossword' },
    { id: `${gameId}-reply`, role: 'assistant', text: 'Created an editable starter.' },
    { id: requestId, role: 'user', text: 'Title: Nature Crossword' },
    { id: `${requestId}-reply`, role: 'assistant', text: 'Kept your authored entries.' },
  ];
  assert.deepEqual(validateCrosswordSuggestionResponse(response(draft), context(draft)).game.messages, draft.messages);
  const invalid = response(draft); invalid.game.messages![0].id = 'unbound-message';
  assert.throws(() => validateCrosswordSuggestionResponse(invalid, context(draft)), /conversation metadata/);
});

test('old game settings keep their original four fields; optional crossword modes stay opt-in', () => {
  const config = { version: 1 as const, revision: 0, creationEnabled: true, assistantModeId: '' };
  assert.deepEqual(validateGameConfig(config), config);
  assert.deepEqual(validateGameConfig({ ...config, crosswordAssistantModeId: '' }), { ...config, crosswordAssistantModeId: '' });
  assert.deepEqual(validateGameConfig({ ...config, crosswordAssistantModeId: 'crossword-small' }), { ...config, crosswordAssistantModeId: 'crossword-small' });
  for (const mode of [undefined, null, true, 12, 'https://example.invalid', 'bad mode', 'x'.repeat(65)]) assert.throws(() => validateGameConfig({ ...config, crosswordAssistantModeId: mode } as typeof config), /valid game creation settings/);
  assert.throws(() => validateGameConfig({ ...config, surprise: true } as typeof config), /valid game creation settings/);
});

test('preview explicitly reports AI unavailable even when a crossword mode is configured', () => {
  const values = new Map<string, string>(), library = new LocalGameLibrary({ getItem: key => values.get(key) || null, setItem: (key, value) => { values.set(key, value); } });
  assert.equal(library.settings().crosswordGenerator?.available, false);
  const first = library.settings(), next = library.saveSettings({ ...first.config, crosswordAssistantModeId: 'crossword-small' }, first.config.revision);
  assert.equal(next.config.crosswordAssistantModeId, 'crossword-small'); assert.equal(next.crosswordGenerator?.available, false); assert.match(next.crosswordGenerator?.reason || '', /Local preview makes no model calls/);
  assert.deepEqual(Object.keys(first.config).sort(), ['assistantModeId', 'creationEnabled', 'revision', 'version']);
});
