import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlayerDisplay, gameDisplayMessage, playerDisplayShortcut, type PlayerDisplayState } from '../src/lib/game-fullscreen.ts';

const nonce = 'fullscreen_controller_nonce_123';
type Listener = (event: any) => void;
class Port {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(name: string, handler: Listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(handler); }
  removeEventListener(name: string, handler: Listener) { this.listeners.get(name)?.delete(handler); }
  emit(name: string, event: any = {}) { for (const handler of [...this.listeners.get(name) || []]) handler(event); }
  count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
class Element {
  parent?: Element; isConnected = true; isContentEditable = false; editable = false; focusCalls = 0;
  contentWindow = {}; srcDoc = 'same-mounted-game-document'; requestFullscreen?: () => Promise<void>;
  constructor(public ownerDocument: any) {}
  contains(node: Element | null) { for (let value = node; value; value = value.parent || null) if (value === this) return true; return false; }
  closest() { return this.editable || this.parent?.editable ? this : null; }
  focus(_options?: unknown) { this.focusCalls++; this.ownerDocument.activeElement = this; }
}
function deferred() { let resolve!: () => void, reject!: (error?: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
function harness(support = true) {
  const win = new Port(), doc = Object.assign(new Port(), { defaultView: win, fullscreenElement: null as Element | null, fullscreenEnabled: true, body: { style: { overflow: 'auto' } }, activeElement: null as Element | null, exitFullscreen: () => Promise.resolve() });
  const root = new Element(doc), frame = new Element(doc), button = new Element(doc), outside = new Element(doc), input = new Element(doc);
  frame.parent = button.parent = input.parent = root; input.editable = true; doc.activeElement = outside;
  let currentFrame = frame, requests = 0, exits = 0;
  const request = deferred(), calls: string[] = [], states: PlayerDisplayState[] = [];
  const native = (value: Element | null) => { doc.fullscreenElement = value; doc.emit('fullscreenchange'); };
  if (support) root.requestFullscreen = () => { requests++; calls.push('requestFullscreen'); return request.promise; };
  doc.exitFullscreen = () => { exits++; native(null); return Promise.resolve(); };
  const controller = createPlayerDisplay({ element: root as unknown as HTMLElement, frame: () => currentFrame as unknown as HTMLIFrameElement, exitButton: () => button as unknown as HTMLButtonElement, nonce, onChange: state => states.push(state) });
  const state = () => states.at(-1) || { mode: 'windowed', pending: false, notice: '' };
  const key = (key: string, target: Element = root, changes: Record<string, unknown> = {}) => { const event = { key, target, defaultPrevented: false, repeat: false, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, preventDefault() { this.defaultPrevented = true; }, ...changes }; doc.emit('keydown', event); return event; };
  const message = (changes: Record<string, unknown> = {}, dataChanges: Record<string, unknown> = {}) => win.emit('message', { origin: 'null', source: currentFrame.contentWindow, data: { type: 'game-player-display', nonce, action: 'toggle', ...dataChanges }, ...changes });
  return { win, doc, root, frame, button, outside, input, request, calls, states, state, controller, native, key, message, requests: () => requests, exits: () => exits, replaceFrame() { currentFrame = new Element(doc); currentFrame.parent = root; return currentFrame; } };
}

test('display message admission requires current opaque frame, exact nonce and exact three-key shape', () => {
  const source = {} as Window, other = {} as Window;
  const event = { origin: 'null', source, data: { type: 'game-player-display', nonce, action: 'toggle' } };
  assert.equal(gameDisplayMessage(event, source, nonce), 'toggle');
  assert.equal(gameDisplayMessage({ ...event, data: { ...event.data, action: 'exit' } }, source, nonce), 'exit');
  for (const changed of [{ source: other }, { origin: 'https://games.example.test' }, { origin: '' }, { data: null }, { data: [] }, { data: { ...event.data, nonce: 'old_nonce' } }, { data: { ...event.data, action: 'fetch' } }, { data: { ...event.data, url: 'https://unapproved.example.test' } }, { data: { ...event.data, token: 'synthetic-secret-must-not-be-accepted' } }, { data: { ...event.data, type: 'game-coop-input' } }]) assert.equal(gameDisplayMessage({ ...event, ...changed }, source, nonce), undefined);
  assert.equal(gameDisplayMessage(event, null, nonce), undefined);
});

test('native entry calls requestFullscreen synchronously and retains the mounted game frame through Escape', async () => {
  const h = harness(), contentWindow = h.frame.contentWindow, source = h.frame.srcDoc;
  h.calls.push('before'); h.controller.toggle(); h.calls.push('after');
  assert.deepEqual(h.calls, ['before', 'requestFullscreen', 'after']);
  assert.deepEqual(h.state(), { mode: 'windowed', pending: true, notice: '' });
  h.native(h.root); h.request.resolve(); await settle();
  assert.deepEqual(h.state(), { mode: 'fullscreen', pending: false, notice: '' });
  assert.equal(h.frame.focusCalls, 1);
  h.native(null);
  assert.equal(h.state().mode, 'windowed'); assert.equal(h.outside.focusCalls, 1);
  assert.equal(h.frame.contentWindow, contentWindow); assert.equal(h.frame.srcDoc, source);
  h.controller.destroy(); assert.equal(h.win.count() + h.doc.count(), 0);
});

test('exit button leaves only its own native fullscreen and refuses another fullscreen owner', async () => {
  const h = harness(); h.controller.toggle(); h.native(h.root); h.request.resolve(); await settle();
  h.controller.toggle(); await settle(); assert.equal(h.exits(), 1); assert.equal(h.state().mode, 'windowed');
  const foreign = new Element(h.doc); h.native(foreign); h.controller.toggle();
  assert.equal(h.requests(), 1); assert.match(h.state().notice, /other full-screen/u);
  h.controller.exit(); assert.equal(h.exits(), 1); assert.equal(h.doc.fullscreenElement, foreign);
  h.controller.destroy();
});

test('unsupported native API expands the same frame and restores overflow and prior connected focus', () => {
  const h = harness(false); h.controller.toggle();
  assert.equal(h.state().mode, 'expanded'); assert.match(h.state().notice, /fills this window/u);
  assert.equal(h.doc.body.style.overflow, 'hidden'); assert.equal(h.frame.focusCalls, 1);
  h.controller.exit(); assert.equal(h.state().mode, 'windowed'); assert.equal(h.doc.body.style.overflow, 'auto'); assert.equal(h.outside.focusCalls, 1);
  h.outside.isConnected = false; h.doc.activeElement = h.outside; h.controller.toggle(); h.controller.exit();
  assert.equal(h.outside.focusCalls, 1, 'Disconnected prior focus is never restored');
  h.controller.destroy();
});

test('disabled, rejected or synchronously throwing native APIs fall back without discarding game state', async () => {
  const disabled = harness(); disabled.doc.fullscreenEnabled = false; disabled.controller.toggle(); assert.equal(disabled.state().mode, 'expanded'); assert.equal(disabled.requests(), 0); disabled.controller.destroy();
  const rejected = harness(); rejected.controller.toggle(); rejected.request.reject(new Error('Synthetic browser policy denial')); await settle(); assert.equal(rejected.state().mode, 'expanded'); assert.equal(rejected.state().pending, false); assert.equal(rejected.frame.srcDoc, 'same-mounted-game-document'); rejected.controller.destroy();
  const throwing = harness(); throwing.root.requestFullscreen = () => { throw new Error('Synthetic synchronous denial'); }; throwing.controller.toggle(); assert.equal(throwing.state().mode, 'expanded'); throwing.controller.destroy();
});

test('expanded focus stays in player, Escape exits from an editable input and cleanup restores scrolling', () => {
  const h = harness(false); h.controller.toggle();
  h.doc.emit('focusin', { target: h.outside }); assert.equal(h.button.focusCalls, 1);
  h.doc.emit('focusin', { target: h.input }); assert.equal(h.button.focusCalls, 1);
  h.key('Escape', h.input); assert.equal(h.state().mode, 'windowed'); assert.equal(h.outside.focusCalls, 1);
  h.controller.toggle(); const published = h.states.length; h.controller.destroy();
  assert.equal(h.doc.body.style.overflow, 'auto'); assert.equal(h.doc.count() + h.win.count(), 0);
  h.win.emit('message', { origin: 'null', source: h.frame.contentWindow, data: { type: 'game-player-display', nonce, action: 'toggle' } });
  assert.equal(h.states.length, published);
});

test('parent keyboard scope ignores unrelated editor typing but allows player F and explicit Alt+Enter', () => {
  const h = harness(false); h.key('f', h.outside); h.key('Enter', h.outside, { altKey: true }); assert.equal(h.states.length, 0);
  h.key('f', h.input); assert.equal(h.states.length, 0);
  assert.equal(h.key('F', h.root).defaultPrevented, true); assert.equal(h.state().mode, 'expanded');
  h.key('Escape', h.input); assert.equal(h.state().mode, 'windowed');
  h.key('Enter', h.input, { altKey: true }); assert.equal(h.state().mode, 'expanded'); h.controller.destroy();
});

test('parent keyboard rejects composition, repeat, IME fallback and browser modifier shortcuts', () => {
  for (const changes of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    const event = { key: 'f', target: null, repeat: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...changes };
    assert.equal(playerDisplayShortcut(event), undefined, JSON.stringify(changes));
  }
});

test('only the live current iframe can request display; stale nonce and extra network fields do nothing', () => {
  const h = harness(false); const oldWindow = h.frame.contentWindow, replacement = h.replaceFrame();
  h.message({ source: oldWindow }); h.message({}, { nonce: 'prior_instance_nonce' }); h.message({}, { endpoint: 'https://unapproved.example.test' }); h.message({ origin: 'https://games.example.test' });
  assert.equal(h.states.length, 0); h.message({ source: replacement.contentWindow }); assert.equal(h.state().mode, 'expanded');
  h.message({}, { action: 'exit' }); assert.equal(h.state().mode, 'windowed'); h.controller.destroy();
});

test('multiple entry attempts coalesce and a cancelled rejected request never opens fallback', async () => {
  const h = harness(); h.controller.toggle(); h.controller.toggle(); assert.equal(h.requests(), 1);
  h.controller.exit(); h.request.reject(new Error('Synthetic cancelled request')); await settle();
  assert.equal(h.state().mode, 'windowed'); assert.equal(h.state().pending, false); assert.equal(h.doc.body.style.overflow, 'auto'); h.controller.destroy();
});

test('pending cancellation followed by late native entry publishes a usable windowed state after asynchronous exit', async () => {
  const h = harness(), closing = deferred();
  h.doc.exitFullscreen = () => closing.promise;
  h.controller.toggle(); h.controller.exit(); h.doc.fullscreenElement = h.root;
  h.request.resolve(); await settle(); h.native(null); closing.resolve(); await settle();
  assert.deepEqual(h.state(), { mode: 'windowed', pending: false, notice: '' }); h.controller.destroy();
});

test('destroy removes listeners and closes only its own late native entry without publishing stale UI', async () => {
  const h = harness(); h.controller.toggle(); const published = h.states.length; h.controller.destroy();
  h.doc.fullscreenElement = h.root; h.request.resolve(); await settle();
  assert.equal(h.doc.fullscreenElement, null); assert.equal(h.states.length, published); assert.equal(h.doc.count() + h.win.count(), 0);
});

test('an obsolete pending controller cannot exit a newer controller on the same mounted root', async () => {
  const h = harness(); h.controller.toggle(); h.controller.destroy();
  const nextRequest = deferred(), newerStates: PlayerDisplayState[] = []; h.root.requestFullscreen = () => nextRequest.promise;
  const newer = createPlayerDisplay({ element: h.root as unknown as HTMLElement, frame: () => h.frame as unknown as HTMLIFrameElement, exitButton: () => h.button as unknown as HTMLButtonElement, nonce: 'new_current_nonce_1234', onChange: state => newerStates.push(state) });
  newer.toggle(); h.native(h.root); nextRequest.resolve(); await settle();
  assert.equal(newerStates.at(-1)?.mode, 'fullscreen');
  h.request.resolve(); await settle();
  assert.equal(h.doc.fullscreenElement, h.root, 'A stale promise must not close the newer owner');
  assert.equal(newerStates.at(-1)?.mode, 'fullscreen'); newer.destroy();
});


test('two roots reserve pending and expanded display exclusively, with one focus trap and balanced scrolling', async () => {
  const h = harness(), otherRoot = new Element(h.doc), otherButton = new Element(h.doc), otherFrame = new Element(h.doc), otherStates: PlayerDisplayState[] = [];
  otherButton.parent = otherFrame.parent = otherRoot;
  const other = createPlayerDisplay({ element: otherRoot as unknown as HTMLElement, frame: () => otherFrame as unknown as HTMLIFrameElement, exitButton: () => otherButton as unknown as HTMLButtonElement, nonce: 'other_current_nonce_1234', onChange: state => otherStates.push(state) });
  h.controller.toggle(); other.toggle();
  assert.equal(h.state().pending, true); assert.equal(otherStates.at(-1)?.mode, 'windowed');
  assert.match(otherStates.at(-1)!.notice, /other player display/u);
  h.controller.exit(); h.request.reject(new Error('Synthetic cancelled native attempt')); await settle();
  assert.equal(h.state().pending, false); other.toggle();
  assert.equal(otherStates.at(-1)?.mode, 'expanded'); assert.equal(h.doc.body.style.overflow, 'hidden');
  h.doc.emit('focusin', { target: h.outside });
  assert.equal(otherButton.focusCalls, 1); assert.equal(h.button.focusCalls, 0, 'The inactive player must not install a competing focus trap');
  other.exit(); assert.equal(otherStates.at(-1)?.mode, 'windowed'); assert.equal(h.doc.body.style.overflow, 'auto');
  h.controller.destroy(); other.destroy(); assert.equal(h.doc.body.style.overflow, 'auto');
});

test('stale cleanup and a late native promise cannot release another root reservation or corrupt its overflow', async () => {
  const h = harness(); h.controller.toggle(); h.controller.destroy();
  const otherRoot = new Element(h.doc), thirdRoot = new Element(h.doc), otherStates: PlayerDisplayState[] = [], thirdStates: PlayerDisplayState[] = [];
  const other = createPlayerDisplay({ element: otherRoot as unknown as HTMLElement, frame: () => null, exitButton: () => null, nonce: 'other_current_nonce_1234', onChange: state => otherStates.push(state) });
  const third = createPlayerDisplay({ element: thirdRoot as unknown as HTMLElement, frame: () => null, exitButton: () => null, nonce: 'third_current_nonce_1234', onChange: state => thirdStates.push(state) });
  other.toggle(); assert.equal(otherStates.at(-1)?.mode, 'expanded');
  h.controller.destroy(); h.doc.fullscreenElement = h.root; h.request.resolve(); await settle();
  assert.equal(otherStates.at(-1)?.mode, 'expanded'); assert.equal(h.doc.body.style.overflow, 'hidden');
  third.toggle(); assert.equal(thirdStates.at(-1)?.mode, 'windowed'); assert.match(thirdStates.at(-1)!.notice, /other player display/u);
  other.destroy(); assert.equal(h.doc.body.style.overflow, 'auto');
  third.toggle(); assert.equal(thirdStates.at(-1)?.mode, 'expanded'); third.exit(); assert.equal(h.doc.body.style.overflow, 'auto'); third.destroy();
});
