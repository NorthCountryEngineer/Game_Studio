import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createPlatformerSpec } from '../src/lib/game-flow';
import { defaultMultiGameSpec, validateMultiGameSpec } from '../src/lib/multi-game';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { defaultGameSpec, getGameLevels, updateAsteroidSettings } from '../src/lib/game-design';
import { isCooperativeGameSpec, isEndlessAsteroids, type MultiGameSpec } from '../src/lib/game-types';

type Element = { type: unknown; props: Record<string, any> };
const mime = 'application/x-game-studio-multi-game';
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function transfer(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { effectAllowed: 'none', dropEffect: 'none', get types() { return [...values.keys()]; }, setData(type: string, value: string) { values.set(type, value); }, getData(type: string) { return values.get(type) ?? ''; } };
}
function event(dataTransfer: ReturnType<typeof transfer>) { return { dataTransfer, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; }
function editor(initial = defaultMultiGameSpec()) {
  let spec = initial, cursor = 0, tree: Element; const states: any[] = [], refs: any[] = [], changes: MultiGameSpec[] = [];
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: { useState(value: any) { const position = cursor++; if (!(position in states)) states[position] = value; return [states[position], (next: any) => { states[position] = typeof next === 'function' ? next(states[position]) : next; }]; }, useRef(value: any) { const position = cursor++; refs[position] ??= { current: value }; return refs[position]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }, './Confirm': { useConfirm: () => async () => false },
    '../lib/game-design': { defaultGameSpec, getGameLevels, updateAsteroidSettings }, '../lib/game-flow': { createPlatformerSpec }, '../lib/word-game-design': { defaultWordGameSpec }, '../lib/game-types': { isCooperativeGameSpec, isEndlessAsteroids }, './LevelFlowEditor': {}, './WordGameEditor': { wordGenreNames: { crossword: 'Crossword', 'word-search': 'Word search', 'mad-libs': 'Mad Libs' } }, './AsteroidPrizeEditor': {}, './AsteroidSpriteEditor': {}, './AsteroidChallengeEditor': {},
  };
  const source = readFileSync(new URL('../src/components/MultiGameEditor.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, require(name: string) { assert.ok(name in modules, name); return modules[name]; }, crypto: webcrypto, Uint32Array });
  function render() { cursor = 0; tree = exported.MultiGameEditor({ spec, library: [], disabled: false, dirty: true, revision: 0, save() {}, onChange(next: MultiGameSpec) { spec = next; changes.push(next); } }); }
  function palette(label: string) { const found = elements(tree).find(node => node.type === 'button' && text(node).trim().endsWith(`＋ ${label}`)); assert.ok(found, `Palette item: ${label}`); return found; }
  function rows() { return elements(tree).filter(node => node.type === 'li' && /(?:^| )step-(?:game|material|free-play)/.test(node.props.className ?? '')); }
  function stack() { return elements(tree).find(node => node.type === 'ol' && node.props.className === 'game-flow-stack')!; }
  function step(index: number) { return elements(rows()[index]).find(node => node.type === 'button' && node.props.className === 'game-flow-step')!; }
  function drag(source: Element, destination: Element) {
    const data = transfer(), start = event(data); source.props.onDragStart(start); assert.equal(start.prevented, false);
    const over = event(data); destination.props.onDragOver(over); assert.equal(over.prevented, true, 'The editor must accept its own active drag.');
    const drop = event(data); destination.props.onDrop(drop); assert.equal(drop.prevented, true); assert.equal(drop.stopped, true);
    source.props.onDragEnd?.(); render(); return data;
  }
  render(); return { palette, rows, stack, step, drag, render, changes, spec: () => spec };
}

test('native palette drag inserts a client object between games without changing either copied puzzle', () => {
  const ui = editor(), before = structuredClone(ui.spec().steps);
  const data = ui.drag(ui.palette('Client object'), ui.rows()[1]);
  assert.equal(data.effectAllowed, 'copy'); assert.equal(data.dropEffect, 'copy');
  assert.deepEqual(structuredClone(ui.spec().steps.map(step => step.type)), ['game', 'material', 'game']);
  assert.deepEqual(structuredClone(ui.spec().steps.filter(step => step.type === 'game')), before); validateMultiGameSpec(structuredClone(ui.spec()));
});

test('dragging games keeps a perpetual ending final, even when dropped after it', () => {
  const ui = editor(); ui.drag(ui.palette('Free play ending'), ui.rows()[0]);
  assert.equal(ui.spec().steps.at(-1)?.type, 'free-play'); assert.equal(ui.step(2).props.draggable, false);
  const firstId = ui.spec().steps[0].id, ending = structuredClone(ui.spec().steps.at(-1));
  ui.drag(ui.step(0), ui.stack());
  assert.equal(ui.spec().steps.at(-2)?.id, firstId); assert.deepEqual(structuredClone(ui.spec().steps.at(-1)), ending);
  ui.drag(ui.palette('Video'), ui.stack()); assert.equal(ui.spec().steps.at(-1)?.type, 'free-play'); assert.equal(ui.spec().steps.at(-2)?.type, 'material'); validateMultiGameSpec(structuredClone(ui.spec()));
});

test('foreign and replayed drops cannot mutate the multi-game journey', () => {
  const ui = editor(), before = structuredClone(ui.spec());
  for (const data of [transfer({ 'text/plain': 'add:content' }), transfer({ [mime]: JSON.stringify({ token: 'foreign', value: 'add:content' }) })]) {
    const over = event(data); ui.stack().props.onDragOver(over); assert.equal(over.prevented, false); ui.stack().props.onDrop(event(data)); ui.render();
    assert.equal(ui.changes.length, 0); assert.deepEqual(ui.spec(), before);
  }
  const data = ui.drag(ui.palette('Interactive object'), ui.stack()), changes = ui.changes.length, next = structuredClone(ui.spec());
  ui.stack().props.onDrop(event(data)); ui.render(); assert.equal(ui.changes.length, changes); assert.deepEqual(structuredClone(ui.spec()), next);
});

test('a cancelled drag revokes its token and move arrows change the same stable order', () => {
  const ui = editor(), data = transfer(), source = ui.palette('Client object'); source.props.onDragStart(event(data)); source.props.onDragEnd();
  ui.stack().props.onDrop(event(data)); assert.equal(ui.changes.length, 0);
  const firstId = ui.spec().steps[0].id;
  const later = elements(ui.rows()[0]).find(node => node.type === 'button' && node.props['aria-label'] === 'Move step 1 later')!;
  assert.equal(later.props.disabled, false); later.props.onClick(); ui.render(); assert.equal(ui.spec().steps[1].id, firstId); validateMultiGameSpec(structuredClone(ui.spec()));
});
