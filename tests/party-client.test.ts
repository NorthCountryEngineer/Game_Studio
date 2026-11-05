import * as roomPassphrases from '../src/lib/room-passphrases';
import * as sketchRecognition from '../src/lib/sketch-recognition-scheduler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PartyPlayerName, partyPlayerLabel } from '../src/components/PartyPlayerName';

const ROOM = '11111111-1111-4111-8111-111111111111', OWNER = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'a'.repeat(43), INVITE = 'b'.repeat(43);
const catalog = JSON.parse(readFileSync(new URL('../config/party-games.json', import.meta.url), 'utf8'));
function fixture(overrides: Record<string, any> = {}) { return { version: 1, roomId: ROOM, kind: 'hand-duel', hostId: OWNER, status: 'lobby', phase: 'lobby', phaseId: 0, round: 0, createdAt: 1800000000, deadlineAt: null, settings: { maxPlayers: 2, rounds: 5, roundSeconds: 45 }, players: [{ id: OWNER, name: 'Nova', avatar: 'fox', score: 0, alive: true }, { id: OTHER, name: 'Pip', avatar: 'frog', score: 0, alive: true }], self: { id: OWNER, isHost: true, alive: true, actionSequence: 0 }, game: {}, winner: null, events: [], chat: [], ...overrides }; }
function storage() { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); }, data }; }
const transpile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
function library(options: { connected?: boolean; api?: string; fetch?: typeof fetch; store?: ReturnType<typeof storage> } = {}) {
  const store = options.store ?? storage(), mafia: Record<string, any> = {}, exported: Record<string, any> = {}, core = { isCore: options.connected ?? false, coreConfig: { api_url: options.api ?? 'https://games-api.example' } };
  const globals = { localStorage: store, URL, URLSearchParams, Set, Error, JSON, AbortController, AbortSignal, setTimeout, clearTimeout, crypto: webcrypto, Uint8Array, btoa, fetch: options.fetch ?? fetch };
  vm.runInNewContext(transpile('../src/lib/mafia.ts'), { ...globals, exports: mafia, require(name: string) { if (name === './room-passphrases') return roomPassphrases; assert.equal(name, './core'); return core; } });
  vm.runInNewContext(transpile('../src/lib/party.ts'), { ...globals, exports: exported, require(name: string) { if (name === './room-passphrases') return roomPassphrases; if (name === './core') return core; if (name === './mafia') return mafia; if (name === '../../config/party-games.json') return catalog; throw new Error(name); } });
  return { api: exported, mafia, store };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test('the party catalog contains Mafia and five original games with two dedicated duels', () => { const { api } = library(); assert.equal(api.PARTY_GAMES.length, 6); assert.equal(api.PARTY_GAMES.filter((g: any) => g.minPlayers === 2 && g.maxPlayers === 2).length, 2); assert.equal(api.isPartyKind('mafia'), false); assert.equal(api.isPartyKind('starship-suspects'), true); assert.equal(api.isPartyKind('other'), false); });
test('party capabilities are independent 256-bit values and exact same-origin fragment links', () => { const { api } = library(), secret = api.createPartySecret(), other = api.createPartySecret(); assert.match(secret, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(secret, other); const link = api.partyInvitation('https://games.example', { roomId: ROOM, playerId: OWNER, token: TOKEN, inviteToken: INVITE }); assert.equal(link, `https://games.example/party/rooms/${ROOM}#join=${INVITE}`); assert.equal(new URL(link).search, ''); assert.equal(link.includes(TOKEN), false); assert.equal(api.parsePartyInvitation(link, 'https://games.example').inviteToken, INVITE); for (const bad of [link.replace('games.example', 'wrong.example'), link + '&extra=1', link.replace('#', '?tracking=1#'), link.replace(INVITE, 'tiny'), link.replace('rooms/', '')]) assert.equal(api.parsePartyInvitation(bad, 'https://games.example'), undefined); });
test('party sessions reject cross-room and cross-seat responses and preserve own capability only', () => { const { api } = library(), s = { roomId: ROOM, playerId: OWNER, token: TOKEN, inviteToken: INVITE }; api.savePartySession(s); assert.equal(api.readPartySession(ROOM).token, TOKEN); assert.equal(api.readPartySession(OTHER), undefined); assert.equal(api.parsePartyEnvelope({ room: fixture(), session: s }, true).session.token, TOKEN); for (const session of [undefined, { ...s, roomId: OTHER }, { ...s, playerId: OTHER }]) assert.throws(() => api.parsePartyEnvelope({ room: fixture(), session }, true), /unsupported response/); api.forgetPartySession(ROOM); assert.equal(api.readPartySession(ROOM), undefined); });
test('bounded party parsing discards unknown top-level state and rejects malformed seat identity', () => { const { api } = library(), r = fixture(); const p = api.parsePartyRoom({ ...r, roles: { [OTHER]: 'impostor' }, _game: { answers: ['secret'] }, passphraseEnabled: true, passphraseHash: 'private-hash', passphrase: 'purple comet' }); assert.equal('roles' in p, false); assert.equal('_game' in p, false); assert.equal(p.passphraseEnabled, true); assert.equal('passphraseHash' in p, false); assert.equal('passphrase' in p, false); for (const patch of [{ players: [...r.players, r.players[0]] }, { self: { ...r.self, id: ROOM } }, { self: { ...r.self, actionSequence: -1 } }, { kind: 'unknown' }, { status: 'unknown' }, { passphraseEnabled: 'true' }, { game: { x: ['x'.repeat(2100)] } }, { settings: { rounds: -1 } }]) assert.throws(() => api.parsePartyRoom({ ...r, ...patch }), /unsupported response/); });
test('pending admissions retain exact request and secrets across reload in separate game namespaces', () => { const { api } = library(), a = { path: '/party/rooms', body: { requestId: ROOM, name: 'Nova', avatar: 'fox', playerToken: TOKEN, inviteToken: INVITE, kind: 'hand-duel', settings: { maxPlayers: 2, rounds: 5, roundSeconds: 45 } } }; api.savePartyAdmission('hand-duel', a); assert.equal(JSON.stringify(api.readPartyAdmission('hand-duel')), JSON.stringify(a)); assert.equal(api.readPartyAdmission('trivia'), undefined); assert.throws(() => api.savePartyAdmission('trivia', a), /unsupported response/); api.clearPartyAdmission('hand-duel'); assert.equal(api.readPartyAdmission('hand-duel'), undefined); });
test('party requests omit cookies/Core tokens and reject non-room request paths', async () => { const calls: any[] = [], { api } = library({ connected: true, fetch: async (url, init) => { calls.push({ url, init }); return new Response('{}'); } }); await api.partyRequest('/party/config'); await api.partyRequest(`/party/rooms/${ROOM}`, 'GET', undefined, TOKEN); assert.equal(calls[0].url, 'https://games-api.example/party/config'); assert.equal(calls[0].init.headers.Authorization, undefined); assert.equal(calls[1].url, `https://games-api.example/party/rooms/${ROOM}?sketchRecognition=1`); assert.equal(calls[1].init.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(calls[1].init.credentials, 'omit'); assert.equal(calls[1].init.redirect, 'error'); await assert.rejects(api.partyRequest('/session'), /valid party-game/); await assert.rejects(api.partyRequest(`/party/rooms/${ROOM}`, 'GET', undefined, 'bad'), /seat is invalid/); assert.equal(library().api.partyAPIBase(), '/party-api'); });
test('party errors and cancellation retain clear recoverable feedback', async () => { const { api } = library({ fetch: async () => new Response(JSON.stringify({ error: 'Room is full.' }), { status: 409 }) }); await assert.rejects(api.partyRequest('/party/config'), /Room is full/); const controller = new AbortController(); controller.abort(); let signal: AbortSignal | undefined; const cancelled = library({ fetch: async (_url, init) => { signal = init?.signal as AbortSignal; throw new DOMException('Aborted', 'AbortError'); } }).api; await assert.rejects(cancelled.partyRequest('/party/config', 'GET', undefined, undefined, controller.signal), /Aborted/); assert.equal(signal?.aborted, true); });

test('recognition acknowledgments bind the exact ink context and cannot contain a room projection', async () => {
  const target = { roomId: ROOM, phaseId: 7, drawingEpoch: 2, inkSha256: 'a'.repeat(64) }, { api } = library(), value = { version: 1, ...target, status: 'ready', retryAfterMs: 3000 };
  for (const status of ['ready', 'cached', 'busy', 'stale', 'idle', 'unavailable']) assert.equal(api.parsePartyRecognitionAck({ ...value, status }, target).status, status);
  assert.equal(api.parsePartyRecognitionAck({ ...value, status: 'unavailable', retryAfterMs: 10000 }, target).retryAfterMs, 10000);
  for (const patch of [{ version: 2 }, { roomId: OTHER }, { phaseId: 8 }, { drawingEpoch: 3 }, { inkSha256: 'b'.repeat(64) }, { status: 'guessed' }, { retryAfterMs: 1 }, { retryAfterMs: 10000 }, { room: fixture() }, { actionSequence: 99 }]) assert.throws(() => api.parsePartyRecognitionAck({ ...value, ...patch }, target), /unsupported response/);
  const calls: any[] = [], connected = library({ connected: true, fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(value)); } }).api, controller = new AbortController();
  await connected.partyRequest(`/party/rooms/${ROOM}/recognition`, 'POST', target, TOKEN, controller.signal); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.priority, 'low'); assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(calls[0].url, `https://games-api.example/party/rooms/${ROOM}/recognition`);
  await assert.rejects(connected.partyRequest(`/party/rooms/${ROOM}/recognition`, 'GET', undefined, TOKEN), /recognition request/); await assert.rejects(connected.partyRequest(`/party/rooms/${ROOM}/recognition`, 'POST', target), /recognition request/); assert.equal(calls.length, 1);
});

type Element = { type: any; props: Record<string, any> };
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void; setup?: () => unknown };
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const content = (value: any): string => Array.isArray(value) ? value.map(content).join('') : value && typeof value === 'object' && 'type' in value ? content(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function mount(options: { clock?: () => number; kind?: string; roomId?: string; href?: string; fetch?: typeof fetch; session?: Record<string, string>; admission?: Record<string, any>; library?: boolean } = {}) {
  const store = storage(), { api, mafia } = library({ store, fetch: options.fetch ?? (async () => new Response('{}', { status: 503 })) }); if (options.session) api.savePartySession(options.session); if (options.admission) api.savePartyAdmission(options.roomId ?? options.kind!, options.admission);
  let hooks: Hook[] = [], cursor = 0, dirty = true, tree: Element, effects: Hook[] = [], unmounted = false, lateSetters = 0, timerId = 0; const intervals = new Map<number, () => void>(), timers = new Map<number, () => void>(), navigated: string[] = [];
  const react = { useState(initial: any) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, (next: any) => { if (unmounted) { lateSetters++; return; } const value = typeof next === 'function' ? next(hooks[i].value) : next; if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; } }]; }, useRef(initial: any) { const i = cursor++; hooks[i] ??= { value: { current: initial } }; return hooks[i].value; }, useEffect(setup: () => unknown, deps: unknown[]) { const i = cursor++, prior = hooks[i]; if (!prior || !deps || !prior.deps || deps.some((v, index) => !Object.is(v, prior.deps![index]))) { const hook = { setup, deps, cleanup: prior?.cleanup }; hooks[i] = hook; effects.push(hook); } } };
  const runtimeDate = options.clock ? class extends Date { static now() { return options.clock!(); } } : Date;
  const exported: Record<string, any> = {}, browser = { location: { origin: 'http://127.0.0.1:5193', href: options.href ?? `http://127.0.0.1:5193/party/${options.roomId ? 'rooms/' + options.roomId : options.kind ?? ''}` }, setInterval: (fn: () => void) => { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval: (id: number) => intervals.delete(id), setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) };
  vm.runInNewContext(transpile('../src/components/PartyGames.tsx'), { exports: exported, require(name: string) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }; if (name === '../lib/sketch-recognition-scheduler') return sketchRecognition; if (name === '../lib/room-passphrases') return roomPassphrases; if (name === '../lib/party') return api; if (name === '../lib/sketch-recognition-scheduler') return sketchRecognition; if (name === '../lib/room-passphrases') return roomPassphrases; if (name === '../lib/mafia') return mafia; if (name === './PartyInstructions') return { PartyInstructions: () => null }; if (name === './PartyPlayerName') return { PartyPlayerName, partyPlayerLabel }; if (name === './SketchDrawingBoard') return { SketchDrawingBoard: () => jsx('svg', { 'aria-label': 'Shared drawing canvas' }) }; if (name === '../party.css') return {}; throw new Error(name); }, window: browser, document: { visibilityState: 'visible' }, navigator: { clipboard: { writeText: async () => {} } }, crypto: webcrypto, AbortController, DOMException, Date: runtimeDate, Promise, JSON, Error, Number, Object, String, Boolean, Set, Math });
  function flush() { let turns = 0; while (dirty && !unmounted) { assert.ok(++turns < 40); dirty = false; cursor = 0; effects = []; const outer = exported.PartyGamesPage({ kind: options.kind, roomId: options.roomId, navigate: (path: string) => { navigated.push(path); } }); tree = typeof outer.type === 'function' ? outer.type(outer.props) : outer; for (const hook of effects) { hook.cleanup?.(); const cleanup = hook.setup!(); hook.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined; } } }
  async function settle() { for (let i = 0; i < 45; i++) { await Promise.resolve(); flush(); } }
  function field(id: string) { return elements(tree).find(e => e.props.id === id); } function button(label: string) { return elements(tree).find(e => e.type === 'button' && content(e.props.children).includes(label)); }
  function change(id: string, value: string) { const input = field(id); assert.ok(input, id); input.props.onChange({ target: { value } }); flush(); } function submit() { const form = elements(tree).find(e => e.type === 'form'); assert.ok(form); form.props.onSubmit({ preventDefault() {} }); flush(); } function click(label: string) { const b = button(label); assert.ok(b, label); assert.equal(b.props.disabled ?? false, false, label); b.props.onClick(); flush(); }
  function markup(element = tree) { function render(value: any, key = 'r'): any { if (Array.isArray(value)) return value.map((v, i) => render(v, key + i)); if (!value || typeof value !== 'object' || !('type' in value)) return value; if (typeof value.type === 'function') return render(value.type(value.props), key + 'f'); const { children, ...props } = value.props; return createElement(value.type === 'FRAGMENT' ? 'div' : value.type, { ...props, key }, render(children, key + 'c')); } return renderToStaticMarkup(render(element)); }
  function unmount() { for (const hook of hooks) hook.cleanup?.(); unmounted = true; }
  flush(); return { api, exported, store, settle, field, button, change, submit, click, navigated, markup, stage: () => elements(tree).find(element => element.type === exported.PartyGameStage)?.props, content: () => content(tree), unmount, lateSetters: () => lateSetters, tick: () => { for (const fn of intervals.values()) fn(); flush(); }, poll: () => { const tasks = [...timers]; timers.clear(); for (const [, fn] of tasks) fn(); } };
}

test('party library offers online and in-person play for all six games without a login gate', async () => { const view = mount(); await view.settle(); for (const game of catalog.games) assert.match(view.content(), new RegExp(game.title)); assert.match(view.content(), /No sign-in to play/); assert.equal((view.markup().match(/Host in person/g) ?? []).length, 6); assert.equal((view.markup().match(/Play online/g) ?? []).length, 6); view.unmount(); });
test('Drugs & Decision-Making is available from the public party library as a shared-screen board game', async () => { const view = mount(); await view.settle(); assert.match(view.content(), /10th Grade Health/); assert.match(view.content(), /4 teams/); view.click('Create a health review'); assert.equal(view.navigated[0], '/party/quiz-circuit'); view.unmount(); });
test('online setup starts with a disabled create button and a choice of twenty avatars', async () => { const view = mount({ kind: 'hand-duel' }); await view.settle(); assert.ok(view.field('party-player-name')); assert.equal(view.button('Create a private room')!.props.disabled, true); assert.match(view.content(), /Automatic rules & scoring/); assert.match(view.content(), /Host in person instead/); assert.equal(view.field('party-rounds'), undefined); view.unmount(); });

test('party hosts can set a passphrase while preserving exact uncertain creation without persisting it', async () => {
  const calls: any[] = []; const view = mount({ kind: 'hand-duel', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body); if (calls.length === 1) return new Response(JSON.stringify({ error: 'Temporary failure' }), { status: 503 });
    return new Response(JSON.stringify({ room: fixture({ roomId: body.requestId, hostId: body.requestId, passphraseEnabled: true, players: [{ id: body.requestId, name: body.name, avatar: body.avatar, score: 0 }], self: { id: body.requestId, isHost: true, actionSequence: 0 } }), session: { roomId: body.requestId, playerId: body.requestId, token: body.playerToken, inviteToken: body.inviteToken } }));
  } });
  await view.settle(); view.change('party-player-name', 'Nova'); view.change('party-room-passphrase', ' Purple   Comet '); view.submit(); await view.settle(); assert.equal(calls[0].passphrase, 'purple comet'); assert.equal(view.store.data.size, 0); assert.equal(view.api.readPartyAdmission('hand-duel'), undefined); assert.match(view.content(), /Keep this tab open/); assert.equal(view.button('Join with passphrase')!.props.disabled, true);
  view.submit(); await view.settle(); assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1])); assert.match(view.content(), /Passphrase joining is enabled/); assert.doesNotMatch(view.content(), /purple comet|Purple/); assert.ok([...view.store.data.values()].every(value => !value.includes('comet'))); view.unmount();
});

test('all five party landing pages join by phrase with exact game identity and no invitation or room ID', async () => {
  for (const entry of catalog.games.filter((game: any) => game.id !== 'mafia')) {
    const calls: any[] = []; const view = mount({ kind: entry.id, fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push({ url, body }); if (calls.length === 1) return new Response(JSON.stringify({ error: 'Temporary failure' }), { status: 503 });
      return new Response(JSON.stringify({ room: fixture({ kind: entry.id, passphraseEnabled: true, players: [fixture().players[0], { id: body.requestId, name: body.name, avatar: body.avatar, score: 0 }], self: { id: body.requestId, isHost: false, actionSequence: 0 } }), session: { roomId: ROOM, playerId: body.requestId, token: body.playerToken } }));
    } });
    await view.settle(); view.click('Join with passphrase'); assert.equal(view.field('party-rounds'), undefined); view.change('party-player-name', 'Orbit'); view.change('party-room-passphrase', 'PURPLE comet'); view.submit(); await view.settle();
    assert.equal(calls[0].url, '/party-api/party/join-by-passphrase'); assert.equal(calls[0].body.kind, entry.id); assert.equal(calls[0].body.passphrase, 'purple comet'); assert.equal(calls[0].body.inviteToken, undefined); assert.equal(calls[0].body.settings, undefined); assert.equal(view.store.data.size, 0); assert.equal(view.field('party-room-passphrase')!.props.disabled, true);
    view.submit(); await view.settle(); assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1])); assert.equal(view.navigated[0], `/party/rooms/${ROOM}`); assert.equal(view.api.readPartySession(ROOM).inviteToken, undefined); view.unmount();
  }
});

test('party passphrase errors unlock entry and mismatched game responses never save a seat', async () => {
  let attempts = 0; const view = mount({ kind: 'hand-duel', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); if (++attempts === 1) return new Response(JSON.stringify({ error: 'No open room matches that passphrase.' }), { status: 404 });
    return new Response(JSON.stringify({ room: fixture({ kind: 'trivia', players: [fixture().players[0], { id: body.requestId, name: body.name, avatar: body.avatar, score: 0 }], self: { id: body.requestId, isHost: false, actionSequence: 0 } }), session: { roomId: ROOM, playerId: body.requestId, token: body.playerToken } }));
  } });
  await view.settle(); view.click('Join with passphrase'); view.change('party-player-name', 'Orbit'); view.change('party-room-passphrase', 'purple comet'); view.submit(); await view.settle(); assert.equal(view.field('party-room-passphrase')!.props.disabled, false); assert.equal(view.button('Create a room')!.props.disabled, false);
  view.submit(); await view.settle(); assert.match(view.content(), /did not match your requested seat/); assert.equal(view.api.readPartySession(ROOM), undefined); assert.equal(view.store.data.size, 0); assert.equal(view.navigated.length, 0); view.unmount();
});

test('unknown party phrase creation and joins expire without silently entering a replacement room', async () => {
  for (const joining of [false, true]) {
    let clock = Date.now(); const calls: any[] = [], view = mount({ kind: 'hand-duel', clock: () => clock, fetch: async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return new Response('{"error":"Lost response"}', { status: 503 }); } });
    await view.settle(); if (joining) view.click('Join with passphrase'); view.change('party-player-name', 'Orbit'); view.change('party-room-passphrase', 'purple comet'); view.submit(); await view.settle();
    clock += 299999; view.tick(); view.submit(); await view.settle(); assert.equal(calls.length, 2); assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1]));
    clock += 1; view.tick(); assert.equal(view.button('Retry the same request')!.props.disabled, true); view.submit(); await view.settle(); assert.equal(calls.length, 2); assert.match(view.content(), /too old to retry safely/);
    view.click('Start over'); assert.equal(calls.length, 2); assert.equal(view.field('party-room-passphrase')!.props.value, ''); assert.equal(view.field('party-room-passphrase')!.props.disabled, false); view.change('party-room-passphrase', 'purple comet'); view.submit(); await view.settle(); assert.equal(calls.length, 3); assert.notEqual(calls[0].requestId, calls[2].requestId); assert.equal(view.store.data.size, 0); view.unmount();
  }
});
test('trivia and drawing allow round settings while fixed-rule games keep their exact match settings', async () => { for (const kind of ['trivia', 'sketch-guess', 'hand-duel', 'drop-four', 'starship-suspects']) { const view = mount({ kind }); await view.settle(); assert.equal(Boolean(view.field('party-rounds')), ['trivia', 'sketch-guess'].includes(kind)); view.unmount(); } });
test('uncertain party admission retries the same request and secrets instead of creating another room', async () => { const calls: any[] = []; const view = mount({ kind: 'hand-duel', fetch: async (_url, init) => { const b = JSON.parse(String(init?.body)); calls.push(b); if (calls.length === 1) return new Response(JSON.stringify({ error: 'Temporary failure' }), { status: 503 }); return new Response(JSON.stringify({ room: fixture({ roomId: b.requestId, hostId: b.requestId, players: [{ id: b.requestId, name: b.name, avatar: b.avatar, score: 0 }], self: { id: b.requestId, isHost: true, actionSequence: 0 } }), session: { roomId: b.requestId, playerId: b.requestId, token: b.playerToken, inviteToken: b.inviteToken } })); } }); await view.settle(); view.change('party-player-name', 'Nova'); view.submit(); await view.settle(); assert.match(view.content(), /Temporary failure/); assert.equal(view.field('party-player-name')!.props.disabled, true); view.submit(); await view.settle(); assert.equal(calls.length, 2); assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1])); assert.equal(calls[0].settings.rounds, 5); assert.equal(view.navigated[0], `/party/rooms/${calls[0].requestId}`); assert.equal(view.api.readPartySession(calls[0].requestId).token, calls[0].playerToken); view.unmount(); });
test('definitive join errors unlock the nickname rather than trapping guests on an exact retry', async () => { const view = mount({ roomId: ROOM, href: `http://127.0.0.1:5193/party/rooms/${ROOM}#join=${INVITE}`, fetch: async () => new Response(JSON.stringify({ error: 'Choose another name.' }), { status: 409 }) }); await view.settle(); view.change('party-player-name', 'Nova'); view.submit(); await view.settle(); assert.match(view.content(), /Choose another name/); assert.equal(view.field('party-player-name')!.props.disabled, false); assert.equal(view.api.readPartyAdmission(ROOM), undefined); view.unmount(); });
test('saved party seats reconnect without a second admission and reject another player projection', async () => { let room = fixture(); const reports: any[] = []; const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => { if (init?.method === 'POST') { reports.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ room: fixture({ self: { id: OTHER, isHost: false, actionSequence: 1 } }) })); } return new Response(JSON.stringify({ room })); } }); await view.settle(); assert.equal(reports.length, 0); view.click('Start the game'); await view.settle(); assert.match(view.content(), /does not match your saved seat/); assert.match(view.content(), /Your people are gathering/); view.unmount(); });
test('party actions carry phase and monotonic sequence and preserve identity on uncertain retry', async () => { const calls: any[] = [], room = fixture(); const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => { if (init?.method === 'POST') { const b = JSON.parse(String(init.body)); calls.push(b); if (calls.length === 1) return new Response(JSON.stringify({ error: 'A response was lost.' }), { status: 503 }); return new Response(JSON.stringify({ room: fixture({ status: 'playing', phase: 'choose', phaseId: 1, round: 1, self: { ...room.self, actionSequence: b.sequence }, game: { selectedIds: [], choices: {}, targetWins: 3, result: null } }) })); } return new Response(JSON.stringify({ room })); } }); await view.settle(); view.click('Start the game'); await view.settle(); assert.match(view.content(), /Retry the same action/); view.click('Retry the same action'); await view.settle(); assert.equal(calls.length, 2); assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1])); assert.equal(calls[0].sequence, 1); assert.equal(calls[0].phaseId, 0); assert.match(calls[0].requestId, /^[0-9a-f-]{36}$/); assert.doesNotMatch(view.content(), /Retry the same action/); view.unmount(); });
test('a pending party poll and a mutation never send concurrent requests', async () => { const delayed = deferred<Response>(); let polls = 0, count = 0, maximum = 0; const calls: any[] = [], room = fixture(); const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => { count++; maximum = Math.max(maximum, count); try { if (init?.method === 'POST') { calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ room: fixture({ status: 'playing', phase: 'choose', phaseId: 1, round: 1, self: { ...room.self, actionSequence: 1 }, game: { selectedIds: [], choices: {}, targetWins: 3, result: null } }) })); } if (++polls === 2) return await delayed.promise; return new Response(JSON.stringify({ room })); } finally { count--; } } }); await view.settle(); view.poll(); await view.settle(); view.click('Start the game'); await view.settle(); assert.equal(calls.length, 0); delayed.resolve(new Response(JSON.stringify({ room }))); await view.settle(); assert.equal(calls.length, 1); assert.equal(maximum, 1); view.unmount(); });
test('unmounting party rooms prevents late response state updates', async () => { const delayed = deferred<Response>(), view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async () => delayed.promise }); await view.settle(); view.unmount(); delayed.resolve(new Response(JSON.stringify({ room: fixture() }))); await view.settle(); assert.equal(view.lateSetters(), 0); });
test('party names and room messages render as literal text', async () => { const room = fixture({ status: 'playing', phase: 'choose', round: 1, players: fixture().players.map((p, i) => ({ ...p, name: i ? p.name : '<script>' })), game: { selectedIds: [], choices: {}, result: null, targetWins: 3 }, chat: [{ id: 'c1', playerId: OTHER, text: '<img src=x onerror=alert(1)>', at: 1800000000 }] }), view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async () => new Response(JSON.stringify({ room })) }); await view.settle(); const markup = view.markup(); assert.match(markup, /&lt;script&gt;/); assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<script>|<img src=x/); view.unmount(); });

test('actual offline API projections for all five games parse and render across full matches', () => {
  const source = `import json,sys\nsys.path.insert(0,'tests')\nfrom test_party_api import PartyAPITests,uuid\nfrom nce_api import party_engine as e\nviews=[]\nfor kind in e.GAMES:\n t=PartyAPITests()\n t.setUp()\n try:\n  settings={'rounds':1} if kind in ('trivia','sketch-guess') else {}\n  t.create(kind=kind,settings=settings)\n  for i in range(2,e.GAMES[kind]['minPlayers']+1):t.join(i)\n  def snap():\n   for pid in list(t.sessions):views.append(t.get(pid))\n  snap()\n  t.action(t.room_id,'start');snap()\n  ids=list(t.sessions)\n  if kind=='hand-duel':\n   for n in range(3):\n    t.action(ids[0],'choose',choice='rock');t.action(ids[1],'choose',choice='scissors');snap()\n    if n<2:t.action(t.room_id,'advance')\n  elif kind=='drop-four':\n   for i,c in enumerate([0,1,0,1,0,1,0]):t.action(ids[i%2],'drop',column=c)\n  elif kind=='trivia':\n   for pid in ids:t.action(pid,'answer',answer=0)\n   snap();t.clock+=7;t.get()\n  elif kind=='sketch-guess':\n   prompt=t.get(ids[0])['self']['prompt'];t.action(ids[1],'guess',text=prompt);snap();t.clock+=7;t.get()\n  else:\n   roles=t.state()['game']['_game']['roles'];impostor=next(pid for pid,r in roles.items() if r=='impostor')\n   t.action(ids[0],'emergency')\n   for pid in ids:t.action(pid,'ready')\n   for pid in ids:t.action(pid,'vote',targetId=impostor)\n  snap();t.action(t.room_id,'restart');snap();t.action(t.room_id,'close');snap()\n finally:t.doCleanups()\nprint(json.dumps(views))`;
  const rooms = JSON.parse(execFileSync('python3', ['-c', source], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'backend' }, maxBuffer: 8_000_000 }));
  const { api } = library(), view = mount({ kind: 'hand-duel' });
  assert.equal(new Set(rooms.map((r: any) => r.kind)).size, 5);
  for (const value of rooms) { const room = api.parsePartyRoom(value); assert.equal(room.roomId, value.roomId); assert.equal(room.self.actionSequence, value.self.actionSequence); if (room.status === 'playing' || room.status === 'finished') { const stage = view.exported.PartyGameStage({ room, disabled: false, now: 1000000, act: async () => true }); const markup = view.markup(stage); assert.ok(markup.length > 100); assert.doesNotMatch(markup, /undefined/); } }
  view.unmount();
});

test('a known 429 action rejection releases the controls for a fresh attempt', async () => {
  const calls: any[] = [], room = fixture();
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ room }));
    const b = JSON.parse(String(init.body)); calls.push(b);
    if (calls.length === 1) return new Response(JSON.stringify({ error: 'Wait a moment before moving again.' }), { status: 429 });
    return new Response(JSON.stringify({ room: fixture({ status: 'playing', phase: 'choose', phaseId: 1, round: 1, self: { ...room.self, actionSequence: 1 }, game: { selectedIds: [], choices: {}, targetWins: 3, result: null } }) }));
  } });
  await view.settle(); view.click('Start the game'); await view.settle();
  assert.match(view.content(), /Wait a moment/); assert.doesNotMatch(view.content(), /Retry the same action/); assert.equal(view.button('Start the game')!.props.disabled, false);
  view.click('Start the game'); await view.settle(); assert.equal(calls.length, 2); assert.notEqual(calls[0].requestId, calls[1].requestId); assert.equal(calls[0].sequence, calls[1].sequence); view.unmount();
});
test('Starship movement, tasks and repairs wait for the caller’s authoritative cooldown only', () => {
  const { api, mafia } = library(), exported: Record<string, any> = {};
  vm.runInNewContext(transpile('../src/components/PartyGames.tsx'), { exports: exported, require(name: string) {
    if (name === 'react') return { useState: () => [true, () => {}], useEffect: () => {}, useRef: (value: any) => ({ current: value }) };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'FRAGMENT' };
    if (name === '../lib/sketch-recognition-scheduler') return sketchRecognition; if (name === '../lib/room-passphrases') return roomPassphrases; if (name === '../lib/party') return api; if (name === '../lib/sketch-recognition-scheduler') return sketchRecognition; if (name === '../lib/room-passphrases') return roomPassphrases; if (name === '../lib/mafia') return mafia; if (name === './PartyInstructions') return { PartyInstructions: () => null }; if (name === './PartyPlayerName') return { PartyPlayerName, partyPlayerLabel }; if (name === './SketchDrawingBoard') return { SketchDrawingBoard: () => jsx('svg', { 'aria-label': 'Shared drawing canvas' }) }; if (name === '../party.css') return {}; throw new Error(name);
  }, Math, Date, Number, String, Object, Boolean });
  const room = fixture({ kind: 'starship-suspects', status: 'playing', phase: 'roaming', round: 1, self: { ...fixture().self, role: 'crew', room: 'reactor', moveReadyAt: 101, taskReadyAt: 101, tasks: [{ id: 't1', room: 'reactor', label: 'Restore power', sequence: ['■', '★', '●'], progress: 1, complete: false }], teammateIds: [], emergencyAvailable: true }, game: { rooms: [{ id: 'reactor', title: 'Reactor', neighbors: ['bridge'], x: 0, y: 0 }, { id: 'bridge', title: 'Bridge', neighbors: ['reactor'], x: 1, y: 1 }], positions: [{ id: OWNER, room: 'reactor', alive: true }], bodies: [], tasksCompleted: 0, tasksTotal: 9, sabotage: { room: 'reactor', deadlineAt: 150, progress: 1 } } });
  for (const now of [100, 101]) {
    const tree = exported.Starship({ room, disabled: false, now, act: async () => true }), all = elements(tree), bridge = all.find(e => e.type === 'button' && content(e.props.children).includes('Bridge'))!, repair = all.find(e => e.type === 'button' && content(e.props.children).includes('Repair step'))!, symbols = all.filter(e => e.type === 'button' && e.props['aria-label']?.startsWith('Task symbol'));
    assert.equal(bridge.props.disabled, now < 101); assert.equal(repair.props.disabled, now < 101); assert.equal(symbols.length, 4); assert.ok(symbols.every(e => e.props.disabled === (now < 101)));
    assert.equal(content(tree).includes('Ready for the next step in a moment'), now < 101);
    const meeting = all.find(e => e.type === 'button' && content(e.props.children) === 'Call a meeting')!; assert.equal(meeting.props.disabled, false);
  }
});

test('Starship final scoreboard shows earned points after keeping scores hidden during the mission', async () => {
  const base = fixture({ kind: 'starship-suspects', phase: 'roaming', status: 'playing', round: 1, players: fixture().players.map((player, index) => ({ ...player, score: index ? 0 : 50 })), self: { ...fixture().self, role: 'crew', room: 'bridge', tasks: [], teammateIds: [] }, game: { rooms: [{ id: 'bridge', title: 'Bridge', x: 0, y: 0, neighbors: [] }], positions: [], bodies: [], tasksCompleted: 1, tasksTotal: 9, sabotage: null, votedIds: [], readyIds: [] } });
  for (const status of ['playing', 'finished']) {
    const room = { ...base, status, phase: status === 'finished' ? 'finished' : 'roaming', winner: status === 'finished' ? 'crew' : null };
    const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async () => new Response(JSON.stringify({ room })) });
    await view.settle(); const markup = view.markup(); assert.equal(markup.includes('<b>50</b>'), status === 'finished'); assert.equal(markup.includes('<b>●</b>'), status === 'playing'); view.unmount();
  }
});


test('drawing transport shares room sequencing, keeps exact unknown retries and cannot overlap another mutation', async () => {
  const calls: any[] = [], pending = deferred<Response>(); let delayed = false;
  const room = fixture({ kind: 'sketch-guess', status: 'playing', phase: 'draw', phaseId: 1, round: 1, game: { artistId: OWNER, strokes: [], drawingEpoch: 0, drawingAckIds: [], guessedIds: [] } });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ room }));
    const body = JSON.parse(String(init.body)); calls.push(body);
    if (calls.length === 1) return new Response(JSON.stringify({ error: 'Lost response.' }), { status: 503 });
    if (delayed) return pending.promise;
    room.self.actionSequence = body.sequence;
    room.game.drawingAckIds.push(...(body.segments ?? []).map((segment: any) => segment.id));
    return new Response(JSON.stringify({ room }));
  } });
  await view.settle();
  const first = { type: 'drawing-batch', drawingEpoch: 0, segments: [{ id: OTHER, color: '#244b50', width: 5, points: [[.1, .1], [.2, .2]] }] };
  const second = { ...first, segments: [{ ...first.segments[0], id: ROOM }] };
  const send = () => view.stage()!.sendDrawing;
  assert.equal(await send()(first), 'retry'); await view.settle();
  assert.equal(await send()(second), 'retry'); assert.equal(calls.length, 1);
  assert.equal(await send()(JSON.parse(JSON.stringify(first))), 'accepted'); await view.settle();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1])); assert.equal(calls[1].sequence, 1);
  delayed = true; const saving = send()(second); await view.settle(); assert.equal(calls.length, 3);
  assert.equal(await send()({ ...first, segments: [] }), 'retry'); assert.equal(calls.length, 3);
  room.self.actionSequence = 2; room.game.drawingAckIds.push(ROOM); pending.resolve(new Response(JSON.stringify({ room })));
  assert.equal(await saving, 'accepted'); await view.settle(); assert.equal(calls[2].sequence, 2); view.unmount();
});

test('a blocked recognition request never pauses drawing posts, takes the action lock or replaces room state', async () => {
  const delayed = deferred<Response>(), recognitionCalls: any[] = [], drawingCalls: any[] = [], base = fixture(); let recognitionSignal: AbortSignal | undefined;
  const room = fixture({ kind: 'sketch-guess', status: 'playing', phase: 'draw', phaseId: 1, round: 1, players: base.players.map((player, index) => ({ ...player, ...(index ? { isAI: true } : {}) })), game: { artistId: OWNER, strokes: [{ id: OTHER, playerId: OWNER, color: '#244b50', width: 5, points: [[.1, .1], [.2, .2]] }], drawingEpoch: 0, drawingAckIds: [], inkSha256: 'a'.repeat(64) } });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (url, init) => {
    if (String(url).endsWith('/recognition')) { recognitionCalls.push(JSON.parse(String(init?.body))); recognitionSignal = init?.signal as AbortSignal; return delayed.promise; }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); drawingCalls.push(body); room.self.actionSequence = body.sequence;
      if (body.type === 'drawing-batch') { room.game.drawingAckIds.push(...body.segments.map((segment: any) => segment.id)); room.game.inkSha256 = 'b'.repeat(64); }
      if (body.type === 'clear-drawing') { room.game.drawingEpoch++; room.game.strokes = []; delete room.game.inkSha256; }
    }
    return new Response(JSON.stringify({ room }));
  } });
  await view.settle(); view.poll(); await view.settle(); assert.equal(recognitionCalls.length, 1); assert.deepEqual(recognitionCalls[0], { phaseId: 1, drawingEpoch: 0, inkSha256: 'a'.repeat(64) });
  const segment = { id: ROOM, color: '#244b50', width: 5, points: [[.2, .2], [.3, .3]] };
  assert.equal(await view.stage()!.sendDrawing({ type: 'drawing-batch', drawingEpoch: 0, segments: [segment] }), 'accepted'); await view.settle(); assert.equal(view.stage()!.disabled, false);
  assert.equal(await view.stage()!.sendDrawing({ type: 'drawing-batch', drawingEpoch: 0, segments: [{ ...segment, id: OWNER }] }), 'accepted'); await view.settle(); assert.deepEqual(drawingCalls.map(call => call.sequence), [1, 2]); assert.equal(recognitionCalls.length, 1); assert.equal(recognitionSignal?.aborted, false);
  assert.equal(await view.stage()!.sendDrawing({ type: 'clear-drawing', drawingEpoch: 0 }), 'accepted'); await view.settle(); assert.equal(recognitionSignal?.aborted, true); assert.equal(view.stage()!.room.game.drawingEpoch, 1); assert.equal(view.stage()!.room.self.actionSequence, 3);
  view.unmount(); delayed.resolve(new Response(JSON.stringify({ version: 1, roomId: ROOM, ...recognitionCalls[0], status: 'ready', retryAfterMs: 3000 }))); await view.settle(); assert.equal(view.lateSetters(), 0); assert.equal(recognitionCalls.length, 1);
});

test('drawing transport distinguishes transient rate limits from definitive validation failures', async () => {
  let status = 429; const room = fixture({ kind: 'sketch-guess', status: 'playing', phase: 'draw', phaseId: 1, round: 1, game: { artistId: OWNER, strokes: [], drawingEpoch: 0, drawingAckIds: [], guessedIds: [] } });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => init?.method === 'POST' ? new Response(JSON.stringify({ error: 'Try again.' }), { status }) : new Response(JSON.stringify({ room })) });
  await view.settle(); const action = { type: 'drawing-batch', drawingEpoch: 0, segments: [] };
  assert.equal(await view.stage()!.sendDrawing(action), 'retry'); await view.settle(); status = 400;
  assert.equal(await view.stage()!.sendDrawing(action), 'rejected'); await view.settle(); assert.doesNotMatch(view.content(), /Retry the same action/); view.unmount();
});

test('an unconfirmed drawing from an old phase cannot block actions in the next phase', async () => {
  let attempts = 0; const room = fixture({ kind: 'sketch-guess', status: 'playing', phase: 'draw', phaseId: 1, round: 1, game: { artistId: OWNER, strokes: [], drawingEpoch: 0, drawingAckIds: [], guessedIds: [] } });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ room }));
    const body = JSON.parse(String(init.body));
    if (++attempts === 1) return new Response(JSON.stringify({ error: 'Lost response.' }), { status: 503 });
    room.self.actionSequence = body.sequence; return new Response(JSON.stringify({ room }));
  } });
  await view.settle(); const action = { type: 'drawing-batch', drawingEpoch: 0, segments: [{ id: OTHER, color: '#244b50', width: 5, points: [[.1, .1], [.2, .2]] }] };
  assert.equal(await view.stage()!.sendDrawing(action), 'retry'); await view.settle(); assert.match(view.content(), /Retry the same action/);
  room.phaseId = 3; room.round = 2; view.poll(); await view.settle(); assert.doesNotMatch(view.content(), /Retry the same action/);
  assert.equal(await view.stage()!.sendDrawing({ ...action, segments: [{ ...action.segments[0], id: ROOM }] }), 'accepted'); await view.settle(); assert.equal(attempts, 2); view.unmount();
});

test('AI party projections preserve explicit flags, accept legacy humans and reject fake AI authority', () => {
  const { api } = library(), base = fixture();
  assert.equal(api.parsePartyRoom(base).players[0].isAI, undefined);
  const mixed = { ...base, players: base.players.map((player: any, index: number) => ({ ...player, isAI: index === 1 })) };
  assert.equal(api.parsePartyRoom(mixed).players[1].isAI, true);
  assert.equal(api.parsePartyRoom(mixed).players[0].isAI, false);
  for (const value of ['true', 1, null, {}]) assert.throws(() => api.parsePartyRoom({ ...mixed, players: mixed.players.map((player: any, index: number) => index ? { ...player, isAI: value } : player) }), /unsupported response/);
  assert.throws(() => api.parsePartyRoom({ ...mixed, hostId: OTHER }), /unsupported response/);
  assert.throws(() => api.parsePartyRoom({ ...mixed, self: { ...base.self, id: OTHER, isHost: false } }), /unsupported response/);
});

test('every online party lobby explicitly adds an AI seat without starting and stops at capacity', async () => {
  for (const game of catalog.games.filter((entry: any) => entry.id !== 'mafia')) {
    const actions: any[] = [], base = fixture(), room = fixture({ kind: game.id, settings: { ...base.settings, maxPlayers: game.maxPlayers }, players: [base.players[0]] });
    const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => {
      if (init?.method === 'POST') { const action = JSON.parse(String(init.body)); actions.push(action); room.players.push({ ...base.players[1], isAI: true }); room.self.actionSequence = action.sequence; }
      return new Response(JSON.stringify({ room }));
    } });
    await view.settle(); const label = game.maxPlayers === 2 ? 'Add AI opponent' : 'Add AI player';
    assert.equal(view.button(label)!.props.disabled, false); assert.equal(view.button('Start the game')!.props.disabled, true);
    view.click(label); await view.settle(); assert.equal(actions.length, 1); assert.equal(actions[0].type, 'add-ai'); assert.equal(room.phase, 'lobby'); assert.equal(room.status, 'lobby');
    assert.match(view.markup(), /aria-label="AI player"/); assert.match(view.markup(), /AI player/);
    if (game.maxPlayers === 2) assert.equal(view.button(label)!.props.disabled, true);
    assert.equal(view.button('Start the game')!.props.disabled, room.players.length < game.minPlayers); view.unmount();
  }
});

test('group Fill AI is explicit, fills only the minimum and leaves existing human seats intact', async () => {
  const base = fixture(), room = fixture({ kind: 'starship-suspects', settings: { ...base.settings, maxPlayers: 12 }, players: [base.players[0]] }), actions: any[] = [];
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (_url, init) => {
    if (init?.method === 'POST') { const action = JSON.parse(String(init.body)); actions.push(action); for (const [index, id] of [OTHER, ROOM, '44444444-4444-4444-8444-444444444444'].entries()) room.players.push({ id, name: `AI ${index + 1}`, avatar: 'robot', score: 0, isAI: true }); room.self.actionSequence = action.sequence; }
    return new Response(JSON.stringify({ room }));
  } });
  await view.settle(); view.click('Fill to 4 players'); await view.settle(); assert.equal(actions.length, 1); assert.equal(actions[0].type, 'fill-ai'); assert.equal(room.players.length, 4); assert.equal(room.players[0].id, OWNER); assert.equal(room.players[0].isAI, undefined); assert.equal(view.button('Fill to 4 players')!.props.disabled, true); assert.equal(view.button('Start the game')!.props.disabled, false); view.unmount();
  const guestRoom = { ...room, self: { ...room.self, id: OTHER, isHost: false }, players: room.players.map((player: any) => player.id === OTHER ? { ...player, isAI: false } : player) };
  const guest = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OTHER, token: TOKEN }, fetch: async () => new Response(JSON.stringify({ room: guestRoom })) }); await guest.settle(); assert.equal(guest.button('Add AI player'), undefined); assert.equal(guest.button('Fill to 4 players'), undefined); guest.unmount();
});

test('drawing AI status explains watching, processing, abstention and temporary failure without predictions', async () => {
  for (const [status, message] of Object.entries({ watching: 'AI players are watching your drawing.', thinking: 'AI players are looking at your drawing', 'needs-detail': 'AI players need a little more detail', unavailable: 'AI guesses are temporarily unavailable' })) {
    const room = fixture({ kind: 'sketch-guess', status: 'playing', phase: 'draw', phaseId: 1, round: 1, game: { artistId: OWNER, drawingEpoch: 0, inkSha256: 'a'.repeat(64), strokes: [], guessedIds: [], aiDrawingStatus: status }, self: { id: OWNER, isHost: true, actionSequence: 0, prompt: 'moon' }, players: [fixture().players[0], { ...fixture().players[1], isAI: true }] });
    const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async () => new Response(JSON.stringify({ room })) });
    await view.settle(); assert.ok(view.markup().includes(message)); view.unmount();
  }
});

test('an older drawing page receives the server refresh instruction without losing its saved seat', async () => {
  const room = fixture({ kind: 'sketch-guess' }); let requests = 0;
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async () => {
    if (++requests === 1) return new Response(JSON.stringify({ room }));
    return new Response(JSON.stringify({ error: 'Refresh this page to enable AI guesses. Your room is saved.' }), { status: 426 });
  } });
  await view.settle(); view.poll(); await view.settle(); assert.match(view.content(), /Refresh this page to enable AI guesses/); assert.equal(view.api.readPartySession(ROOM).token, TOKEN); view.unmount();
});
