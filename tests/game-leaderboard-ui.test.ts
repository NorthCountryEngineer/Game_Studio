import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultGameSpec, validateGameSpec } from '../src/lib/game-design';
import { createPlatformerSpec } from '../src/lib/game-flow';
import { setCooperativeMode } from '../src/lib/game-multiplayer-design';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../src/lib/multi-game';
import { aggregateMultiGameResults } from '../src/lib/multi-game-session';
import * as leaderboard from '../src/lib/game-leaderboard';
import type { Game, GameResult, GameSpec } from '../src/lib/game-types';
import type { GameScoreBoard, GameScoreReport } from '../src/lib/game-scores';

type Element = { type: any; props: Record<string, any> };
type Hook = { kind: 'state' | 'ref' | 'effect'; value?: any; deps?: unknown[]; cleanup?: (() => void); setup?: () => unknown };
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const result = (points = 100): GameResult => ({ outcome: 'lost', elapsed: 2, score: 0, reviewedLevelIds: ['level-1'], points });
const arcade = () => validateGameSpec({ ...defaultGameSpec(), genre: 'dodge', theme: 'space', arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: false } });
const game = (spec: GameSpec = arcade()): Game => ({ id: '11111111-1111-4111-8111-111111111111', revision: 2, publishedRevision: 2, status: 'Published', createdAt: '2026-10-23T12:00:00Z', updatedAt: '2026-10-23T12:00:00Z', spec });
const empty = (ranking: GameScoreBoard['ranking'] = 'points'): GameScoreBoard => ({ scope: 'shared', ranking, publishedRevision: 2, limit: 10, entries: [] });
const run = (points = 100, id = 'run-1') => ({ id, result: result(points) });
const full = (): GameScoreBoard => ({ ...empty(), entries: Array.from({ length: 10 }, (_, index) => ({ name: `N${index}`, points: 1000 - index * 100, elapsed: 2, createdAt: '2026-10-23T12:00:00Z' })) });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

/** Exercise actual component state/effects and callbacks without an iframe or live service. */
function mount(name: 'GameHighScores' | 'PublishedGame', initial: Record<string, any>, options: { read?: () => Promise<GameScoreBoard>; save?: (value: GameScoreReport) => Promise<GameScoreBoard>; connected?: boolean } = {}) {
  let hooks: Hook[] = [], cursor = 0, dirty = true, tree: Element, pending: Hook[] = [], props = initial, unmounted = false, lateSetters = 0;
  const reads: Game[] = [], reports: GameScoreReport[] = [], events: unknown[] = [];
  const react = {
    useState(initial: any) {
      const position = cursor++; hooks[position] ??= { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      return [hooks[position].value, (next: any) => { if (unmounted) lateSetters++; const value = typeof next === 'function' ? next(hooks[position].value) : next; if (!Object.is(value, hooks[position].value)) { hooks[position].value = value; dirty = true; } }];
    },
    useRef(initial: any) { const position = cursor++; hooks[position] ??= { kind: 'ref', value: { current: initial } }; return hooks[position].value; },
    useEffect(setup: () => unknown, deps: unknown[]) {
      const position = cursor++, previous = hooks[position];
      if (!previous || !deps || !previous.deps || deps.some((value, index) => !Object.is(value, previous.deps![index]))) { const effect: Hook = { kind: 'effect', deps, setup, cleanup: previous?.cleanup }; hooks[position] = effect; pending.push(effect); }
    },
  };
  const source = readFileSync(new URL('../src/components/Games.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const modules: Record<string, unknown> = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }, '../lib/game-types': { isCooperativeGameSpec: (spec: GameSpec) => spec.version !== 3 && spec.version !== 8 && Boolean(spec.multiplayer), isEndlessAsteroids: (spec: GameSpec) => spec.version === 6 && Boolean(spec.asteroids?.endless) },
    '../lib/game-api': {}, './GamePlayer': { GamePlayer: 'PLAYER' }, './CooperativePlayer': { CooperativeGame: 'COOPERATIVE' }, './MultiplayerLobby': {}, './MafiaCategoryCard': {}, './AsteroidPrizeEditor': {}, '../lib/game-design': {}, './ItemActions': {}, './Confirm': {},
    '../lib/core': { isCore: options.connected ?? true }, '../lib/game-scores': { getGameScores: async (value: Game) => { reads.push(value); return options.read ? options.read() : empty(leaderboard.leaderboardRanking(value.spec)); }, submitGameScore: async (_game: Game, value: GameScoreReport) => { reports.push(value); return options.save ? options.save(value) : { ...empty(), qualified: true }; } },
    '../lib/game-leaderboard': leaderboard, '../lib/branding': {}, './ServiceBadge': {}, './WordGameEditor': {},
  };
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, require(module: string) { assert.ok(module in modules, module); return modules[module]; }, crypto: webcrypto, Set, JSON, Error });
  if (name === 'PublishedGame' && !props.onGameEvent) props = { ...props, onGameEvent: (value: unknown) => events.push(value) };
  function flush() {
    let turns = 0;
    while (dirty && !unmounted) {
      assert.ok(++turns < 30, 'Component settles without a render loop.'); dirty = false; cursor = 0; pending = []; tree = exported[name](props);
      for (const effect of pending) { effect.cleanup?.(); const cleanup = effect.setup!(); effect.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined; }
    }
  }
  async function settle() { for (let count = 0; count < 12; count++) { await Promise.resolve(); flush(); } }
  function find(type: string) { return elements(tree).find(value => value.type === type); }
  function setName(value: string) { const field = find('input'); assert.ok(field, 'A qualifying result offers a name field.'); field.props.onChange({ target: { value } }); flush(); }
  function submit() { const form = find('form'); assert.ok(form); form.props.onSubmit({ preventDefault() {} }); flush(); }
  function update(next: Record<string, any>) { props = { ...props, ...next }; dirty = true; flush(); }
  function markup() {
    function render(value: any, path = 'root'): any { if (Array.isArray(value)) return value.map((item, index) => render(item, `${path}-${index}`)); if (!value || typeof value !== 'object' || !('type' in value)) return value; const { children, ...rest } = value.props; return createElement(value.type === 'FRAGMENT' ? 'div' : value.type, { ...rest, key: path }, render(children, `${path}-child`)); }
    return renderToStaticMarkup(render(tree));
  }
  function unmount() { for (const hook of hooks) if (hook.kind === 'effect') hook.cleanup?.(); unmounted = true; }
  flush();
  return { reads, reports, events, settle, flush, find, setName, submit, update, markup, content: () => text(tree), elements: () => elements(tree), unmount, lateSetters: () => lateSetters };
}

test('every player renders its board outside the cooperative switch and terminal results alone set a run', () => {
  const current = game(setCooperativeMode(arcade(), true)), view = mount('PublishedGame', { game: current, signed: false });
  const cooperative = view.find('COOPERATIVE'); assert.ok(cooperative);
  const board = view.elements().find(value => typeof value.type === 'function' && value.type.name === 'GameHighScores'); assert.ok(board);
  assert.equal(elements(cooperative).some(value => value === board), false, 'the board remains mounted when live play replaces solo children');
  cooperative.props.onComplete(result(0)); view.flush();
  assert.equal(view.elements().find(value => value.type === board.type)!.props.run.result.points, 0); assert.equal(view.events.length, 0);
  for (const spec of [defaultWordGameSpec('crossword'), defaultWordGameSpec('word-search'), defaultWordGameSpec('mad-libs'), createPlatformerSpec(), defaultMultiGameSpec(), defaultGameSpec()]) {
    const other = mount('PublishedGame', { game: game(spec), signed: false }); assert.ok(other.elements().find(value => typeof value.type === 'function' && value.type.name === 'GameHighScores')); other.unmount();
  }
  view.unmount();
});

test('word completion and finite multi-game aggregation feed scores without changing SDK events', () => {
  const word = defaultWordGameSpec('word-search'), view = mount('PublishedGame', { game: game(word), signed: false });
  const observed = { outcome: 'won', elapsed: 10, score: word.puzzle.words.length, reviewedLevelIds: ['level-1'] };
  view.find('PLAYER')!.props.onComplete(observed); view.flush();
  const board = view.elements().find(value => typeof value.type === 'function' && value.type.name === 'GameHighScores')!;
  assert.equal(board.props.run.result.elapsed, 10); assert.equal(view.events.length, 1); assert.equal((view.events[0] as any).type, 'completed'); view.unmount();
  const spec = defaultMultiGameSpec(), multi = mount('PublishedGame', { game: game(spec), signed: false });
  const children = spec.steps.filter(step => step.type === 'game').map(step => { assert.equal(step.spec.version, 3); const child = step.spec; return { stepId: step.id, result: { outcome: 'won' as const, elapsed: 10, score: child.genre === 'crossword' ? child.puzzle.entries.length : child.genre === 'word-search' ? child.puzzle.words.length : child.puzzle.blanks.length, reviewedLevelIds: ['level-1'] } }; });
  const combined = aggregateMultiGameResults(spec, children, [], 'won', 20); assert.ok(combined);
  const player = multi.find('PLAYER')!; player.props.onComplete(children[0].result); multi.flush();
  assert.equal(multi.elements().find(value => typeof value.type === 'function' && value.type.name === 'GameHighScores')!.props.run, undefined);
  player.props.onMultiComplete(combined); multi.flush();
  assert.equal(multi.elements().find(value => typeof value.type === 'function' && value.type.name === 'GameHighScores')!.props.run.result.points, combined.points);
  assert.equal(multi.events.length, 0, 'outer multi-progress keeps its existing separate SDK contract'); multi.unmount();
});

test('the current top ten controls prompting and each completed run refreshes the board', async () => {
  const view = mount('GameHighScores', { game: game(), run: run(50) }, { read: async () => full() });
  assert.equal(view.find('form'), undefined); await view.settle();
  assert.equal(view.find('form'), undefined); assert.match(view.content(), /Earn more points to make the top 10/);
  view.update({ run: run(150, 'run-2') }); assert.equal(view.find('form'), undefined); await view.settle();
  assert.ok(view.find('form')); assert.equal(view.reads.length, 2); assert.match(view.content(), /No sign-in needed/); assert.doesNotMatch(view.content(), /Sign in to|This browser.*button/);
  view.unmount();
});

test('a racing server rejection is explicit and duplicate submit gestures send only one request', async () => {
  const pending = deferred<GameScoreBoard>(), view = mount('GameHighScores', { game: game(), run: run() }, { save: () => pending.promise });
  await view.settle(); view.setName(' é🙂<>& '); view.submit(); view.submit();
  assert.equal(view.reports.length, 1); assert.equal(view.reports[0].name, 'é🙂<>&');
  pending.resolve({ ...full(), qualified: false }); await view.settle();
  assert.match(view.content(), /board changed before your result was saved/); assert.equal(view.find('form'), undefined); view.unmount();
});

test('shared failures retain the run and stable request for retry without a login or browser fallback', async () => {
  let attempt = 0;
  const view = mount('GameHighScores', { game: game(), run: run() }, { save: async () => { if (++attempt === 1) throw new Error('Temporarily unavailable'); return { ...empty(), qualified: true }; } });
  await view.settle(); view.setName('x'.repeat(9)); view.submit(); await view.settle(); assert.equal(view.reports.length, 0); assert.match(view.content(), /1–8 printable/);
  view.setName('Pilot'); view.submit(); await view.settle(); assert.match(view.content(), /Temporarily unavailable/); assert.ok(view.find('form'));
  view.submit(); await view.settle(); assert.equal(view.reports.length, 2); assert.equal(view.reports[0].requestId, view.reports[1].requestId); assert.match(view.content(), /shared top 10/); assert.equal(view.find('form'), undefined); view.unmount();
});

test('public names render as escaped text and time boards display precise seconds', async () => {
  const current = game(defaultWordGameSpec('crossword'));
  const view = mount('GameHighScores', { game: current }, { read: async () => ({ ...empty('time'), entries: [{ name: '<script>', elapsed: 10.25, createdAt: '2026-10-23T12:00:00Z' }] }) });
  await view.settle(); assert.match(view.content(), /Fastest completions/); assert.match(view.content(), /10.25/); assert.match(view.markup(), /&lt;script&gt;/); assert.doesNotMatch(view.markup(), /<script>/); assert.equal(view.find('form'), undefined); view.unmount();
});

test('unmounts and a later round prevent stale asynchronous results from replacing current UI', async () => {
  const pending = deferred<GameScoreBoard>(), view = mount('GameHighScores', { game: game(), run: run() }, { save: () => pending.promise });
  await view.settle(); view.setName('Pilot'); view.submit();
  view.update({ run: run(200, 'run-2') }); await view.settle();
  pending.resolve({ ...empty(), qualified: true }); await view.settle();
  assert.doesNotMatch(view.content(), /Your result is on the shared/); assert.match(view.content(), /200 points/); assert.ok(view.find('form')); view.unmount();
  const read = deferred<GameScoreBoard>(), removed = mount('GameHighScores', { game: game() }, { read: () => read.promise }); removed.unmount(); read.resolve(empty()); await removed.settle(); assert.equal(removed.lateSetters(), 0);
});


test('an uncertain submission followed by a renamed retry keeps the same request identity', async () => {
  let attempt = 0;
  const view = mount('GameHighScores', { game: game(), run: run() }, { save: async () => { if (++attempt === 1) throw new Error('The response was lost.'); throw new Error('This request was already used for another nickname.'); } });
  await view.settle(); view.setName('First'); view.submit(); await view.settle();
  view.setName('Second'); view.submit(); await view.settle();
  assert.equal(view.reports.length, 2); assert.equal(view.reports[0].requestId, view.reports[1].requestId);
  assert.equal(view.reports[0].name, 'First'); assert.equal(view.reports[1].name, 'Second');
  assert.match(view.content(), /already used for another nickname/); assert.ok(view.find('form')); view.unmount();
});
