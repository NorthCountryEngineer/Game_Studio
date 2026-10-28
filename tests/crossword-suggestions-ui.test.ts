import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CrosswordSuggestionsEditor, type CrosswordGenerator } from '../src/components/CrosswordSuggestionsEditor';
import { WordGameEditor } from '../src/components/WordGameEditor';
import { applyCrosswordSuggestions, validateCrosswordSuggestionProposal } from '../src/lib/crossword-suggestions';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import type { CrosswordSpec, CrosswordSuggestionProposal } from '../src/lib/game-types';

type Element = { type: unknown; props: Record<string, any> };
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const puzzle = () => defaultWordGameSpec('crossword', 'nature') as CrosswordSpec;
function proposal(spec = puzzle()): CrosswordSuggestionProposal { return { requestId: '00000000-0000-4000-8000-000000000001', path: [], title: spec.title, description: spec.description, entries: (defaultWordGameSpec('crossword', 'space') as CrosswordSpec).puzzle.entries }; }
const available = { available: true, modeName: 'Crossword suggestions', modelName: 'Small model' };
function editor(generate?: CrosswordGenerator['generate']) {
  let cursor = 0, tree: Element, calls = 0; const states: any[] = [], refs: any[] = [], cleanups: (() => void)[] = [], changes: CrosswordSpec[] = [];
  const props = { spec: puzzle(), revision: 2, dirty: false, disabled: false, generator: { status: available, generate: async () => { calls++; return generate ? generate() : { proposal: proposal(props.spec), revision: props.revision + 2 }; } }, change(next: CrosswordSpec) { changes.push(next); } };
  const jsx = (type: unknown, value: Record<string, any>) => ({ type, props: value });
  const modules: Record<string, unknown> = {
    react: {
      useState(value: any) { const position = cursor++; if (!(position in states)) states[position] = value; return [states[position], (next: any) => { states[position] = typeof next === 'function' ? next(states[position]) : next; }]; },
      useRef(value: any) { const position = cursor++; refs[position] ??= { current: value }; return refs[position]; },
      useEffect(effect: () => (() => void) | void) { const position = cursor++; if (!(position in states)) { states[position] = true; const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx }, '../lib/crossword-suggestions': { applyCrosswordSuggestions, validateCrosswordSuggestionProposal },
  };
  const source = readFileSync(new URL('../src/components/CrosswordSuggestionsEditor.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, Error, require(name: string) { assert.ok(name in modules, name); return modules[name]; } });
  function render() { cursor = 0; tree = exported.CrosswordSuggestionsEditor(props); }
  function button(label: string) { const node = elements(tree).find(value => value.type === 'button' && text(value) === label); assert.ok(node, `Button: ${label}`); return node; }
  function checkboxes() { return elements(tree).filter(value => value.type === 'input' && value.props.type === 'checkbox'); }
  function alerts() { return elements(tree).filter(value => value.props.role === 'alert').map(text).join(' '); }
  async function generateWords() { button('Generate words & clues').props.onClick(); render(); await new Promise(resolve => setImmediate(resolve)); render(); }
  render(); return { props, render, button, checkboxes, alerts, generateWords, changes, calls: () => calls, content: () => text(tree), unmount() { cleanups.forEach(cleanup => cleanup()); } };
}

test('optional crossword generator explains saved reusable generation and why unavailable or dirty', () => {
  const spec = puzzle(), base = { spec, revision: 2, dirty: false, disabled: false, change() {}, generator: { status: available, generate: async () => ({ proposal: proposal(spec), revision: 4 }) } };
  const html = renderToStaticMarkup(createElement(CrosswordSuggestionsEditor, base));
  assert.match(html, /saved title and description/); assert.match(html, /no model call during play/); assert.match(html, /Small model/);
  const dirty = renderToStaticMarkup(createElement(CrosswordSuggestionsEditor, { ...base, dirty: true }));
  assert.match(dirty, /disabled=""[^>]*>Generate words &amp; clues/); assert.match(dirty, /Save the crossword title, description/);
  const unavailable = renderToStaticMarkup(createElement(CrosswordSuggestionsEditor, { ...base, generator: { ...base.generator, status: { available: false, reason: 'Select an enabled suggestion agent in Settings.' } } }));
  assert.match(unavailable, /Select an enabled suggestion agent in Settings/);
  const other = renderToStaticMarkup(createElement(WordGameEditor, { spec: defaultWordGameSpec('word-search'), disabled: false, dirty: false, revision: 2, change() {}, save() {}, crosswordGenerator: base.generator }));
  assert.doesNotMatch(other, /Generate words/);
});

test('generation keeps existing entries unchanged until a validated explicit selection is applied', async () => {
  const ui = editor(), original = structuredClone(ui.props.spec);
  await ui.generateWords(); ui.props.revision = 4; ui.render();
  assert.equal(ui.calls(), 1); assert.equal(ui.changes.length, 0); assert.deepEqual(ui.props.spec, original);
  assert.ok(ui.checkboxes().length >= 3); assert.ok(ui.checkboxes().every(value => value.props.checked));
  ui.button('Use selected words').props.onClick(); ui.render();
  assert.equal(ui.changes.length, 1); assert.deepEqual(ui.changes[0].puzzle.entries, proposal(original).entries);
  assert.equal(ui.changes[0].title, original.title); assert.equal(ui.changes[0].instructions, original.instructions); assert.equal(ui.changes[0].puzzle.seed, original.puzzle.seed);
  assert.equal(ui.checkboxes().length, 0);
});

test('an invalid selected subset shows the validation error and preserves current entries', async () => {
  const ui = editor(); await ui.generateWords(); ui.props.revision = 4; ui.render();
  for (let index = 2; index < ui.checkboxes().length; index++) { ui.checkboxes()[index].props.onChange({ target: { checked: false } }); ui.render(); }
  ui.button('Use selected words').props.onClick(); ui.render();
  assert.equal(ui.changes.length, 0); assert.match(ui.alerts(), /Choose 3 to 16/); assert.equal(ui.checkboxes().filter(value => value.props.checked).length, 2);
});

test('a disconnected subset cannot replace the current puzzle even when the complete pool fits', async () => {
  const entries = ['CAT', 'CAR', 'DOG', 'ROAD'].map(answer => ({ answer, clue: 'A synthetic animal or object' }));
  applyCrosswordSuggestions(puzzle(), entries);
  const ui = editor(async () => ({ proposal: { ...proposal(), entries }, revision: 4 }));
  await ui.generateWords(); ui.props.revision = 4; ui.render();
  ui.checkboxes()[3].props.onChange({ target: { checked: false } }); ui.render();
  ui.button('Use selected words').props.onClick(); ui.render();
  assert.equal(ui.changes.length, 0); assert.match(ui.alerts(), /could not form a connected crossword/);
});

test('title, seed or saved revision changes prevent an earlier proposal from replacing edits', async () => {
  for (const change of [(ui: ReturnType<typeof editor>) => { ui.props.spec = { ...ui.props.spec, title: 'Changed title' }; }, (ui: ReturnType<typeof editor>) => { ui.props.spec = { ...ui.props.spec, puzzle: { ...ui.props.spec.puzzle, seed: 345 } }; }, (ui: ReturnType<typeof editor>) => { ui.props.revision++; }]) {
    const ui = editor(); await ui.generateWords(); ui.props.revision = 4; ui.render(); change(ui); ui.render();
    assert.match(ui.content(), /saved puzzle has changed/);
    ui.button('Use selected words').props.onClick(); ui.render(); assert.equal(ui.changes.length, 0); assert.match(ui.alerts(), /earlier saved puzzle/);
  }
});

test('late generation responses cannot apply after local edits or editor unmount', async () => {
  for (const unmount of [false, true]) {
    let resolve!: (value: { proposal: CrosswordSuggestionProposal; revision: number }) => void;
    const waiting = new Promise<{ proposal: CrosswordSuggestionProposal; revision: number }>(done => { resolve = done; });
    const ui = editor(() => waiting), original = structuredClone(ui.props.spec);
    ui.button('Generate words & clues').props.onClick(); ui.render();
    if (unmount) ui.unmount(); else { ui.props.spec = { ...ui.props.spec, description: 'An edit made while waiting.' }; ui.props.dirty = true; ui.render(); }
    resolve({ proposal: proposal(original), revision: 4 }); await new Promise(done => setImmediate(done)); ui.render();
    assert.equal(ui.changes.length, 0); assert.equal(ui.checkboxes().length, 0);
    if (!unmount) assert.match(ui.alerts(), /changed while suggestions were being generated/);
  }
});

test('unavailable and unsaved generation requests never invoke a provider', async () => {
  for (const dirty of [false, true]) {
    const ui = editor(); ui.props.dirty = dirty;
    if (!dirty) ui.props.generator.status = { available: false };
    ui.render(); await ui.generateWords(); assert.equal(ui.calls(), 0);
  }
});

test('repeated activation before rendering starts only one generation request', async () => {
  let resolve!: (value: { proposal: CrosswordSuggestionProposal; revision: number }) => void;
  const waiting = new Promise<{ proposal: CrosswordSuggestionProposal; revision: number }>(done => { resolve = done; });
  const ui = editor(() => waiting), button = ui.button('Generate words & clues');
  button.props.onClick(); button.props.onClick(); assert.equal(ui.calls(), 1);
  resolve({ proposal: proposal(), revision: 4 }); await new Promise(done => setImmediate(done));
});
