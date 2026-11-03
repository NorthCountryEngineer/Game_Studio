import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOM = '11111111-1111-4111-8111-111111111111', OWNER = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333', THIRD = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'seat_capability_012345678901234567890123456', INVITE = 'invite_capability_01234567890123456789012345';
function fixture(overrides: Record<string, any> = {}) {
  const players = [OWNER, OTHER, THIRD, '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'].map((id, index) => ({ id, name: ['Nova', 'Orbit', 'Pip', 'Moon', 'Sage'][index], avatar: ['fox', 'bear', 'cat', 'dog', 'frog'][index], alive: true, isNarrator: false }));
  return { version: 1, roomId: ROOM, phase: 'lobby', phaseId: 0, day: 0, ownerId: OWNER, narratorId: null, narratorMode: 'ai', settings: { maxPlayers: 12, nightSeconds: 75, discussionSeconds: 90, votingSeconds: 45 }, createdAt: 1800000000, deadlineAt: null, winner: null, players, self: { id: OWNER, actionSequence: 0, role: null, alive: true, isOwner: true, isNarrator: false, nightTargetId: null, voteTargetId: null, hasVoted: false, ready: false, checks: [], allies: [] }, events: [{ id: 'e1', kind: 'created', text: 'The town is gathering.', at: 1800000000, day: 0 }], chat: [], mafiaChat: [], ...overrides };
}
function storage() { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); }, data }; }
const transpile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function library(options: { connected?: boolean; api?: string; fetch?: typeof fetch; store?: ReturnType<typeof storage> } = {}) {
  const exported: Record<string, any> = {}, store = options.store ?? storage();
  vm.runInNewContext(transpile('../src/lib/mafia.ts'), { exports: exported, require(name: string) { assert.equal(name, './core'); return { isCore: options.connected ?? false, coreConfig: { api_url: options.api ?? 'https://games-api.example' } }; }, localStorage: store, URL, URLSearchParams, Set, Error, JSON, AbortController, AbortSignal, setTimeout, clearTimeout, crypto: webcrypto, Uint8Array, btoa, fetch: options.fetch ?? fetch });
  return { api: exported, store };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('Mafia names preserve Unicode and punctuation with bounded visible characters', () => {
  const { api } = library();
  assert.equal(api.validateMafiaName('  Cafe\u0301 🦊 <&>  '), 'Café 🦊 <&>');
  assert.equal(api.validateMafiaName('🙂'.repeat(16)), '🙂'.repeat(16));
  for (const value of ['', ' ', 'x'.repeat(17), 'Nova\n', 'A\u202eB', '\u200d', '\ud800']) assert.throws(() => api.validateMafiaName(value), /1–16 visible/);
  assert.equal(api.MAFIA_AVATARS.length, 20);
  assert.equal(new Set(api.MAFIA_AVATARS.map((value: string[]) => value[0])).size, 20);
});

test('Mafia room parsing returns the bounded seat view and ignores unknown private-looking fields', () => {
  const { api } = library(), room = fixture();
  const parsed = api.parseMafiaRoom({ ...room, secretRoles: { [OTHER]: 'mafia' }, revision: 2, expiresAt: 1800007200 });
  assert.equal(parsed.roomId, ROOM); assert.equal(parsed.self.actionSequence, 0); assert.equal('secretRoles' in parsed, false);
  for (const patch of [{ self: { ...room.self, actionSequence: -1 } }, { players: [...room.players, room.players[0]] }, { settings: { ...room.settings, maxPlayers: 25 } }, { narratorInfo: { roles: [], nightActions: {}, readyToAdvance: false, submitted: 0, required: 0 } }, { phase: 'made-up' }]) assert.throws(() => api.parseMafiaRoom({ ...room, ...patch }), /unsupported response/);
  const dead = { ...room, players: room.players.map(player => player.id === OTHER ? { ...player, left: true, alive: false } : player) };
  assert.equal(api.parseMafiaRoom(dead).players[1].left, true);
});

test('Mafia session envelopes reject cross-room or cross-seat capabilities and preserve only known fields', () => {
  const { api } = library(), session = { roomId: ROOM, playerId: OWNER, token: TOKEN, inviteToken: INVITE };
  assert.equal(api.parseMafiaEnvelope({ room: fixture(), session }, true).session.token, TOKEN);
  assert.throws(() => api.parseMafiaEnvelope({ room: fixture() }, true), /unsupported response/);
  assert.throws(() => api.parseMafiaEnvelope({ room: fixture(), session: { ...session, playerId: OTHER } }, true), /unsupported response/);
  assert.throws(() => api.parseMafiaEnvelope({ room: fixture(), session: { ...session, roomId: OTHER } }, true), /unsupported response/);
  api.saveMafiaSession(session); assert.equal(api.readMafiaSession(ROOM).token, TOKEN); assert.equal(api.readMafiaSession(OTHER), undefined);
  api.forgetMafiaSession(ROOM); assert.equal(api.readMafiaSession(ROOM), undefined);
});

test('private Mafia invitations keep capabilities in fragments and require exact same-origin room links', () => {
  const { api } = library(), session = { roomId: ROOM, playerId: OWNER, token: TOKEN, inviteToken: INVITE }, origin = 'https://games.example';
  const link = api.mafiaInvitation(origin, session), parsed = api.parseMafiaInvitation(link, origin);
  assert.equal(link, `${origin}/mafia/${ROOM}#join=${INVITE}`); assert.equal(parsed.inviteToken, INVITE);
  assert.equal(new URL(link).search, ''); assert.equal(link.includes(TOKEN), false);
  for (const bad of [link.replace(origin, 'https://other.example'), link + '&join=' + INVITE, link.replace('#', '?tracking=x#'), `${origin}/mafia/${ROOM}#join=x`, `${origin}/mafia/${ROOM}#join=${INVITE}&other=x`]) assert.equal(api.parseMafiaInvitation(bad, origin), undefined);
});

test('client-generated admission secrets and exact retries survive reload without creating another seat', () => {
  const { api } = library(), playerToken = api.createMafiaSecret(), inviteToken = api.createMafiaSecret();
  assert.match(playerToken, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(playerToken, inviteToken);
  const admission = { path: '/mafia/rooms', body: { requestId: ROOM, name: 'Nova', avatar: 'fox', playerToken, inviteToken, narratorMode: 'ai', maxPlayers: 12, nightSeconds: 75, discussionSeconds: 90, votingSeconds: 45 } };
  api.saveMafiaAdmission('create', admission); assert.equal(JSON.stringify(api.readMafiaAdmission('create')), JSON.stringify(api.parseMafiaAdmission(admission)));
  assert.throws(() => api.saveMafiaAdmission(OTHER, admission), /unsupported response/);
  api.clearMafiaAdmission('create'); assert.equal(api.readMafiaAdmission('create'), undefined);
});

test('public and room requests never send Core credentials or cookies and bound their paths', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const { api } = library({ connected: true, fetch: async (input, init) => { requests.push({ url: String(input), init: init! }); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  await api.mafiaRequest('/mafia/config'); await api.mafiaRequest(`/mafia/rooms/${ROOM}`, 'GET', undefined, TOKEN);
  assert.equal(requests[0].url, 'https://games-api.example/mafia/config'); assert.equal((requests[0].init.headers as Record<string, string>).Authorization, undefined);
  assert.equal((requests[1].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`); assert.equal(requests[1].init.credentials, 'omit'); assert.equal(requests[1].init.redirect, 'error');
  await assert.rejects(api.mafiaRequest('/session'), /valid live Mafia/); await assert.rejects(api.mafiaRequest(`/mafia/rooms/${ROOM}`, 'GET', undefined, 'invalid token'), /seat is invalid/);
  const local = library().api; assert.equal(local.mafiaAPIBase(), '/mafia-api');
});

test('Mafia request errors are explicit and cancelled requests do not outlive their owner', async () => {
  const failed = library({ fetch: async () => new Response(JSON.stringify({ error: 'The room is full.' }), { status: 409 }) }).api;
  await assert.rejects(failed.mafiaRequest('/mafia/config'), /room is full/);
  const controller = new AbortController(); controller.abort();
  let signal: AbortSignal | undefined;
  const cancelled = library({ fetch: async (_url, init) => { signal = init?.signal as AbortSignal; throw new DOMException('Aborted', 'AbortError'); } }).api;
  await assert.rejects(cancelled.mafiaRequest('/mafia/config', 'GET', undefined, undefined, controller.signal), /Aborted/); assert.equal(signal?.aborted, true);
});

type Element = { type: any; props: Record<string, any> };
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void; setup?: () => unknown };
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
const elements = (value: any): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props.children)] : [];
const content = (value: any): string => Array.isArray(value) ? value.map(content).join('') : value && typeof value === 'object' && 'type' in value ? content(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function mount(options: { roomId?: string; href?: string; fetch?: typeof fetch; session?: Record<string, string>; admission?: Record<string, any> } = {}) {
  const store = storage(), { api } = library({ store, fetch: options.fetch ?? (async () => new Response('{}', { status: 503 })) });
  if (options.session) api.saveMafiaSession(options.session);
  if (options.admission) api.saveMafiaAdmission(options.roomId ?? 'create', options.admission);
  let hooks: Hook[] = [], cursor = 0, dirty = true, tree: Element, effects: Hook[] = [], unmounted = false, lateSetters = 0;
  let timerId = 0; const timers = new Map<number, () => void>(), navigated: string[] = [];
  const react = {
    useState(initial: any) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, (next: any) => { if (unmounted) { lateSetters++; return; } const value = typeof next === 'function' ? next(hooks[i].value) : next; if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; } }]; },
    useRef(initial: any) { const i = cursor++; hooks[i] ??= { value: { current: initial } }; return hooks[i].value; },
    useEffect(setup: () => unknown, deps: unknown[]) { const i = cursor++, previous = hooks[i]; if (!previous || !deps || !previous.deps || deps.some((v, index) => !Object.is(v, previous.deps![index]))) { const hook = { setup, deps, cleanup: previous?.cleanup }; hooks[i] = hook; effects.push(hook); } },
  };
  const exported: Record<string, any> = {}, browser = { location: { origin: 'http://127.0.0.1:5193', href: options.href ?? `http://127.0.0.1:5193/mafia${options.roomId ? '/' + options.roomId : ''}` }, setInterval: () => ++timerId, clearInterval: () => {}, setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) };
  vm.runInNewContext(transpile('../src/components/Mafia.tsx'), { exports: exported, require(name: string) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }; if (name === '../lib/mafia') return api; if (name === './PartyInstructions') return { PartyInstructions: () => null }; if (name === '../mafia.css') return {}; throw new Error(name); }, window: browser, document: { visibilityState: 'visible' }, navigator: { clipboard: { writeText: async () => {} } }, crypto: webcrypto, AbortController, DOMException, Date, Promise, JSON, Error, Number, Object, String, Boolean });
  function flush() { let turns = 0; while (dirty && !unmounted) { assert.ok(++turns < 40); dirty = false; cursor = 0; effects = []; tree = exported.MafiaPage({ roomId: options.roomId, navigate: (path: string) => { navigated.push(path); } }); for (const hook of effects) { hook.cleanup?.(); const cleanup = hook.setup!(); hook.cleanup = typeof cleanup === 'function' ? cleanup as () => void : undefined; } } }
  async function settle() { for (let count = 0; count < 40; count++) { await Promise.resolve(); flush(); } }
  function field(id: string) { return elements(tree).find(e => e.props.id === id); }
  function button(label: string) { return elements(tree).find(e => e.type === 'button' && content(e.props.children).includes(label)); }
  function change(id: string, value: string) { const input = field(id); assert.ok(input, id); input.props.onChange({ target: { value } }); flush(); }
  function submit() { const form = elements(tree).find(e => e.type === 'form'); assert.ok(form); form.props.onSubmit({ preventDefault() {} }); flush(); }
  function click(label: string) { const found = button(label); assert.ok(found, label); assert.equal(found.props.disabled ?? false, false, label); found.props.onClick(); flush(); }
  function markup() { function render(value: any, key = 'r'): any { if (Array.isArray(value)) return value.map((v, index) => render(v, key + index)); if (!value || typeof value !== 'object' || !('type' in value)) return value; if (typeof value.type === 'function') return render(value.type(value.props), key + 'f'); const { children, ...props } = value.props; return createElement(value.type === 'FRAGMENT' ? 'div' : value.type, { ...props, key }, render(children, key + 'c')); } return renderToStaticMarkup(render(tree)); }
  function unmount() { for (const hook of hooks) hook.cleanup?.(); unmounted = true; }
  flush();
  return { api, exported, store, flush, settle, field, button, change, submit, click, navigated, markup, content: () => content(tree), tree: () => tree, unmount, lateSetters: () => lateSetters, poll: () => { const queued = [...timers]; timers.clear(); for (const [, fn] of queued) fn(); } };
}

test('Mafia landing offers public avatar selection and no sign-in gate', async () => {
  const view = mount({ fetch: async () => new Response(JSON.stringify({ aiAvailable: true }), { status: 200 }) }); await view.settle();
  assert.match(view.content(), /No sign-in to play/); assert.match(view.content(), /Create a private room/); assert.ok(view.field('mafia-player-name')); assert.match(view.content(), /AI narrator/); assert.equal(view.button('Create a private room')!.props.disabled, true); view.unmount();
});

test('an uncertain room creation retries the same secrets and request, then saves its seat', async () => {
  const requests: any[] = []; let attempt = 0;
  const view = mount({ fetch: async (url, init) => {
    if (String(url).endsWith('/config')) return new Response(JSON.stringify({ aiAvailable: true }), { status: 200 });
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (++attempt === 1) return new Response(JSON.stringify({ error: 'Temporary failure' }), { status: 503 });
    const room = fixture({ roomId: body.requestId, ownerId: body.requestId, players: [{ id: body.requestId, name: body.name, avatar: body.avatar, alive: false, isNarrator: true }], self: { ...fixture().self, id: body.requestId, alive: false, isNarrator: true }, narratorMode: 'human', narratorId: body.requestId });
    return new Response(JSON.stringify({ room, session: { roomId: body.requestId, playerId: body.requestId, token: body.playerToken, inviteToken: body.inviteToken } }), { status: 200 });
  } });
  await view.settle(); view.change('mafia-player-name', 'Nova'); view.submit(); await view.settle(); assert.match(view.content(), /Temporary failure/); assert.equal(view.field('mafia-player-name')!.props.disabled, true);
  view.submit(); await view.settle(); assert.equal(requests.length, 2); assert.equal(JSON.stringify(requests[0]), JSON.stringify(requests[1])); assert.equal(requests[0].playerToken.length, 43); assert.equal(view.navigated[0], `/mafia/${requests[0].requestId}`); assert.equal(view.api.readMafiaSession(requests[0].requestId).token, requests[0].playerToken); view.unmount();
});

test('saved Mafia seats reconnect without another join and keep role information hidden until requested', async () => {
  const room = fixture({ phase: 'night', day: 1, phaseId: 1, deadlineAt: Math.floor(Date.now() / 1000) + 75, self: { ...fixture().self, role: 'doctor' } }), methods: string[] = [];
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (url, init) => { methods.push(init?.method ?? 'GET'); return new Response(JSON.stringify(String(url).endsWith('/config') ? { aiAvailable: true } : { room }), { status: 200 }); } });
  await view.settle(); assert.equal(methods.includes('POST'), false); assert.match(view.content(), /Your secret role/); assert.doesNotMatch(view.content(), /You are the Doctor/); view.click('Reveal my role'); assert.match(view.content(), /You are the Doctor/); assert.match(view.content(), /Hide private information/); view.unmount();
});

test('seat target selection follows private role restrictions and never includes departed players', () => {
  const view = mount(), f = view.exported.mafiaEligibleTargets, base = fixture({ phase: 'night', day: 1 });
  const doctor = f({ ...base, self: { ...base.self, role: 'doctor' } }); assert.equal(doctor.length, 5);
  const detective = f({ ...base, self: { ...base.self, role: 'detective' } }); assert.equal(detective.some((p: any) => p.id === OWNER), false);
  const mafia = f({ ...base, self: { ...base.self, role: 'mafia', allies: [OTHER] }, players: base.players.map(p => p.id === THIRD ? { ...p, left: true, alive: false } : p) }); assert.equal(mafia.some((p: any) => [OWNER, OTHER, THIRD].includes(p.id)), false);
  assert.equal(f({ ...base, self: { ...base.self, role: 'civilian' } }).length, 0); view.unmount();
});

test('Mafia owner can restart the same finished group and actions carry a monotonic seat sequence', async () => {
  const room = fixture({ phase: 'finished', day: 2, phaseId: 5, winner: 'town', self: { ...fixture().self, actionSequence: 4, role: 'doctor' } }), reports: any[] = [];
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (url, init) => { if (String(url).endsWith('/config')) return new Response(JSON.stringify({ aiAvailable: true })); if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); reports.push(body); return new Response(JSON.stringify({ room: fixture({ phaseId: 6, self: { ...fixture().self, actionSequence: body.sequence } }) })); } return new Response(JSON.stringify({ room })); } });
  await view.settle(); view.click('Play again with this group'); await view.settle(); assert.equal(reports.length, 1); assert.equal(reports[0].type, 'restart'); assert.equal(reports[0].sequence, 5); assert.equal(reports[0].phaseId, 5); assert.match(reports[0].requestId, /^[0-9a-f-]{36}$/); assert.match(view.content(), /Your town is gathering/); view.unmount();
});

test('unmounting a Mafia view discards late room responses without updating state', async () => {
  const pending = deferred<Response>();
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async url => String(url).endsWith('/config') ? new Response(JSON.stringify({ aiAvailable: true })) : pending.promise });
  await view.settle(); view.unmount(); pending.resolve(new Response(JSON.stringify({ room: fixture() }))); await view.settle(); assert.equal(view.lateSetters(), 0);
});

test('a definitive name conflict unlocks admission details instead of trapping the guest on retry', async () => {
  const view = mount({ roomId: ROOM, href: `http://127.0.0.1:5193/mafia/${ROOM}#join=${INVITE}`, fetch: async url => new Response(JSON.stringify(String(url).endsWith('/config') ? { aiAvailable: true } : { error: 'That name is already in the town. Choose another name.' }), { status: String(url).endsWith('/config') ? 200 : 409 }) });
  await view.settle(); view.change('mafia-player-name', 'Nova'); view.submit(); await view.settle(); assert.match(view.content(), /already in the town/); assert.equal(view.field('mafia-player-name')!.props.disabled, false); assert.equal(view.api.readMafiaAdmission(ROOM), undefined); view.change('mafia-player-name', 'New Nova'); assert.equal(view.field('mafia-player-name')!.props.value, 'New Nova'); view.unmount();
});

test('the Mafia UI serializes polls and mutations instead of opening concurrent requests', async () => {
  const delayed = deferred<Response>(); let calls = 0, inFlight = 0, maximum = 0; const reports: any[] = [], room = fixture();
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (url, init) => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    try {
      if (String(url).endsWith('/config')) return new Response(JSON.stringify({ aiAvailable: true }));
      if (init?.method === 'POST') { reports.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ room: fixture({ phase: 'night', phaseId: 1, day: 1, self: { ...room.self, role: 'civilian', actionSequence: 1 } }) })); }
      if (++calls === 2) return await delayed.promise;
      return new Response(JSON.stringify({ room }));
    } finally { inFlight--; }
  } });
  await view.settle(); view.poll(); await view.settle(); view.click('Start the first night'); await view.settle(); assert.equal(reports.length, 0); assert.equal(maximum, 1);
  delayed.resolve(new Response(JSON.stringify({ room }))); await view.settle(); assert.equal(reports.length, 1); assert.equal(maximum, 1); assert.equal(reports[0].type, 'start'); view.unmount();
});

test('an uncertain action keeps its exact sequence and request identity on explicit retry', async () => {
  const room = fixture(), reports: any[] = []; let attempts = 0;
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (url, init) => {
    if (String(url).endsWith('/config')) return new Response(JSON.stringify({ aiAvailable: true }));
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); reports.push(body); if (++attempts === 1) return new Response(JSON.stringify({ error: 'The room is busy. Retry shortly.' }), { status: 503 }); return new Response(JSON.stringify({ room: fixture({ phase: 'night', phaseId: 1, day: 1, self: { ...room.self, role: 'civilian', actionSequence: body.sequence } }) })); }
    return new Response(JSON.stringify({ room }));
  } });
  await view.settle(); view.click('Start the first night'); await view.settle(); assert.match(view.content(), /Retry the same action/); view.click('Retry the same action'); await view.settle(); assert.equal(reports.length, 2); assert.equal(JSON.stringify(reports[0]), JSON.stringify(reports[1])); assert.doesNotMatch(view.content(), /Retry the same action/); view.unmount();
});

test('Mafia names and messages render as literal text rather than executable markup', async () => {
  const raw = fixture({ phase: 'finished', phaseId: 5, day: 2, winner: 'town', players: fixture().players.map((player, index) => ({ ...player, name: index ? player.name : '<script>', role: index === 1 ? 'mafia' : 'civilian' })), chat: [{ id: 'e2', playerId: OTHER, text: '<img src=x onerror=alert(1)>', day: 1, at: 1800000000 }] });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async url => new Response(JSON.stringify(String(url).endsWith('/config') ? { aiAvailable: true } : { room: raw })) }); await view.settle();
  const markup = view.markup(); assert.match(markup, /&lt;script&gt;/); assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<script>|<img src=x/); view.unmount();
});

test('a new round hides the private card even when a guest misses the lobby between polls', async () => {
  let room = fixture({ phase: 'night', phaseId: 1, day: 1, self: { ...fixture().self, role: 'doctor' } });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async url => new Response(JSON.stringify(String(url).endsWith('/config') ? { aiAvailable: true } : { room })) });
  await view.settle(); view.click('Reveal my role'); assert.match(view.content(), /You are the Doctor/);
  room = { ...room, phaseId: 9 }; view.poll(); await view.settle(); assert.doesNotMatch(view.content(), /You are the Doctor/); assert.match(view.content(), /Reveal my role/); view.unmount();
});

test('a committed leave with a lost response clears the saved seat when polling confirms it', async () => {
  let room = fixture({ ownerId: OTHER, self: { ...fixture().self, isOwner: false } });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (url, init) => {
    if (String(url).endsWith('/config')) return new Response(JSON.stringify({ aiAvailable: true }));
    if (init?.method === 'POST') { const action = JSON.parse(String(init.body)); assert.equal(action.type, 'leave'); room = { ...room, self: { ...room.self, left: true, alive: false, actionSequence: action.sequence } }; return new Response(JSON.stringify({ error: 'A response was lost.' }), { status: 503 }); }
    return new Response(JSON.stringify({ room }));
  } });
  await view.settle(); view.click('Leave this room'); await view.settle(); assert.match(view.content(), /Retry the same action/); view.poll(); await view.settle(); assert.equal(view.api.readMafiaSession(ROOM), undefined); assert.equal(view.navigated.at(-1), '/mafia'); view.unmount();
});

test('a saved uncertain AI admission remains retryable even when the capability check is unavailable', async () => {
  const admission = { path: '/mafia/rooms', body: { requestId: ROOM, name: 'Nova', avatar: 'fox', playerToken: TOKEN, inviteToken: INVITE, narratorMode: 'ai', maxPlayers: 12, nightSeconds: 75, discussionSeconds: 90, votingSeconds: 45 } };
  const view = mount({ admission, fetch: async () => new Response(JSON.stringify({ aiAvailable: false })) }); await view.settle(); assert.equal(view.button('Retry the same request')!.props.disabled, false); assert.equal(view.field('mafia-player-name')!.props.disabled, true); view.unmount();
});

test('mutation responses cannot replace the saved seat with another player’s private view', async () => {
  const room = fixture(), other = fixture({ phase: 'night', phaseId: 1, day: 1, self: { ...fixture().self, id: OTHER, isOwner: false, role: 'mafia', actionSequence: 1 } });
  const view = mount({ roomId: ROOM, session: { roomId: ROOM, playerId: OWNER, token: TOKEN }, fetch: async (url, init) => new Response(JSON.stringify(String(url).endsWith('/config') ? { aiAvailable: true } : { room: init?.method === 'POST' ? other : room })) }); await view.settle(); view.click('Start the first night'); await view.settle(); assert.match(view.content(), /does not match your saved seat/); assert.match(view.content(), /Your town is gathering/); assert.doesNotMatch(view.content(), /Reveal my role/); view.unmount();
});

test('removing a lobby player preserves readable historical chat from that former seat', () => {
  const { api } = library(), room = fixture({ day: 2001, chat: [{ id: 'e2', playerId: '77777777-7777-4777-8777-777777777777', text: 'See you next game!', day: 0, at: 1800000000 }] });
  const parsed = api.parseMafiaRoom(room); assert.equal(parsed.chat[0].text, 'See you next game!'); assert.equal(parsed.day, 2001);
});
