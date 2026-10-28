import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WordSearchSuggestionsEditor, type WordSearchGenerator } from '../src/components/WordSearchSuggestionsEditor';
import { WordGameEditor } from '../src/components/WordGameEditor';
import { MultiGameEditor, multiStepLabel, multiStepTitle } from '../src/components/MultiGameEditor';
import { applyWordSearchSuggestions, validateWordSearchSuggestionProposal } from '../src/lib/word-search-suggestions';
import { WordSearchGenerationRequest } from '../src/lib/word-search-generation-request';
import { CrosswordGenerationRequest } from '../src/lib/crossword-generation-request';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../src/lib/multi-game';
import { defaultGameSpec, getGameLevels, validateGameSpec } from '../src/lib/game-design';
import { gameReviewLevelIds, isCooperativeGameSpec, isEndlessAsteroids } from '../src/lib/game-types';
import type { Game, GameSettings, WordSearchGeneratorStatus, WordSearchSpec, WordSearchSuggestionProposal, WordSearchSuggestionResponse } from '../src/lib/game-types';

type Element = { type: unknown; props: Record<string, any> };
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const flush = () => new Promise(resolve => setImmediate(resolve));
const puzzle = (): WordSearchSpec => { const spec = defaultWordGameSpec('word-search', 'nature') as WordSearchSpec; return { ...spec, puzzle: { ...spec.puzzle, size: 14, seed: 4123, allowBackwards: false } }; };
function proposal(spec = puzzle()): WordSearchSuggestionProposal { return { requestId: '00000000-0000-4000-8000-000000000001', path: [], title: spec.title, description: spec.description, words: ['PLANET', 'STAR', 'ORBIT', 'MOON', 'COMET'] }; }
const available: WordSearchGeneratorStatus = { available: true, modeName: 'Word search suggestions', modelName: 'Small model' };
function loadComponent(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(`../src/components/${file}.tsx`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, Error, JSON, crypto: webcrypto, structuredClone, ...globals, require(name: string) { assert.ok(name in modules, name); return modules[name]; } });
  return exported[file];
}
function editor(generate?: WordSearchGenerator['generate']) {
  let cursor = 0, tree: Element, calls = 0; const states: any[] = [], refs: any[] = [], cleanups: (() => void)[] = [], changes: WordSearchSpec[] = [];
  const generator: WordSearchGenerator = { status: available, generate: async () => { calls++; return generate ? generate() : { proposal: proposal(props.spec), revision: props.revision + 2 }; } };
  const props = { spec: puzzle(), revision: 2, dirty: false, disabled: false, generator, change(next: WordSearchSpec) { changes.push(next); } };
  const jsx = (type: unknown, value: Record<string, any>) => ({ type, props: value });
  const component = loadComponent('WordSearchSuggestionsEditor', {
    react: {
      useState(value: any) { const position = cursor++; if (!(position in states)) states[position] = value; return [states[position], (next: any) => { states[position] = typeof next === 'function' ? next(states[position]) : next; }]; },
      useRef(value: any) { const position = cursor++; refs[position] ??= { current: value }; return refs[position]; },
      useEffect(effect: () => (() => void) | void) { const position = cursor++; if (!(position in states)) { states[position] = true; const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx }, '../lib/word-search-suggestions': { applyWordSearchSuggestions, validateWordSearchSuggestionProposal },
  });
  function render() { cursor = 0; tree = component(props); }
  function button(label: string) { const node = elements(tree).find(value => value.type === 'button' && text(value) === label); assert.ok(node, `Button: ${label}`); return node; }
  function checkboxes() { return elements(tree).filter(value => value.type === 'input' && value.props.type === 'checkbox'); }
  function alerts() { return elements(tree).filter(value => value.props.role === 'alert').map(text).join(' '); }
  async function generateWords() { button('Generate words').props.onClick(); render(); await flush(); render(); }
  render(); return { props, render, button, checkboxes, alerts, generateWords, changes, calls: () => calls, content: () => text(tree), unmount() { cleanups.forEach(cleanup => cleanup()); } };
}

test('word search suggestions explain reuse and unavailable or unsaved states without changing other genres', () => {
  const spec = puzzle(), generator: WordSearchGenerator = { status: available, generate: async () => ({ proposal: proposal(spec), revision: 4 }) };
  const base = { spec, revision: 2, dirty: false, disabled: false, change() {}, generator };
  const html = renderToStaticMarkup(createElement(WordSearchSuggestionsEditor, base));
  assert.match(html, /saved title and description/); assert.match(html, /no model call during play/); assert.match(html, /Small model/);
  const dirty = renderToStaticMarkup(createElement(WordSearchSuggestionsEditor, { ...base, dirty: true }));
  assert.match(dirty, /disabled=""[^>]*>Generate words/); assert.match(dirty, /Save the word search title, description/);
  const unavailable = renderToStaticMarkup(createElement(WordSearchSuggestionsEditor, { ...base, generator: { ...generator, status: { available: false, reason: 'Select an enabled suggestion agent in Settings.' } } }));
  assert.match(unavailable, /Select an enabled suggestion agent in Settings/);
  for (const genre of ['crossword', 'mad-libs'] as const) {
    const other = renderToStaticMarkup(createElement(WordGameEditor, { spec: defaultWordGameSpec(genre), disabled: false, dirty: false, revision: 2, change() {}, save() {}, wordSearchGenerator: generator }));
    assert.doesNotMatch(other, /Generate words/);
  }
});

test('standalone and multi-game word search editors receive the optional generator and exact step path', () => {
  let calls = 0; const paths: string[][] = [], generator: WordSearchGenerator = { status: available, generate: async () => { calls++; return { proposal: proposal(), revision: 4 }; } };
  const standalone = renderToStaticMarkup(createElement(WordGameEditor, { spec: puzzle(), disabled: false, dirty: false, revision: 2, change() {}, save() {}, wordSearchGenerator: generator }));
  assert.match(standalone, /Word search word suggestions/); assert.match(standalone, />Generate words<\/button>/);
  const multi = defaultMultiGameSpec(); multi.steps = [{ id: 'step-1', type: 'game', spec: puzzle() }, ...multi.steps.map((step, index) => ({ ...step, id: `step-${index + 2}` }))];
  const nested = renderToStaticMarkup(createElement(MultiGameEditor, { spec: multi, library: [], disabled: false, dirty: false, revision: 2, onChange() {}, save() {}, wordSearchGenerator(path) { paths.push(path); return generator; } }));
  assert.match(nested, /Word search word suggestions/); assert.deepEqual(paths, [['step-1']]); assert.equal(calls, 0);
});

test('generation preserves all authored fields until explicit apply, then changes only the word list', async () => {
  const ui = editor(), original = structuredClone(ui.props.spec);
  await ui.generateWords(); ui.props.revision = 4; ui.render();
  assert.equal(ui.calls(), 1); assert.equal(ui.changes.length, 0); assert.deepEqual(ui.props.spec, original);
  ui.checkboxes()[4].props.onChange({ target: { checked: false } }); ui.render();
  ui.button('Use selected words').props.onClick(); ui.render();
  assert.equal(ui.changes.length, 1); assert.deepEqual(ui.changes[0], { ...original, puzzle: { ...original.puzzle, words: proposal(original).words.slice(0, 4) } });
  assert.equal(ui.checkboxes().length, 0);
});

test('invalid word counts and words too large for the saved grid cannot replace existing words', async () => {
  const ui = editor(); await ui.generateWords(); ui.props.revision = 4; ui.render();
  for (let index = 2; index < ui.checkboxes().length; index++) { ui.checkboxes()[index].props.onChange({ target: { checked: false } }); ui.render(); }
  ui.button('Use selected words').props.onClick(); ui.render();
  assert.equal(ui.changes.length, 0); assert.match(ui.alerts(), /3.*16/);
  const tooLong = editor(async () => ({ proposal: { ...proposal(), words: ['ASTROPHOTOGRAPHY', 'STAR', 'MOON'] }, revision: 4 }));
  await tooLong.generateWords(); tooLong.props.revision = 4; tooLong.render(); tooLong.button('Use selected words').props.onClick(); tooLong.render();
  assert.equal(tooLong.changes.length, 0); assert.match(tooLong.alerts(), /grid|fit/i);
});

test('title, description, seed, size, direction or revision changes invalidate suggestions', async () => {
  for (const alter of [
    (ui: ReturnType<typeof editor>) => { ui.props.spec = { ...ui.props.spec, title: 'Changed title' }; },
    (ui: ReturnType<typeof editor>) => { ui.props.spec = { ...ui.props.spec, description: 'Changed description' }; },
    (ui: ReturnType<typeof editor>) => { ui.props.spec = { ...ui.props.spec, puzzle: { ...ui.props.spec.puzzle, seed: 345 } }; },
    (ui: ReturnType<typeof editor>) => { ui.props.spec = { ...ui.props.spec, puzzle: { ...ui.props.spec.puzzle, size: 15 } }; },
    (ui: ReturnType<typeof editor>) => { ui.props.spec = { ...ui.props.spec, puzzle: { ...ui.props.spec.puzzle, allowBackwards: true } }; },
    (ui: ReturnType<typeof editor>) => { ui.props.revision++; },
  ]) {
    const ui = editor(); await ui.generateWords(); ui.props.revision = 4; ui.render(); alter(ui); ui.render();
    assert.match(ui.content(), /saved puzzle has changed/); ui.button('Use selected words').props.onClick(); ui.render();
    assert.equal(ui.changes.length, 0); assert.match(ui.alerts(), /earlier saved puzzle/);
  }
});

test('late responses cannot apply after editing or unmounting and duplicate activation starts one request', async () => {
  for (const unmount of [false, true]) {
    let resolve!: (value: { proposal: WordSearchSuggestionProposal; revision: number }) => void;
    const waiting = new Promise<{ proposal: WordSearchSuggestionProposal; revision: number }>(done => { resolve = done; });
    const ui = editor(() => waiting), original = structuredClone(ui.props.spec), button = ui.button('Generate words');
    button.props.onClick(); button.props.onClick(); ui.render(); assert.equal(ui.calls(), 1);
    if (unmount) ui.unmount(); else { ui.props.spec = { ...ui.props.spec, description: 'An edit made while waiting.' }; ui.props.dirty = true; ui.render(); }
    resolve({ proposal: proposal(original), revision: 4 }); await flush(); ui.render();
    assert.equal(ui.changes.length, 0); assert.equal(ui.checkboxes().length, 0);
    if (!unmount) assert.match(ui.alerts(), /changed while suggestions were being generated/);
  }
});

test('disabled, unavailable and unsaved requests never invoke a provider; failures do not auto-retry', async () => {
  for (const state of ['dirty', 'disabled', 'unavailable']) {
    const ui = editor(); if (state === 'unavailable') ui.props.generator.status = { available: false }; else ui.props[state as 'dirty' | 'disabled'] = true;
    ui.render(); await ui.generateWords(); assert.equal(ui.calls(), 0);
  }
  let fail = true; const ui = editor(async () => { if (fail) throw new Error('Synthetic provider failure. Try again.'); return { proposal: proposal(), revision: 4 }; });
  await ui.generateWords(); assert.equal(ui.calls(), 1); assert.match(ui.alerts(), /Synthetic provider failure/); assert.equal(ui.changes.length, 0);
  fail = false; await ui.generateWords(); ui.props.revision = 4; ui.render(); assert.equal(ui.calls(), 2); assert.equal(ui.alerts(), ''); assert.ok(ui.checkboxes().length > 0);
});

function workshop(generate: (game: Game, requestId: string, path: string[], title: string, description: string) => Promise<WordSearchSuggestionResponse>) {
  let cursor = 0, tree: Element, selected: Game = { id: '00000000-0000-4000-8000-000000000005', spec: puzzle(), revision: 0, status: 'Draft', createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' };
  const states: any[] = [], refs: any[] = [], effects: { dependencies: unknown[]; cleanup?: () => void }[] = [], queued: (() => void)[] = [];
  const settings: GameSettings = { config: { version: 1, revision: 0, creationEnabled: true, assistantModeId: '', wordSearchAssistantModeId: 'word-search-mode' }, canCreate: true, canManage: false, canPublish: true, canAdminContent: false, wordSearchGenerator: available };
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const component = loadComponent('GameStudio', {
    react: {
      useState(value: any) { const position = cursor++; if (!(position in states)) states[position] = typeof value === 'function' ? value() : value; return [states[position], (next: any) => { states[position] = typeof next === 'function' ? next(states[position]) : next; }]; },
      useRef(value: any) { const position = cursor++; refs[position] ??= { current: value }; return refs[position]; },
      useEffect(effect: () => (() => void) | void, dependencies: unknown[]) { const position = cursor++, old = effects[position]; if (!old || dependencies.some((value, index) => old.dependencies[index] !== value)) { queued.push(() => { old?.cleanup?.(); effects[position] = { dependencies, cleanup: effect() || undefined }; }); } },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../lib/game-api': { getGameSettings: async () => settings, listGames: async () => [selected], getGame: async () => structuredClone(selected), generateWordSearchSuggestions: generate },
    '../lib/game-design': { defaultGameSpec, getGameLevels, validateGameSpec }, '../lib/game-types': { gameReviewLevelIds, isCooperativeGameSpec, isEndlessAsteroids },
    '../lib/game-multiplayer-design': {}, './WordGameEditor': { WordGameEditor, wordGenreNames: { crossword: 'Crossword', 'word-search': 'Word search', 'mad-libs': 'Mad Libs' } },
    '../lib/agent-api': {}, '../lib/core': { isCore: false }, './Confirm': { useConfirm: () => async () => true }, './ItemActions': {}, './GamePlayer': {}, './AsteroidSpriteEditor': {}, './AsteroidChallengeEditor': {}, '../lib/asteroid-authoring': {}, './AsteroidPrizeEditor': {}, './ServiceBadge': {}, './MultiplayerLobby': {},
    '../lib/branding': { useBranding: () => ({ appName: 'Synthetic Game Studio' }), useIntegrationConfig: () => ({ hosts: [] }) }, '../lib/integration': {}, '../lib/game-multiplayer': {}, '../lib/game-flow': {}, './LevelFlowEditor': {}, './MultiGameEditor': { multiStepLabel, multiStepTitle }, '../lib/multi-game': {},
    '../lib/crossword-generation-request': { CrosswordGenerationRequest }, '../lib/word-search-generation-request': { WordSearchGenerationRequest }, './HostSelectionLink': {},
  }, { window: { location: { origin: 'https://synthetic.invalid' }, addEventListener() {}, removeEventListener() {} } });
  const props = { adminMode: false, onDirty() {}, navigate: async () => {}, initialGameId: selected.id };
  function render() { cursor = 0; tree = component(props); while (queued.length) queued.shift()!(); }
  function wordEditor() { const found = elements(tree).find(value => value.type === WordGameEditor); assert.ok(found); return found; }
  return { props, render, wordEditor, current: () => selected, setStored(value: Game) { selected = value; }, async start() { render(); await flush(); render(); }, content: () => text(tree), unmount() { effects.forEach(effect => effect?.cleanup?.()); } };
}

test('workshop recovers a lost reply using the original request and does not overwrite the saved word list', async () => {
  const requests: { game: Game; requestId: string; path: string[] }[] = []; let cached: WordSearchSuggestionResponse | undefined;
  const ui = workshop(async (game, requestId, path) => {
    requests.push({ game: structuredClone(game), requestId, path });
    if (!cached) { cached = { game: { ...structuredClone(game), revision: game.revision + 2 }, proposal: { ...proposal(game.spec as WordSearchSpec), requestId, path } }; ui.setStored(cached.game); throw new Error('Synthetic lost response'); }
    return cached;
  });
  await ui.start(); const original = structuredClone(ui.wordEditor().props.spec);
  await assert.rejects(ui.wordEditor().props.wordSearchGenerator.generate(), /Synthetic lost response/); ui.render();
  assert.equal(requests.length, 1); assert.equal(ui.wordEditor().props.revision, 2); assert.deepEqual(ui.wordEditor().props.spec, original);
  const result = await ui.wordEditor().props.wordSearchGenerator.generate(); ui.render();
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]); assert.equal(result.revision, 2); assert.deepEqual(ui.wordEditor().props.spec, original);
});

test('an uncertain recovered operation disables another generation without an automatic retry', async () => {
  let calls = 0; const ui = workshop(async game => { calls++; ui.setStored({ ...game, revision: game.revision + 1, operationState: 'uncertain', operationError: 'Synthetic uncertain operation' }); throw new Error('Synthetic response unavailable'); });
  await ui.start(); await assert.rejects(ui.wordEditor().props.wordSearchGenerator.generate(), /Synthetic response unavailable/); ui.render();
  assert.equal(calls, 1); assert.equal(ui.wordEditor().props.wordSearchGenerator.status.available, false); assert.match(ui.content(), /could not be confirmed/);
  await assert.rejects(ui.wordEditor().props.wordSearchGenerator.generate(), /Save your title/); assert.equal(calls, 1);
});

test('workshop navigation discards an older in-flight generator response', async () => {
  let resolve!: (value: WordSearchSuggestionResponse) => void;
  const waiting = new Promise<WordSearchSuggestionResponse>(done => { resolve = done; });
  const ui = workshop(() => waiting); await ui.start(); const first = structuredClone(ui.current()), request = ui.wordEditor().props.wordSearchGenerator.generate();
  const next = { ...first, id: '00000000-0000-4000-8000-000000000006', spec: { ...first.spec, title: 'Another saved word search' } };
  ui.setStored(next); ui.props.initialGameId = next.id; ui.render(); await flush(); ui.render();
  resolve({ game: { ...first, revision: 2 }, proposal: proposal(first.spec as WordSearchSpec) });
  await assert.rejects(request, /selected game changed/); ui.render(); assert.equal(ui.wordEditor().props.spec.title, next.spec.title);
});
