import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DrawingStream, type DrawingAction, type DrawingSendResult } from '../src/lib/drawing-stream';

type Element = { type: any; props: Record<string, any> };
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void; setup?: () => unknown };
const jsx = (type: any, props: Record<string, any>): Element => ({ type, props });
const all = (value: any): Element[] => Array.isArray(value) ? value.flatMap(all) : value && typeof value === 'object' && 'type' in value ? [value, ...all(value.props.children)] : [];
function board(send: (action: DrawingAction) => Promise<DrawingSendResult> = async () => 'accepted') {
  let hooks: Hook[] = [], cursor = 0, dirty = true, effects: Hook[] = [], tree: Element, time = 0, timerId = 0, uuid = 0, removed = false, lateUpdates = 0;
  const timers = new Map<number, { at: number; fn: () => void }>(), captures = new Set<number>(), requests: DrawingAction[] = [];
  const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 250 }), setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id), releasePointerCapture: (id: number) => captures.delete(id) };
  const react = {
    useState(initial: any) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, (next: any) => { if (removed) { lateUpdates++; return; } hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next; dirty = true; }]; },
    useRef(value: any) { const i = cursor++; hooks[i] ??= { value: { current: value } }; return hooks[i].value; },
    useMemo(factory: () => unknown, deps: unknown[]) { const i = cursor++; if (!hooks[i] || deps.some((value, j) => !Object.is(value, hooks[i].deps?.[j]))) hooks[i] = { value: factory(), deps }; return hooks[i].value; },
    useEffect(setup: () => unknown, deps: unknown[]) { const i = cursor++, prior = hooks[i]; if (!prior || deps.some((value, j) => !Object.is(value, prior.deps?.[j]))) { hooks[i] = { setup, deps, cleanup: prior?.cleanup }; effects.push(hooks[i]); } },
  };
  class TestStream extends DrawingStream { constructor(changed: () => void) { super(changed, { now: () => time, id: () => `segment-${++uuid}`, later: (fn, delay) => { timers.set(++timerId, { at: time + delay, fn }); return timerId; }, cancel: id => { timers.delete(id as number); } }); } }
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/SketchDrawingBoard.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require(name: string) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }; if (name === '../lib/drawing-stream') return { DrawingStream: TestStream }; throw new Error(name); }, Set, Math, Number });
  const props = { room: { roomId: 'room', phaseId: 1, game: { drawingEpoch: 0, strokes: [] as any[], drawingAckIds: [] as string[] } }, enabled: true, send: async (action: DrawingAction) => { requests.push(action); return send(action); } };
  function flush() { for (let i = 0; dirty && !removed; i++) { assert.ok(i < 20, 'render settled'); dirty = false; cursor = 0; effects = []; tree = exports.SketchDrawingBoard(props); svg().props.ref.current = canvas; for (const hook of effects) { hook.cleanup?.(); const cleanup = hook.setup!(); hook.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined; } } }
  const svg = () => all(tree).find(element => element.type === 'svg')!;
  function pointer(kind: string, x: number, y: number, id = 1, extras: Record<string, unknown> = {}) { let prevented = false; svg().props[kind]({ pointerId: id, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y, nativeEvent: {}, preventDefault() { prevented = true; }, ...extras }); flush(); return prevented; }
  async function advance(ms = 500) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } for (let i = 0; i < 10; i++) { await Promise.resolve(); flush(); } }
  flush(); return { pointer, advance, requests, captures, svg, ink: () => all(svg().props.children).filter(element => element.type === 'polyline' || element.type === 'circle'), update(patch: Partial<typeof props>) { Object.assign(props, patch); dirty = true; flush(); }, props, unmount() { for (const hook of hooks) hook.cleanup?.(); removed = true; }, lateUpdates: () => lateUpdates };
}

test('finger drag captures its pointer, draws immediately past 120 points, and shares while still held', async () => {
  const view = board(); assert.equal(view.svg().props.style.touchAction, 'none');
  assert.equal(view.pointer('onPointerDown', 30, 50), true); assert.equal(view.captures.has(1), true); assert.equal(view.ink()[0].type, 'circle');
  for (let i = 1; i <= 350; i++) view.pointer('onPointerMove', 30 + i, 100 + 40 * Math.sin(i));
  assert.ok(view.ink().length >= 3); assert.equal(view.requests.length, 0);
  await view.advance(); assert.equal(view.requests.length, 1); assert.equal(view.captures.has(1), true);
  view.pointer('onPointerUp', 390, 100); assert.equal(view.captures.size, 0); assert.ok(view.ink().length >= 3); view.unmount();
});
test('a delayed save never interrupts more finger strokes, second touches are ignored and cancel keeps existing ink', async () => {
  let resolve!: (value: DrawingSendResult) => void; const delayed = new Promise<DrawingSendResult>(yes => { resolve = yes; }), view = board(() => delayed);
  view.pointer('onPointerDown', 30, 50); view.pointer('onPointerUp', 80, 80); await view.advance();
  for (let i = 0; i < 10; i++) { view.pointer('onPointerDown', 50 + i, 100 + i); view.pointer('onPointerUp', 80 + i, 120 + i); }
  assert.equal(view.ink().length, 11); view.pointer('onPointerDown', 100, 100);
  assert.equal(view.pointer('onPointerDown', 390, 200, 2, { isPrimary: false }), false); assert.equal(view.captures.has(2), false);
  view.pointer('onPointerMove', 150, 150); view.pointer('onPointerCancel', 0, 0); assert.equal(view.captures.size, 0);
  const last = view.ink().at(-1)!; assert.equal(last.props.points.endsWith('280,260'), true); assert.equal(last.props.points.includes('0,0'), false);
  resolve('accepted'); await view.advance(); view.unmount();
});
test('phase transition releases touch capture and drops stale queued ink, and unmount cancels delayed completion', async () => {
  let resolve!: (value: DrawingSendResult) => void; const delayed = new Promise<DrawingSendResult>(yes => { resolve = yes; }), view = board(() => delayed);
  view.pointer('onPointerDown', 50, 50); view.pointer('onPointerMove', 100, 100); await view.advance();
  view.update({ room: { ...view.props.room, phaseId: 2 }, enabled: false }); assert.equal(view.captures.size, 0); assert.equal(view.ink().length, 0);
  assert.equal(view.pointer('onPointerDown', 50, 50), false); view.unmount(); resolve('retry'); await view.advance(); assert.equal(view.lateUpdates(), 0); assert.equal(view.requests.length, 1);
});
