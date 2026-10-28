import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import { defaultGameSpec, planGameLevels } from '../src/lib/game-design.ts';
import { gameSandboxDocument } from '../src/lib/game-runtime.ts';
import { cooperativeGameSandboxDocument } from '../src/lib/game-cooperative.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';
import { wordGameSandboxDocument } from '../src/lib/word-game-runtime.ts';

const nonce = 'keyboard_bridge_123456';
type Handler = (event: any) => void;
class Element {
  tagName: string; textContent = ''; value = ''; disabled = false; hidden = false; isContentEditable = false;
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; attributes: Record<string, string> = {};
  children: Element[] = []; parentElement?: Element; handlers: Record<string, Handler[]> = {};
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  addEventListener(name: string, fn: Handler) { (this.handlers[name] ||= []).push(fn); }
  append(node: Element) { node.parentElement = this; this.children.push(node); }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getContext() { return new Proxy({}, { get: (_target, key) => key === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {} }); }
  focus() {} setPointerCapture() {}
  closest() {
    for (let node: Element | undefined = this; node; node = node.parentElement) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) || node.isContentEditable || node.attributes.role === 'textbox' || 'contenteditable' in node.attributes && node.attributes.contenteditable !== 'false') return node;
    }
    return null;
  }
}
const documents = [
  { name: 'arcade', render: gameSandboxDocument, ready: 'axolotl-game-ready', loaded: 'axolotl-game-loaded', load: 'axolotl-game-load', spec: defaultGameSpec(), extra: {} },
  { name: 'word', render: wordGameSandboxDocument, ready: 'axolotl-game-ready', loaded: 'axolotl-game-loaded', load: 'axolotl-game-load', spec: defaultWordGameSpec('mad-libs'), extra: {} },
  { name: 'cooperative', render: cooperativeGameSandboxDocument, ready: 'game-coop-ready', loaded: 'game-coop-loaded', load: 'game-coop-load', spec: { ...planGameLevels(defaultGameSpec(), 2, 'Synthetic cooperative levels'), version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } }, extra: { seat: 0 } },
];
function boot(format: typeof documents[number], channel = nonce) {
  const elements = new Map<string, Element>(), messages: any[] = [], keyHandlers: Handler[] = [], windowHandlers: Record<string, Handler> = {};
  const getElement = (id: string) => { if (!elements.has(id)) elements.set(id, new Element(id === 'game' ? 'canvas' : ['start', 'pause', 'next', 'restart', 'finish-review'].includes(id) ? 'button' : 'div')); return elements.get(id)!; };
  const parent = { postMessage(message: unknown, targetOrigin: string) { assert.equal(targetOrigin, '*'); messages.push(JSON.parse(JSON.stringify(message))); } };
  const context = createContext({ parent, document: { hidden: false, getElementById: getElement, createElement: (tag: string) => new Element(tag), querySelectorAll: () => [], addEventListener(name: string, fn: Handler) { if (name === 'keydown') keyHandlers.push(fn); } }, window: { addEventListener(name: string, fn: Handler) { windowHandlers[name] = fn; } }, requestAnimationFrame() {}, performance: { now: () => 100 }, structuredClone, atob, btoa });
  const html = format.render(channel);
  new Script(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/u)![1]).runInContext(context);
  new Script(`globalThis.fixtureSpec = ${JSON.stringify(format.spec)};`).runInContext(context);
  const load = (source: unknown = parent, value = channel) => windowHandlers.message({ source, data: { type: format.load, nonce: value, spec: context.fixtureSpec, ...format.extra } });
  function key(key: string, changes: Record<string, unknown> = {}) {
    const event = { key, target: getElement('game'), defaultPrevented: false, repeat: false, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...changes };
    for (const fn of keyHandlers) { fn(event); if (event.propagationStopped) break; } return event;
  }
  return { html, messages, load, key, getElement, display: () => messages.filter(value => value.type === 'game-player-display') };
}
for (const format of documents) {
  test(`${format.name}: actual serialized runtime sends exact nonce-bound F and Alt+Enter display requests`, () => {
    const game = boot(format);
    assert.deepEqual(game.messages, [{ type: format.ready, nonce }]);
    game.load({}, nonce); game.load(undefined, 'wrong_nonce');
    assert.equal(game.messages.length, 1, 'Foreign source and wrong nonce cannot load the game');
    game.load(); assert.equal(game.messages.at(-1).type, format.loaded);
    for (const [key, changes] of [['f', {}], ['F', { shiftKey: true }], ['Enter', { altKey: true }]] as const) { const event = game.key(key, changes); assert.equal(event.defaultPrevented, true); assert.equal(event.propagationStopped, true); }
    assert.deepEqual(game.display(), Array.from({ length: 3 }, () => ({ type: 'game-player-display', nonce, action: 'toggle' })));
    assert.equal(game.key('Escape').defaultPrevented, format.name === 'arcade', 'The display bridge leaves native Escape handling intact');
    assert.deepEqual(game.display().at(-1), { type: 'game-player-display', nonce, action: 'exit' });
    assert.equal(game.messages.filter(value => value.type === format.ready).length, 1, 'Shortcuts never reboot the runtime');
    assert.equal(game.messages.some(value => value.type === 'axolotl-game-result'), false);
    assert.doesNotMatch(game.html, /requestFullscreen|exitFullscreen|allowfullscreen/iu);
    assert.match(game.html, /connect-src 'none'/u);
  });
  test(`${format.name}: typing, editable ancestors, IME, repeats and reserved modifiers never emit display requests`, () => {
    const game = boot(format); game.load();
    for (const target of [new Element('input'), new Element('textarea'), new Element('select'), Object.assign(new Element(), { isContentEditable: true })]) {
      for (const key of ['f', 'F']) game.key(key, { target });
    }
    const editor = new Element(); editor.attributes.contenteditable = 'true'; const child = new Element('span'); editor.append(child); game.key('f', { target: child });
    const textbox = new Element(); textbox.attributes.role = 'textbox'; const nested = new Element(); textbox.append(nested); game.key('F', { target: nested });
    for (const changes of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true }]) game.key('f', changes);
    for (const changes of [{ altKey: true, repeat: true }, { altKey: true, isComposing: true }, { altKey: true, ctrlKey: true }, { altKey: true, metaKey: true }]) game.key('Enter', changes);
    for (const key of ['x', 'q', '1', 'Enter', 'Shift', 'Dead', 'Process']) game.key(key);
    assert.deepEqual(game.display(), []);
    assert.equal(game.messages.some(value => 'key' in value || 'value' in value || 'text' in value), false, 'No typed content leaves the fixed iframe');
  });
  test(`${format.name}: explicit Alt+Enter and Escape remain available while a puzzle answer has focus`, () => {
    const game = boot(format); game.load(); const input = new Element('input'); input.value = 'Private typed answer';
    assert.equal(game.key('Enter', { target: input, altKey: true }).defaultPrevented, true);
    game.key('Escape', { target: input });
    assert.deepEqual(game.display(), [{ type: 'game-player-display', nonce, action: 'toggle' }, { type: 'game-player-display', nonce, action: 'exit' }]);
    assert.equal(input.value, 'Private typed answer');
    assert.equal(JSON.stringify(game.messages).includes('Private typed answer'), false);
  });
  test(`${format.name}: new document nonce remains isolated from the previous runtime`, () => {
    const current = boot(format, 'new_keyboard_nonce_1234'); current.key('f');
    assert.deepEqual(current.display(), [{ type: 'game-player-display', nonce: 'new_keyboard_nonce_1234', action: 'toggle' }]);
    assert.throws(() => format.render('unsafe nonce'));
  });
}


test('serialized solo and cooperative players load bounded custom pixels without image URLs or network', () => {
  const sprites = { player: { width: 1, height: 1, pixels: btoa('\xff\0\0\xff') }, asteroid: { width: 1, height: 1, pixels: btoa('\0\xff\0\xff') } };
  const base = { ...planGameLevels(defaultGameSpec(), 1, 'sprites'), version: 6, genre: 'dodge', theme: 'space', arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: false }, asteroids: { endless: true, difficultyInterval: 30, sizes: 3, enemies: { enabled: false, difficulty: 'easy', hitPoints: 1, spawnInterval: 15, maxShips: 2 } }, sprites };
  for (const format of [documents[0], documents[2]]) {
    const spec = { ...base, ...(format.name === 'cooperative' ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 } } : {}) };
    const h = boot({ ...format, spec } as typeof documents[number]); h.load();
    assert.equal(h.messages.at(-1).type, format.loaded);
    assert.match(h.html, /connect-src 'none'/);
    assert.match(h.html, /img-src 'none'/);
  }
});
