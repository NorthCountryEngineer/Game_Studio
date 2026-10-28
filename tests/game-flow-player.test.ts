import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createPlatformerSpec } from '../src/lib/game-flow';
import { validateGameSpec } from '../src/lib/game-design';
import { aggregateFlowResults, type MaterialHandler } from '../src/lib/game-flow-session';
import type { ArcadeGameSpec, GameFlowNode, GameResult } from '../src/lib/game-types';

type Element = { type: unknown; props: Record<string, any> };
type Hook = { kind: 'state' | 'ref' | 'effect'; value?: any; deps?: unknown[]; cleanup?: (() => void); setup?: () => unknown };
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** A small hook runner exercises the actual component's state/effect boundary, without an iframe or renderer dependency. */
function mount(spec: ArcadeGameSpec, options: { handler?: MaterialHandler; strictEffects?: boolean } = {}) {
  let hooks: Hook[] = [], cursor = 0, dirty = true, tree: Element, firstCommit = true, pending: Hook[] = [];
  const completed: GameResult[] = [], progress: any[] = [];
  const react = {
    useState(initial: any) {
      const position = cursor++;
      hooks[position] ??= { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      return [hooks[position].value, (next: any) => { const value = typeof next === 'function' ? next(hooks[position].value) : next; if (!Object.is(value, hooks[position].value)) { hooks[position].value = value; dirty = true; } }];
    },
    useRef(initial: any) { const position = cursor++; hooks[position] ??= { kind: 'ref', value: { current: initial } }; return hooks[position].value; },
    useEffect(setup: () => unknown, deps: unknown[]) {
      const position = cursor++, previous = hooks[position];
      if (!previous || !deps || !previous.deps || deps.some((value, index) => !Object.is(value, previous.deps![index]))) {
        const effect: Hook = { kind: 'effect', deps, setup, cleanup: previous?.cleanup }; hooks[position] = effect; pending.push(effect);
      }
    },
  };
  const source = readFileSync(new URL('../src/components/LevelFlowPlayer.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const modules: Record<string, unknown> = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }, '../lib/game-design': { validateGameSpec }, '../lib/game-flow-session': { aggregateFlowResults }, './GamePlayer': { GameFrame: 'FRAME' } };
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, require(name: string) { assert.ok(name in modules, name); return modules[name]; }, crypto: webcrypto, performance, AbortController, Promise, Set });
  const props = { spec, onComplete: (value: GameResult) => completed.push(value), onFlowProgress: (value: any) => progress.push(value), onMaterialRequest: options.handler };
  // The public component supplies the internal run function as its React child.
  cursor = 0; const child = exported.LevelFlowPlayer(props) as Element;
  assert.equal(typeof child.type, 'function'); hooks = []; cursor = 0;
  const component = child.type as (props: Record<string, any>) => Element;
  function flush() {
    let turns = 0;
    while (dirty) {
      assert.ok(++turns < 30, 'The component must settle without a render loop.');
      dirty = false; cursor = 0; pending = []; tree = component(child.props);
      const effects = pending;
      for (const effect of effects) {
        effect.cleanup?.();
        const cleanup = effect.setup!(); effect.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined;
      }
      if (firstCommit && options.strictEffects) for (const effect of effects) {
        effect.cleanup?.(); const cleanup = effect.setup!(); effect.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined;
      }
      firstCommit = false;
    }
  }
  function button(label: string) { return elements(tree).find(node => node.type === 'button' && text(node) === label); }
  function click(label: string) { const control = button(label); assert.ok(control, `Expected button: ${label}`); assert.ok(!control.props.disabled, `Button is enabled: ${label}`); control.props.onClick(); flush(); }
  function frame() { const found = elements(tree).find(node => node.type === 'FRAME'); assert.ok(found, 'Expected the active isolated game frame.'); return found; }
  async function settle() { for (let count = 0; count < 12; count++) { await Promise.resolve(); flush(); } }
  flush();
  return { completed, progress, button, click, frame, flush, settle, content: () => text(tree), unmount() { for (const hook of hooks) if (hook.kind === 'effect') hook.cleanup?.(); } };
}
function game(nodes: GameFlowNode[], count = 2) {
  const spec = createPlatformerSpec(); spec.levels = spec.levels!.slice(0, count); spec.flow = { version: 1, nodes }; return spec;
}
const level = (position: number): GameFlowNode => ({ id: `step-${position}`, type: 'level', levelId: `level-${position}` });
const material = (required: boolean): GameFlowNode => ({ id: 'step-9', type: 'material', title: 'Client activity', kind: 'exercise', reference: 'client:exercise-1', required });
function result(spec: ArcadeGameSpec, id: string): GameResult { const found = spec.levels!.find(item => item.id === id)!; return { outcome: spec.levels!.length === 1 ? 'won' : 'level-complete', score: found.rules.goal, elapsed: 10, points: found.rules.goal * 10, reviewedLevelIds: [id] }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('a repeated iframe level result and repeated Finish click emit one combined completion', () => {
  const spec = game([level(1)], 1), run = mount(spec), report = run.frame().props.onComplete, value = result(spec, 'level-1');
  report(value); report(value); run.flush();
  assert.equal(run.completed.length, 1); assert.equal(run.completed[0].outcome, 'level-complete');
  const finish = run.button('Finish adventure')!; finish.props.onClick(); finish.props.onClick(); run.flush();
  assert.equal(run.completed.length, 2); assert.equal(run.completed.filter(item => item.outcome === 'won').length, 1);
  assert.equal(run.completed[1].points, value.points); assert.equal(run.progress.filter(item => item.status === 'won').length, 1);
  run.unmount();
});

test('required client material blocks the next level until the current handler fulfills', async () => {
  const spec = game([level(1), material(true), level(2)]), pending = deferred(); let requests = 0;
  const run = mount(spec, { handler: async () => { requests++; await pending.promise; } });
  run.frame().props.onComplete(result(spec, 'level-1')); run.flush(); run.click('Continue adventure'); await run.settle();
  assert.equal(requests, 1); assert.match(run.content(), /Complete this material in the connected application/);
  assert.equal(run.button('Skip optional material'), undefined); assert.equal(run.completed.filter(item => item.outcome === 'won').length, 0);
  assert.throws(() => run.frame());
  pending.resolve(); await run.settle(); assert.equal(run.frame().props.levelId, 'level-2');
  run.frame().props.onComplete(result(spec, 'level-2')); run.flush(); run.click('Finish adventure');
  assert.deepEqual(run.completed.at(-1)?.reviewedLevelIds, ['level-1', 'level-2']);
  assert.equal(run.progress.at(-1).materials[0].status, 'completed'); run.unmount();
});

test('an optional trailing activity delays full completion, and skipping aborts its pending request', async () => {
  const spec = game([level(1), material(false)], 1), pending = deferred(); let signal: AbortSignal | undefined;
  const run = mount(spec, { handler: async (_request, activeSignal) => { signal = activeSignal; await pending.promise; } });
  run.frame().props.onComplete(result(spec, 'level-1')); run.flush();
  assert.equal(run.completed.filter(item => item.outcome === 'won').length, 0);
  run.click('Continue adventure'); await run.settle(); assert.ok(signal); assert.equal(signal.aborted, false);
  assert.equal(run.completed.filter(item => item.outcome === 'won').length, 0);
  run.click('Skip optional material'); assert.equal(run.completed.filter(item => item.outcome === 'won').length, 1); assert.equal(signal.aborted, true);
  pending.resolve(); await run.settle(); assert.equal(run.completed.filter(item => item.outcome === 'won').length, 1);
  assert.equal(run.progress.at(-1).materials[0].status, 'skipped'); run.unmount();
});

test('home offers arbitrary unlocked practice without adding combined points or completion', () => {
  const spec = game([{ id: 'step-8', type: 'menu', title: 'World selection' }, level(1), level(2), level(3)], 3), run = mount(spec);
  run.click(`${spec.levels![2].title} · Practice`); assert.equal(run.frame().props.levelId, 'level-3');
  run.frame().props.onComplete(result(spec, 'level-3')); run.flush(); assert.match(run.content(), /Practice level complete/);
  assert.equal(run.completed.length, 0); run.click('Return to level home');
  assert.match(run.content(), /0 \/ 3 levels completed · 0 points/);
  run.click('Start full adventure'); assert.equal(run.frame().props.levelId, 'level-1'); assert.equal(run.completed.length, 0); run.unmount();
});

test('home gates later practice and defers its initial required material until full adventure starts', async () => {
  const spec = game([{ id: 'step-8', type: 'menu', title: 'My journey' }, material(true), level(1)], 1), pending = deferred(); let requests = 0;
  const run = mount(spec, { handler: async () => { requests++; await pending.promise; } }); await run.settle();
  assert.equal(requests, 0); assert.equal(run.button(`${spec.levels![0].title} · Locked`)?.props.disabled, true);
  run.click('Start full adventure'); await run.settle(); assert.equal(requests, 1);
  pending.resolve(); await run.settle(); assert.equal(run.frame().props.levelId, 'level-1'); run.unmount();
});

test('StrictMode effect rehearsal dispatches the initial material to the client once', async () => {
  const spec = game([material(true), level(1)], 1), pending = deferred(); let requests = 0;
  const run = mount(spec, { strictEffects: true, handler: async () => { requests++; await pending.promise; } });
  await run.settle(); assert.equal(requests, 1);
  pending.resolve(); await run.settle(); assert.equal(run.frame().props.levelId, 'level-1'); run.unmount();
});
