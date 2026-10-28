import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createPlatformerSpec, defaultGameFlow } from '../src/lib/game-flow';
import { designGame, getGameLevels, validateGameSpec } from '../src/lib/game-design';
import { defaultMultiGameSpec } from '../src/lib/multi-game';
import { gameReviewLevelIds, type ArcadeGameSpec, type GameResult, type MultiGameSpec, type MultiGameStep, type SingleGameSpec } from '../src/lib/game-types';
import { aggregateMultiGameResults, multiGamePoints, type MultiGameProgress, type MultiGameResult, type MultiMaterialHandler } from '../src/lib/multi-game-session';
import type { FlowProgress } from '../src/lib/game-flow-session';
import { validateGameReview } from '../src/lib/game-review';

type Element = { type: unknown; props: Record<string, any> };
type Hook = { kind: 'state' | 'ref' | 'effect'; value?: any; deps?: unknown[]; cleanup?: (() => void); setup?: () => unknown };
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Only the nested game is mocked. The real composition component, validators,
 * aggregators, React state transitions, and effect cleanup run unchanged. */
function mount(spec: MultiGameSpec, options: { handler?: MultiMaterialHandler; strictEffects?: boolean; playtest?: boolean; stepId?: string } = {}) {
  let hooks: Hook[] = [], cursor = 0, dirty = true, tree: Element, firstCommit = true, pending: Hook[] = [], now = 1000;
  const completed: MultiGameResult[] = [], progress: MultiGameProgress[] = [], legacyCompleted: GameResult[] = [];
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
  const source = readFileSync(new URL('../src/components/MultiGamePlayer.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const modules: Record<string, unknown> = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'FRAGMENT' },
    '../lib/game-design': { validateGameSpec, getGameLevels }, '../lib/game-types': { gameReviewLevelIds },
    // The validator deliberately checks plain-object prototypes. Move VM-created
    // values across the test realm before calling the unchanged real validator.
    '../lib/multi-game-session': { aggregateMultiGameResults: (spec: MultiGameSpec, games: MultiGameResult['games'], materials: MultiGameResult['materials'], outcome: MultiGameResult['outcome'], wall: number) => aggregateMultiGameResults(structuredClone(spec), structuredClone(games), structuredClone(materials), outcome, wall), multiGamePoints }, './GamePlayer': { GamePlayer: 'GAME' },
  };
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, require(name: string) { assert.ok(name in modules, name); return modules[name]; }, crypto: webcrypto, performance: { now: () => now }, AbortController, Promise, Set, structuredClone });
  const props = { spec, playtest: options.playtest, stepId: options.stepId, onComplete: (value: GameResult) => legacyCompleted.push(structuredClone(value)), onMultiComplete: (value: MultiGameResult) => completed.push(structuredClone(value)), onMultiProgress: (value: MultiGameProgress) => progress.push(structuredClone(value)), onMultiMaterialRequest: options.handler ? (request: Parameters<MultiMaterialHandler>[0], signal: AbortSignal) => options.handler!(structuredClone(request), signal) : undefined };
  cursor = 0; const child = exported.MultiGamePlayer(props) as Element;
  assert.equal(typeof child.type, 'function'); hooks = []; cursor = 0;
  const component = child.type as (props: Record<string, any>) => Element;
  function flush() {
    let turns = 0;
    while (dirty) {
      assert.ok(++turns < 30, 'The composition must settle without a render loop.');
      dirty = false; cursor = 0; pending = []; tree = component(child.props);
      const effects = pending;
      for (const effect of effects) { effect.cleanup?.(); const cleanup = effect.setup!(); effect.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined; }
      if (firstCommit && options.strictEffects) for (const effect of effects) { effect.cleanup?.(); const cleanup = effect.setup!(); effect.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined; }
      firstCommit = false;
    }
  }
  function button(label: string) { return elements(tree).find(node => node.type === 'button' && text(node) === label); }
  function click(label: string) { const control = button(label); assert.ok(control, `Expected button: ${label}`); assert.ok(!control.props.disabled); control.props.onClick(); flush(); }
  function game() { const active = elements(tree).find(node => node.type === 'GAME'); assert.ok(active, 'Expected the active nested game.'); return active; }
  function find(type: string) { const found = elements(tree).find(node => node.type === type); assert.ok(found, `Expected ${type}`); return found; }
  async function settle() { for (let count = 0; count < 12; count++) { await Promise.resolve(); flush(); } }
  flush();
  return { completed, progress, legacyCompleted, button, click, game, find, flush, settle, content: () => text(tree), advanceTime(seconds: number) { now += seconds * 1000; }, unmount() { for (const hook of hooks) if (hook.kind === 'effect') hook.cleanup?.(); } };
}

function result(spec: SingleGameSpec, elapsed = 10): GameResult {
  const score = spec.version === 3 ? spec.genre === 'crossword' ? spec.puzzle.entries.length : spec.genre === 'word-search' ? spec.puzzle.words.length : spec.puzzle.blanks.length : getGameLevels(spec).reduce((sum, level) => sum + level.rules.goal, 0);
  return { outcome: 'won', elapsed, score, reviewedLevelIds: gameReviewLevelIds(spec), ...(spec.version === 7 || spec.version !== 3 && spec.arcade?.scoring ? { points: score * 10 } : {}) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const material = (id: string, required: boolean): MultiGameStep => ({ id, type: 'material', title: 'Client object', kind: 'interactive', reference: 'client:objects/one', required });
function withSteps(steps: MultiGameStep[]): MultiGameSpec { return { ...defaultMultiGameSpec(), steps }; }
const gameStep = (id: string, spec: SingleGameSpec): MultiGameStep => ({ id, type: 'game', spec });
const starterGame = () => defaultMultiGameSpec().steps[0] as Extract<MultiGameStep, { type: 'game' }>;

test('main games and required objects finish once before free play and freeze all finite totals', async () => {
  const defaults = defaultMultiGameSpec(), pending = deferred(); let requests = 0;
  const freePlay = designGame('Asteroids with endless survival.').spec as ArcadeGameSpec;
  const spec = withSteps([defaults.steps[0], material('step-3', true), defaults.steps[1], { id: 'step-4', type: 'free-play', spec: freePlay }]);
  const run = mount(spec, { handler: async () => { requests++; await pending.promise; } });
  const first = run.game().props, firstResult = result(first.spec, 11);
  first.onComplete(firstResult); first.onComplete(firstResult); run.flush();
  assert.equal(run.completed.length, 0); assert.match(run.content(), /1 \/ 2 games completed/);
  run.click('Continue journey'); await run.settle(); assert.equal(requests, 1);
  assert.equal(run.button('Skip optional object'), undefined); assert.throws(() => run.game());
  assert.equal(run.progress.at(-1)!.status, 'material'); assert.equal(run.progress.at(-1)!.activeStepId, 'step-3');
  run.advanceTime(9); pending.resolve(); await run.settle();
  const second = run.game().props, secondResult = result(second.spec, 14);
  assert.equal(second.spec.genre, 'word-search'); first.onComplete(firstResult); run.flush();
  second.onComplete(secondResult); second.onComplete(secondResult); run.flush();
  assert.equal(run.completed.length, 1); assert.equal(run.legacyCompleted.length, 0);
  const frozen = structuredClone(run.completed[0]);
  assert.equal(frozen.elapsed, 25); assert.equal(frozen.wallElapsed, 34); assert.equal(frozen.points, (firstResult.score + secondResult.score) * 10);
  assert.deepEqual(frozen.games.map(game => game.stepId), ['step-1', 'step-2']);
  assert.deepEqual(frozen.materials, [{ path: ['step-3'], status: 'completed', elapsed: 9 }]);
  assert.equal(run.progress.filter(item => item.status === 'completed').length, 1);
  run.click('Continue in free play'); assert.equal(run.game().props.spec.asteroids.endless, true);
  run.advanceTime(9000); run.game().props.onComplete({ outcome: 'lost', elapsed: 9000, points: 900000, score: 80, reviewedLevelIds: ['level-1'] }); run.flush();
  assert.equal(run.progress.at(-1)!.status, 'free-play'); assert.deepEqual(run.progress.at(-1)!.result, frozen);
  run.click('Return to journey summary');
  assert.equal(run.completed.length, 1); assert.deepEqual(run.completed[0], frozen);
  assert.equal(run.progress.filter(item => item.status === 'completed').length, 1); run.unmount();
});

test('trailing required client objects block full completion until client confirmation', async () => {
  const pending = deferred(), spec = withSteps([starterGame(), material('step-2', true)]);
  const run = mount(spec, { handler: async () => pending.promise });
  run.game().props.onComplete(result(run.game().props.spec)); run.flush();
  assert.equal(run.completed.length, 0); run.click('Continue journey'); await run.settle();
  assert.equal(run.completed.length, 0); assert.equal(run.button('Skip optional object'), undefined);
  pending.resolve(); await run.settle();
  assert.equal(run.completed.length, 1); assert.equal(run.completed[0].materials[0].status, 'completed'); run.unmount();
});

test('skipping the final optional object aborts its pending handler and ignores its late resolution', async () => {
  const pending = deferred(); let signal: AbortSignal | undefined;
  const run = mount(withSteps([starterGame(), material('step-2', false)]), { handler: async (_request, activeSignal) => { signal = activeSignal; await pending.promise; } });
  run.game().props.onComplete(result(run.game().props.spec)); run.flush(); run.click('Continue journey'); await run.settle();
  assert.ok(signal); assert.equal(signal.aborted, false); assert.equal(run.completed.length, 0);
  run.click('Skip optional object'); assert.equal(signal.aborted, true); assert.equal(run.completed.length, 1);
  const frozen = structuredClone(run.completed[0]); pending.resolve(); await run.settle();
  assert.equal(run.completed.length, 1); assert.deepEqual(run.completed[0], frozen); assert.equal(frozen.materials[0].status, 'skipped'); run.unmount();
});

test('StrictMode effect rehearsal dispatches an initial client object exactly once', async () => {
  const pending = deferred(); let requests = 0;
  const finite = starterGame(); finite.id = 'step-2';
  const run = mount(withSteps([material('step-1', true), finite]), { strictEffects: true, handler: async () => { requests++; await pending.promise; } });
  await run.settle(); assert.equal(requests, 1);
  pending.resolve(); await run.settle(); run.game().props.onComplete(result(run.game().props.spec)); run.flush();
  assert.equal(run.completed.length, 1); assert.equal(run.completed[0].materials[0].path[0], 'step-1'); run.unmount();
});

test('nested level flows bind terminal flow telemetry and route client objects with the full path', async () => {
  const child = createPlatformerSpec(); child.flow = defaultGameFlow(child);
  child.flow.nodes.splice(1, 0, { id: 'step-9', type: 'material', title: 'Nested object', kind: 'video', reference: 'client:nested/one', required: true });
  const requests: any[] = [], run = mount(withSteps([gameStep('step-4', child)]), { handler: async (request, signal) => { requests.push({ request, signal }); } });
  const player = run.game().props, won = result(child, 30);
  player.onComplete(won); run.flush(); assert.equal(run.completed.length, 0); assert.equal(run.game().props.spec.version, 7);
  const node = child.flow.nodes.find(node => node.type === 'material')!, signal = new AbortController().signal;
  await player.onMaterialRequest({ runId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', node }, signal);
  assert.deepEqual(requests[0].request.path, ['step-4', 'step-9']); assert.equal(requests[0].signal, signal);
  assert.notEqual(requests[0].request.runId, '11111111-1111-4111-8111-111111111111');
  const flow: FlowProgress = { runId: '11111111-1111-4111-8111-111111111111', status: 'won', completedLevelIds: gameReviewLevelIds(child), materials: [{ nodeId: 'step-9', status: 'completed', elapsed: 6 }], gameplayElapsed: 30, wallElapsed: 36, score: won.score, points: won.points };
  player.onFlowProgress({ ...flow, status: 'material' }); assert.equal(run.progress.at(-1)!.status, 'material');
  player.onFlowProgress(flow, won); player.onFlowProgress(flow, won); run.flush();
  assert.equal(run.completed.length, 1); assert.deepEqual(run.completed[0].games[0].flow, flow); assert.equal(run.completed[0].wallElapsed, 36); run.unmount();
});

test('selected private game previews require every child level before reviewing the outer step', () => {
  const child = createPlatformerSpec(), run = mount(withSteps([gameStep('step-7', child)]), { playtest: true, stepId: 'step-7' });
  assert.equal(run.game().props.playtest, true);
  for (const [index, level] of child.levels!.entries()) {
    run.find('select').props.onChange({ target: { value: level.id } }); run.flush();
    assert.equal(run.game().props.levelId, level.id);
    run.game().props.onComplete({ outcome: 'level-complete', elapsed: 10, score: level.rules.goal, points: level.rules.goal * 10, reviewedLevelIds: [level.id] }); run.flush();
    if (index < child.levels!.length - 1) assert.equal(run.progress.length, 0);
  }
  assert.deepEqual(run.progress.at(-1)!.reviewedStepIds, ['step-7']); assert.equal(run.completed.length, 0); assert.equal(run.legacyCompleted.length, 0); run.unmount();
});

test('private material previews require explicit review and never invoke or complete the client object', async () => {
  let requests = 0;
  const run = mount(withSteps([starterGame(), material('step-8', true)]), { playtest: true, stepId: 'step-8', handler: async () => { requests++; } });
  await run.settle(); assert.equal(requests, 0); assert.equal(run.progress.length, 0);
  run.click('Review this client object'); assert.deepEqual(run.progress.at(-1)!.reviewedStepIds, ['step-8']);
  assert.equal(requests, 0); assert.equal(run.completed.length, 0); assert.equal(run.progress.at(-1)!.status, 'playing'); run.unmount();
});

test('private nested-game preview also requires explicit inspection of its client object references', () => {
  const child = createPlatformerSpec(); child.flow = defaultGameFlow(child);
  child.flow.nodes.push({ id: 'step-9', type: 'material', title: 'Nested client object', kind: 'exercise', reference: 'client:nested/one', required: true });
  const run = mount(withSteps([gameStep('step-5', child)]), { playtest: true, stepId: 'step-5' });
  run.game().props.onComplete(result(child)); run.flush(); assert.equal(run.progress.length, 0);
  run.find('input').props.onChange({ target: { checked: true } }); run.flush();
  assert.deepEqual(run.progress.at(-1)!.reviewedStepIds, ['step-5']); assert.equal(run.completed.length, 0); run.unmount();
});

test('private final free-play preview accepts the validated five-second review event without a public result', () => {
  const endless = designGame('Asteroids with endless survival.').spec as ArcadeGameSpec;
  const run = mount(withSteps([starterGame(), { id: 'step-8', type: 'free-play', spec: endless }]), { playtest: true, stepId: 'step-8' });
  assert.equal(run.game().props.playtest, true); assert.match(run.content(), /five seconds/);
  assert.equal(validateGameReview({ elapsed: 4, reviewedLevelIds: ['level-1'] }, endless), undefined);
  const review = validateGameReview({ elapsed: 5, reviewedLevelIds: ['level-1'] }, endless)!; assert.ok(review);
  run.game().props.onReview(review); run.flush();
  assert.deepEqual(run.progress.at(-1)!.reviewedStepIds, ['step-8']); assert.equal(run.completed.length, 0); assert.equal(run.legacyCompleted.length, 0); run.unmount();
});
