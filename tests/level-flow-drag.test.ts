import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createPlatformerSpec, defaultGameFlow } from '../src/lib/game-flow';
import { getGameLevels, validateArcadeGameSpec } from '../src/lib/game-design';
import { isCooperativeGameSpec, type ArcadeGameSpec } from '../src/lib/game-types';

type Element = { type: unknown; props: Record<string, any> };
const mime = 'application/x-game-studio-flow';
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function transfer(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { effectAllowed: 'none', dropEffect: 'none', get types() { return [...values.keys()]; }, setData(type: string, value: string) { values.set(type, value); }, getData(type: string) { return values.get(type) ?? ''; } };
}
function event(dataTransfer: ReturnType<typeof transfer>) { return { dataTransfer, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; }
function editor(initial = createPlatformerSpec()) {
  let spec = initial, cursor = 0, tree: Element; const states: any[] = [], refs: any[] = [], changes: ArcadeGameSpec[] = [];
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: { useState(value: any) { const position = cursor++; if (!(position in states)) states[position] = value; return [states[position], (next: any) => { states[position] = typeof next === 'function' ? next(states[position]) : next; }]; }, useRef(value: any) { const position = cursor++; refs[position] ??= { current: value }; return refs[position]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }, './Confirm': { useConfirm: () => async () => false },
    '../lib/game-design': { getGameLevels }, '../lib/game-flow': { defaultGameFlow }, '../lib/game-types': { isCooperativeGameSpec },
  };
  const source = readFileSync(new URL('../src/components/LevelFlowEditor.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, require(name: string) { assert.ok(name in modules, name); return modules[name]; }, crypto: webcrypto, Uint32Array });
  function render() { cursor = 0; tree = exported.LevelFlowEditor({ spec, disabled: false, onChange(next: ArcadeGameSpec) { spec = next; changes.push(next); } }); }
  function palette(label: string) { const found = elements(tree).find(node => node.type === 'button' && text(node).trim().endsWith(`＋ ${label}`)); assert.ok(found, `Palette item: ${label}`); return found; }
  function rows() { return elements(tree).filter(node => node.type === 'li' && /(?:^| )step-(?:level|material|menu)/.test(node.props.className ?? '')); }
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

test('native drag event handlers insert palette material between levels and preserve their authored data', () => {
  const ui = editor(), before = structuredClone(ui.spec().levels);
  const data = ui.drag(ui.palette('Lesson'), ui.rows()[1]);
  assert.equal(data.effectAllowed, 'copy'); assert.equal(data.dropEffect, 'copy');
  const payload = JSON.parse(data.getData(mime)); assert.match(payload.token, /^[0-9a-f-]{36}$/); assert.equal(payload.value, 'add:lesson');
  assert.deepEqual(structuredClone(ui.spec().flow!.nodes.map(node => node.type)), ['level', 'material', 'level', 'level']);
  assert.equal(ui.spec().flow!.nodes[1].type, 'material'); assert.deepEqual(structuredClone(ui.spec().levels), before); validateArcadeGameSpec(structuredClone(ui.spec()));
});

test('dragging a saved step reorders stable level references and keeps the home pinned first', () => {
  const ui = editor(); ui.drag(ui.palette('Level home'), ui.stack());
  assert.equal(ui.spec().flow!.nodes[0].type, 'menu'); assert.equal(ui.step(0).props.draggable, false);
  const lastId = ui.spec().flow!.nodes.at(-1)!.id, before = structuredClone(ui.spec().levels);
  const data = ui.drag(ui.step(3), ui.rows()[0]);
  assert.equal(data.effectAllowed, 'move'); assert.equal(data.dropEffect, 'move');
  assert.equal(ui.spec().flow!.nodes[0].type, 'menu'); assert.equal(ui.spec().flow!.nodes[1].id, lastId);
  assert.deepEqual([...ui.spec().levels!].sort((a, b) => a.id.localeCompare(b.id)), [...before!].sort((a, b) => a.id.localeCompare(b.id)));
  ui.drag(ui.step(1), ui.stack()); assert.equal(ui.spec().flow!.nodes.at(-1)!.id, lastId); validateArcadeGameSpec(structuredClone(ui.spec()));
});

test('foreign text, forged custom MIME, and a replayed completed drag cannot mutate the flow', () => {
  const ui = editor(), original = structuredClone(ui.spec());
  for (const data of [transfer({ 'text/plain': 'add:lesson' }), transfer({ [mime]: 'add:lesson' }), transfer({ [mime]: JSON.stringify({ token: 'foreign', value: 'add:lesson' }) })]) {
    const over = event(data); ui.stack().props.onDragOver(over); assert.equal(over.prevented, false);
    ui.stack().props.onDrop(event(data)); ui.render(); assert.equal(ui.changes.length, 0); assert.deepEqual(ui.spec(), original);
  }
  const data = ui.drag(ui.palette('Video'), ui.stack()), after = structuredClone(ui.spec()), count = ui.changes.length;
  const replayOver = event(data); ui.stack().props.onDragOver(replayOver); assert.equal(replayOver.prevented, false);
  ui.stack().props.onDrop(event(data)); ui.render(); assert.equal(ui.changes.length, count); assert.deepEqual(structuredClone(ui.spec()), after);
});

test('ending a cancelled gesture revokes its payload before a later drop', () => {
  const ui = editor(), data = transfer(), source = ui.palette('Exercise'); source.props.onDragStart(event(data)); source.props.onDragEnd();
  const over = event(data); ui.stack().props.onDragOver(over); assert.equal(over.prevented, false);
  ui.stack().props.onDrop(event(data)); assert.equal(ui.changes.length, 0);
});
