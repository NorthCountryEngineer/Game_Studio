import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { designArcadeGame } from '../src/lib/game-design';
import { setCooperativeMode } from '../src/lib/game-multiplayer-design';
import { isCooperativeGameSpec, type ArcadeGameSpec, type Game } from '../src/lib/game-types';
import * as versus from '../src/lib/game-versus';
import * as protocol from '../src/lib/game-multiplayer';

type Element = { type: any; props: Record<string, any> };
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void; setup?: () => unknown };
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'type' in value ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const GAME = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'A'.repeat(43), INVITE = 'B'.repeat(43), HASH = 'a'.repeat(64);
const binding = { game_id: GAME, published_revision: 2, spec_sha256: HASH };
const match = { mode: 'versus' as const, lives: 3, timeLimit: 120 };
const asteroid = (): ArcadeGameSpec => designArcadeGame('Asteroids. One level.').spec;
const game = (spec: ArcadeGameSpec): Game & { spec: ArcadeGameSpec } => ({ id: GAME, revision: 2, publishedRevision: 2, status: 'Published', spec, createdAt: '2026-11-04T12:00:00Z', updatedAt: '2026-11-04T12:00:00Z' });
function admission(seat: 0 | 1, config?: versus.VersusMatch) {
  return { roomId: ROOM, gameId: GAME, publishedRevision: 2, specSha256: HASH, expiresAt: Math.floor(Date.now() / 1000) + 1000, socketUrl: 'wss://relay.example/live', ...(seat === 0 ? { hostToken: TOKEN, inviteToken: INVITE } : { guestToken: TOKEN }), ...(config ? { match: config } : {}) };
}

/** Run the actual room/player component's state, async callbacks and effect
 * cleanup; only the network and sandbox physics are replaced. */
function mount(name: 'CooperativeGame' | 'CooperativePlayer', initial: Record<string, any>, options: { respond?: (body: any, path: string) => any } = {}) {
  let hooks: Hook[] = [], cursor = 0, dirty = true, tree: Element, effects: Hook[] = [], closed = false;
  let trackerCreations = 0, trackerObservations = 0, wire: any, timer = 0, connectionClosed = false;
  const requests: { path: string; method: string; body: any }[] = [], completions: any[] = [], posts: any[] = [], stateChecks: any[] = [], sentStates: any[] = [];
  const listeners = new Map<string, Set<(value: any) => void>>(), timers = new Map<number, () => void>();
  const frameWindow = { postMessage: (value: any) => posts.push(structuredClone(value)) };
  const react = {
    useState(initial: any) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, (next: any) => { assert.equal(closed, false, 'no state changes after unmount'); const value = typeof next === 'function' ? next(hooks[i].value) : next; if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; } }]; },
    useRef(initial: any) { const i = cursor++; hooks[i] ??= { value: { current: initial } }; return hooks[i].value; },
    useMemo(factory: () => unknown, deps: unknown[]) { const i = cursor++, old = hooks[i]; if (!old || deps.some((v, n) => !Object.is(v, old.deps![n]))) hooks[i] = { value: factory(), deps }; return hooks[i].value; },
    useEffect(setup: () => unknown, deps: unknown[]) { const i = cursor++, old = hooks[i]; if (!old || !deps || !old.deps || deps.some((v, n) => !Object.is(v, old.deps![n]))) { const hook = { setup, deps, cleanup: old?.cleanup }; hooks[i] = hook; effects.push(hook); } },
  };
  const browser = {
    location: { origin: 'https://games.example' },
    addEventListener: (name: string, listener: (event: any) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); },
    removeEventListener: (name: string, listener: (event: any) => void) => listeners.get(name)?.delete(listener),
    setTimeout: (fn: () => void) => { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id),
  };
  const modules: Record<string, any> = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'FRAGMENT' },
    '../lib/game-types': { isCooperativeGameSpec },
    '../lib/game-versus': { ...versus, validateVersusMatch: (value: unknown) => versus.validateVersusMatch(structuredClone(value)) },
    '../lib/game-cooperative': { cooperativeGameSandboxDocument: () => '<html>synthetic</html>', validateCooperativeState: (value: any, spec: ArcadeGameSpec, settings?: versus.VersusMatch) => { stateChecks.push({ value, spec, match: settings }); return value?.valid ? value : undefined; } },
    '../lib/cooperative-leaderboard': { createCooperativeLeaderboardTracker: () => { trackerCreations++; return { observe: () => { trackerObservations++; return { outcome: 'lost', elapsed: 1, score: 0, reviewedLevelIds: ['level-1'] }; } }; } },
    './PlayerSurface': { PlayerSurface: 'SURFACE' }, '../lib/core': { isCore: true }, '../lib/game-scoring': { createPublicationBinding: async () => binding }, '../lib/game-lobby': { watchMultiplayerLobbyEntry: () => () => {} },
    '../lib/game-multiplayer': {
      ...protocol, loadMultiplayerAPI: async () => 'https://relay.example', watchMultiplayerInvitations: () => () => {},
      multiplayerRequest: async (_base: string, path: string, method: string, body: any) => { requests.push({ path, method, body: structuredClone(body) }); if (method === 'DELETE') return {}; return options.respond ? options.respond(body, path) : admission(0, body.match); },
      connectMultiplayer: (_room: protocol.MultiplayerRoom, options: any) => { wire = options; return { close: () => { connectionClosed = true; }, sendInput() {}, sendState: (seq: number, state: any) => sentStates.push({ seq, state }) }; },
    },
  };
  const source = readFileSync(new URL('../src/components/CooperativePlayer.tsx', import.meta.url), 'utf8').replace('import.meta.env.VITE_MULTIPLAYER_API_URL', 'undefined');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exported: Record<string, any> = {};
  vm.runInNewContext(code, { exports: exported, require(name: string) { assert.ok(name in modules, name); return modules[name]; }, window: browser, crypto: webcrypto, navigator: { clipboard: { writeText: async () => {} } }, Error, Number, Object, Boolean, String, JSON, Date, Promise });
  const props = { ...initial, onComplete: (value: any) => completions.push(value), onStatus() {} };
  function flush() { let turns = 0; while (dirty && !closed) { assert.ok(++turns < 30); dirty = false; cursor = 0; effects = []; tree = exported[name](props); const frame = elements(tree).find(e => e.type === 'iframe'); if (frame) frame.props.ref.current = { contentWindow: frameWindow }; for (const effect of effects) { effect.cleanup?.(); const cleanup = effect.setup!(); effect.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined; } } }
  async function settle() { for (let i = 0; i < 20; i++) { await Promise.resolve(); flush(); } }
  function click(label: string) { const button = elements(tree).find(e => e.type === 'button' && text(e.props.children) === label); assert.ok(button, label); assert.equal(Boolean(button.props.disabled), false); button.props.onClick(); flush(); }
  function change(label: string, value: string) { const field = elements(tree).find(e => e.type === 'label' && text(e.props.children).startsWith(label)); assert.ok(field, label); const control = elements(field).find(e => e.type === 'select' || e.type === 'input'); assert.ok(control); control.props.onChange({ target: { value } }); flush(); }
  function submit() { const form = elements(tree).find(e => e.type === 'form'); assert.ok(form); form.props.onSubmit({ preventDefault() {} }); flush(); }
  function emit(data: any, source: unknown = frameWindow, origin = 'null') { listeners.get('message')?.forEach(fn => fn({ source, origin, data })); flush(); }
  function unmount() { hooks.forEach(hook => hook.cleanup?.()); closed = true; }
  flush();
  return { requests, completions, posts, stateChecks, sentStates, click, change, submit, settle, flush, emit, unmount, content: () => text(tree), elements: () => elements(tree), wire: () => wire, trackerCreations: () => trackerCreations, trackerObservations: () => trackerObservations, connectionClosed: () => connectionClosed, timers: () => timers.size };
}

test('solo Asteroids hosts a configured versus room without editing its published definition', async () => {
  const current = game(asteroid()), original = JSON.stringify(current.spec), view = mount('CooperativeGame', { game: current, children: 'SOLO' });
  assert.match(view.content(), /Solo or versus/); assert.match(view.content(), /Versus · shoot each other/); assert.doesNotMatch(view.content(), /Play together · no friendly fire/);
  view.change('Lives per player', '5'); view.change('Round length', '60'); view.click('Invite an opponent'); await view.settle();
  assert.deepEqual(view.requests[0].body.match, { mode: 'versus', lives: 5, timeLimit: 60 });
  assert.match(view.content(), /Versus · 5 lives each · 60-second round/); assert.match(view.content(), /do not submit solo scores/);
  const player = view.elements().find(e => typeof e.type === 'function' && e.type.name === 'CooperativePlayer'); assert.ok(player);
  assert.equal(player.props.spec, current.spec); assert.deepEqual(player.props.room.match, view.requests[0].body.match);
  assert.equal(JSON.stringify(current.spec), original);
  view.unmount(); await view.settle(); assert.equal(view.requests.at(-1)!.method, 'DELETE', 'host unmount closes its temporary room');
});

test('cooperative editions retain the default cooperation request and can explicitly switch to versus', async () => {
  const current = game(setCooperativeMode(asteroid(), true)), view = mount('CooperativeGame', { game: current, children: 'SOLO' });
  view.click('Invite a friend'); await view.settle(); assert.equal(Object.hasOwn(view.requests[0].body, 'match'), false);
  assert.doesNotMatch(view.content(), /Versus · 3 lives each/); view.unmount();
  const switched = mount('CooperativeGame', { game: current, children: 'SOLO' }); switched.change('Two-player mode', 'versus'); switched.click('Find an opponent'); await switched.settle();
  assert.equal(switched.requests[0].body.visibility, 'public'); assert.deepEqual(switched.requests[0].body.match, match); switched.unmount();
});

test('a host rejects changed match settings and closes the mismatched response room', async () => {
  const view = mount('CooperativeGame', { game: game(asteroid()), children: 'SOLO' }, { respond: () => admission(0, { ...match, lives: 5 }) });
  view.click('Invite an opponent'); await view.settle(); assert.match(view.content(), /match settings changed/);
  assert.equal(view.requests.length, 2); assert.equal(view.requests[1].method, 'DELETE'); assert.equal(view.elements().some(e => e.type?.name === 'CooperativePlayer'), false); view.unmount();
});

test('an eligible solo Asteroids guest joins a versus invitation with the server rules rather than local setup', async () => {
  const view = mount('CooperativeGame', { game: game(asteroid()), children: 'SOLO' }, { respond: () => admission(1, { ...match, lives: 1, timeLimit: 30 }) });
  view.click('Join using invitation'); view.change('Invitation link', `https://games.example/games/${GAME}#coop=${ROOM}.${INVITE}`); view.submit(); await view.settle();
  assert.equal(view.requests[0].path, `/multiplayer/rooms/${ROOM}/join`); assert.equal(Object.hasOwn(view.requests[0].body, 'match'), false);
  assert.match(view.content(), /Versus · 1 life each · 30-second round/); view.unmount(); assert.equal(view.requests.some(value => value.method === 'DELETE'), false, 'guest cleanup never ends the host room');
});

test('a solo-only Asteroids guest refuses a legacy cooperative admission', async () => {
  const view = mount('CooperativeGame', { game: game(asteroid()), children: 'SOLO' }, { respond: () => admission(1) });
  view.click('Join using invitation'); view.change('Invitation link', `https://games.example/games/${GAME}#coop=${ROOM}.${INVITE}`); view.submit(); await view.settle();
  assert.match(view.content(), /invalid room/); assert.equal(view.elements().some(e => e.type?.name === 'CooperativePlayer'), false); view.unmount();
});

test('versus parent binds original spec and room settings while isolating its terminal state from solo awards', () => {
  const spec = setCooperativeMode(asteroid(), true), room = protocol.validateMultiplayerRoom(admission(0, match), 0)!;
  const view = mount('CooperativePlayer', { spec, room });
  const load = view.posts.find(value => value.type === 'game-coop-load'); assert.ok(load); assert.deepEqual(load.match, match); assert.deepEqual(load.spec, spec);
  assert.equal(view.trackerCreations(), 0, 'versus does not create a campaign/solo result tracker');
  const nonce = load.nonce, state = { valid: true, outcome: 'finished', versus: { winner: 0, reason: 'elimination' } };
  view.emit({ type: 'game-coop-state', nonce, seq: 1, state }, {}, 'null'); assert.equal(view.sentStates.length, 0);
  view.emit({ type: 'game-coop-state', nonce, seq: 1, state }); assert.equal(view.sentStates.length, 1);
  view.wire().onState(1, state); assert.equal(view.completions.length, 0); assert.equal(view.trackerObservations(), 0);
  assert.ok(view.stateChecks.every(check => check.spec === spec && check.match === room.match));
  assert.match(view.content(), /cannot fire until protection ends/); view.unmount(); assert.equal(view.connectionClosed(), true); assert.equal(view.timers(), 0);
});
