import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import { defaultGameSpec, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design';
import { createGameEngine, gameSandboxDocument, validateGameResult } from '../src/lib/game-runtime';
import type { ArcadeGameSpec } from '../src/lib/game-types';

function platformer(): ArcadeGameSpec {
  const spec = planGameLevels(defaultGameSpec(), 2, 'A pixel platform adventure');
  return validateArcadeGameSpec({ ...spec, version: 7, genre: 'platformer', player: { ...spec.player, speed: 2, jump: 6 }, levels: spec.levels!.map((level, i) => ({ ...level, theme: i ? 'space' : 'garden', rules: { goal: 3 + i * 3, timeLimit: 90, lives: 5, difficulty: 1 } })) });
}

test('pixel platformers walk left and right, jump once per press, and reach every surface at minimum settings', () => {
  const engine = createGameEngine(), spec = platformer();
  for (let seed = 1; seed <= 30; seed++) for (const level of spec.levels!) {
    level.seed = seed * 97;
    const initial = engine.create(spec, level.id); initial.entities = [];
    const x = initial.player.x;
    engine.step(initial, spec, { right: true }, 1 / 60); assert.ok(initial.player.x > x);
    engine.step(initial, spec, { left: true }, 1 / 60); assert.equal(initial.player.x, x);
    for (let i = 1; i < initial.platforms.length; i++) for (const dt of [1 / 60, 1 / 20]) {
      const state = engine.create(spec, level.id); state.entities = [];
      const below = state.platforms[i - 1], above = state.platforms[i];
      const left = Math.max(below.x, above.x), right = Math.min(below.x + below.w, above.x + above.w);
      state.player.x = (left + right - state.player.w) / 2;
      state.player.y = below.y - state.player.h; state.player.grounded = true;
      engine.step(state, spec, { jump: true }, dt);
      assert.ok(state.player.vy < 0);
      for (let j = 0; j < 100 && !state.player.grounded; j++) engine.step(state, spec, { jump: true }, dt);
      assert.equal(state.player.y + state.player.h, above.y, `seed ${seed}, ${level.id}, surface ${i}, dt ${dt}`);
      engine.step(state, spec, { jump: true }, dt); assert.equal(state.player.grounded, true, 'Holding Jump cannot auto-jump');
      engine.step(state, spec, {}, dt); engine.step(state, spec, { jump: true }, dt); assert.ok(state.player.vy < 0, 'Releasing and pressing jumps again');
    }
  }
});

test('every themed level can be completed through walking and jump inputs with the actual collectible and points rules', () => {
  const engine = createGameEngine(), spec = platformer();
  for (let seed = 1; seed <= 20; seed++) for (const level of spec.levels!) {
    level.seed = seed * 97;
    const state = engine.create(spec, level.id);
    // This is an accessibility-of-layout check: remove moving hazards so their
    // damage/respawn cannot mask whether the coin route itself is reachable.
    state.entities = state.entities.filter(entity => entity.kind === 'snack');
    const tick = (input = {}) => engine.step(state, spec, input, 1 / 60);
    const walk = (center: number) => {
      for (let frame = 0; frame < 800 && state.outcome === 'playing'; frame++) {
        const difference = center - state.player.x - state.player.w / 2;
        if (Math.abs(difference) < 3) break;
        tick({ left: difference < 0, right: difference > 0 });
      }
    };
    const land = () => { for (let frame = 0; frame < 800 && state.outcome === 'playing' && !state.player.grounded; frame++) tick(); };
    for (let round = 0; round < 8 && state.outcome === 'playing'; round++) {
      for (let tier = 0; tier < state.platforms.length && state.outcome === 'playing'; tier++) {
        const surface = state.platforms[tier];
        for (let pass = 0; pass < 40 && state.outcome === 'playing'; pass++) {
          const coin = state.entities.filter(entity => entity.kind === 'snack' && Math.abs(entity.y + entity.h - surface.y) < 1).sort((a, b) => Math.abs(a.x - state.player.x) - Math.abs(b.x - state.player.x))[0];
          if (!coin) break; walk(coin.x + coin.w / 2);
        }
        if (tier + 1 < state.platforms.length && state.outcome === 'playing') {
          const above = state.platforms[tier + 1], left = Math.max(surface.x, above.x), right = Math.min(surface.x + surface.w, above.x + above.w);
          walk((left + right) / 2); tick({ jump: true }); land();
        }
      }
      if (state.outcome === 'playing') { walk(935); land(); }
    }
    assert.equal(state.outcome, 'won', `seed ${seed}, ${level.theme}`);
    assert.equal(state.score, level.rules.goal); assert.equal(state.points, level.rules.goal * 10);
    assert.ok(state.elapsed < level.rules.timeLimit);
  }
});

test('platformer collectibles award exactly ten points and validate selected and reordered campaign results', () => {
  const engine = createGameEngine(), spec = platformer(), state = engine.create(spec);
  assert.equal(engine.scoring(spec), true); assert.equal(state.points, 0);
  state.score = 2; state.points = 20;
  state.entities = [1, 2].map(id => ({ id, kind: 'snack' as const, x: state.player.x, y: state.player.y, w: 22, h: 22, vx: 0, vy: 0 }));
  engine.step(state, spec, {}, 1 / 60);
  assert.equal(state.score, 3); assert.equal(state.points, 30); assert.equal(state.outcome, 'won');
  assert.equal(engine.maxPoints(spec), 90); assert.equal(engine.maxPoints(spec, ['level-2']), 60);
  const selected = { outcome: 'level-complete', elapsed: 5, score: 6, points: 60, reviewedLevelIds: ['level-2'] };
  assert.deepEqual(validateGameResult(selected, spec, 'level-2'), selected);
  for (const points of [undefined, 0, 59, 61, 60.1, NaN]) assert.equal(validateGameResult({ ...selected, points }, spec, 'level-2'), undefined);
  spec.flow = { version: 1, nodes: [{ id: 'step-1', type: 'level', levelId: 'level-2' }, { id: 'step-2', type: 'material', title: 'A short exercise', kind: 'exercise', reference: 'client:exercise-1', required: true }, { id: 'step-3', type: 'level', levelId: 'level-1' }] };
  assert.deepEqual(validateGameResult(selected, spec), selected);
  assert.equal(validateGameResult({ ...selected, reviewedLevelIds: ['level-1'] }, spec), undefined);
  const completed = { outcome: 'won', elapsed: 10, score: 9, points: 90, reviewedLevelIds: ['level-2', 'level-1'] };
  assert.deepEqual(validateGameResult(completed, spec), completed);
  assert.equal(validateGameResult({ ...completed, reviewedLevelIds: ['level-1', 'level-2'] }, spec), undefined);
  const legacy = defaultGameSpec(); assert.equal(engine.scoring(legacy), false); assert.equal(engine.create(legacy).points, undefined);
});

test('eight distinct pixel adventurers have diverse appearances and cosmetic drawing never mutates game state', () => {
  const engine = createGameEngine(), state = engine.create(platformer()), original = structuredClone(state);
  assert.equal(engine.characters.length, 8); assert.equal(new Set(engine.characters.map(item => item.id)).size, 8);
  assert.ok(new Set(engine.characters.map(item => item.skin)).size >= 6);
  assert.ok(new Set(engine.characters.map(item => item.hair)).size >= 6);
  assert.equal(engine.characters.some(item => item.glasses), true);
  const rectangles: unknown[] = [], ctx = new Proxy({}, { get: (_object, key) => key === 'fillRect' ? (...args: unknown[]) => rectangles.push(args) : () => {} }) as CanvasRenderingContext2D;
  for (const character of engine.characters) engine.drawCharacter(ctx, character.id, state.player.x, state.player.y, 42, 46, 1, -1);
  assert.ok(rectangles.length > 500); assert.deepEqual(state, original);
});

type Handler = (event: any) => void;
class Element {
  textContent = ''; disabled = false; hidden = false; type = ''; width = 0; height = 0;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; children: Element[] = []; handlers: Record<string, Handler[]> = {}; parentElement?: Element;
  paints: string[] = [];
  addEventListener(name: string, callback: Handler) { (this.handlers[name] ||= []).push(callback); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  append(...items: Element[]) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
  replaceChildren() { this.children = []; }
  querySelectorAll() { return this.children; }
  closest(selector: string) { return selector === '[data-character]' && this.dataset.character ? this : null; }
  focus() {} setPointerCapture() {}
  fire(name: string, event: any = {}) { for (const callback of this.handlers[name] || []) callback({ target: this, preventDefault() {}, ...event }); }
  getContext() {
    const canvas = this;
    return new Proxy({ fillStyle: '' }, { get(object, key) { if (key === 'fillStyle') return object.fillStyle; if (key === 'fillRect') return () => canvas.paints.push(object.fillStyle); return () => {}; } });
  }
}
function boot(preferred: unknown = undefined, fixture = platformer(), observe?: (engine: ReturnType<typeof createGameEngine>) => ReturnType<typeof createGameEngine>) {
  const nonce = 'platformer_nonce_12345', elements = new Map<string, Element>(), messages: any[] = [], frames: ((time: number) => void)[] = [], listeners: Record<string, Handler> = {}, documentListeners: Record<string, Handler[]> = {};
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const controls = ['left', 'right', 'up', 'down', 'jump', 'fire'].map(name => { const button = element(name); button.dataset.control = name; return button; });
  const parent = { postMessage(message: unknown) { messages.push(JSON.parse(JSON.stringify(message))); } };
  const ctx = createContext({ parent, atob, btoa, observe, document: { hidden: false, getElementById: element, createElement: () => new Element(), querySelectorAll: () => controls, addEventListener(name: string, callback: Handler) { (documentListeners[name] ||= []).push(callback); } }, window: { addEventListener(name: string, callback: Handler) { listeners[name] = callback; } }, requestAnimationFrame(callback: (time: number) => void) { frames.push(callback); } });
  const html = gameSandboxDocument(nonce);
  let script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/u)![1];
  if (observe) script = script.replace(`(${createGameEngine.toString()})()`, `observe((${createGameEngine.toString()})())`);
  new Script(script).runInContext(ctx);
  new Script(`globalThis.fixture = ${JSON.stringify(fixture)};`).runInContext(ctx);
  const load = (source: unknown = parent, channel = nonce) => listeners.message({ source, data: { type: 'axolotl-game-load', nonce: channel, spec: ctx.fixture, characterId: preferred } });
  let clock = 1000;
  const tick = () => { const frame = frames.shift(); assert.ok(frame); frame(clock += 1000 / 60); };
  return { html, messages, load, element, controls, tick, documentListeners };
}

test('actual opaque sandbox validates load, offers keyboard/touch character buttons, and preserves selected cosmetic on restart/remount', () => {
  const game = boot('nora'); game.load({}, 'platformer_nonce_12345'); game.load(undefined, 'wrong');
  assert.equal(game.messages.length, 1); game.load();
  assert.equal(game.messages.at(-1).type, 'axolotl-game-loaded');
  const picker = game.element('characters'); assert.equal(picker.children.length, 8);
  assert.equal(picker.children.find(item => item.dataset.character === 'nora')!.attributes['aria-pressed'], 'true');
  const robin = picker.children.find(item => item.dataset.character === 'robin')!;
  assert.match(robin.attributes['aria-label'], /Dark brown skin, silver hair/);
  // Native buttons provide Enter/Space and touch/click activation; game shortcuts
  // must not consume Space while a character button has keyboard focus.
  let prevented = false;
  for (const callback of game.documentListeners.keydown) callback({ key: ' ', target: robin, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  robin.fire('click');
  assert.deepEqual(game.messages.at(-1), { type: 'axolotl-game-character', nonce: 'platformer_nonce_12345', characterId: 'robin' });
  assert.equal(robin.attributes['aria-pressed'], 'true');
  game.element('start').fire('click'); assert.equal(picker.hidden, true);
  assert.equal(game.element('up').hidden, true); assert.equal(game.element('down').hidden, true); assert.equal(game.element('jump').hidden, false);
  game.element('right').fire('pointerdown', { pointerId: 1 }); game.tick(); game.tick(); game.element('right').fire('pointerup');
  game.element('jump').fire('pointerdown', { pointerId: 2 }); game.tick(); game.element('jump').fire('pointerup');
  const count = game.messages.filter(item => item.type === 'axolotl-game-character').length;
  robin.fire('click'); assert.equal(game.messages.filter(item => item.type === 'axolotl-game-character').length, count, 'Hidden picker cannot change a running game');
  for (const callback of game.documentListeners.keydown) callback({ key: 'r', target: game.element('game'), repeat: false, preventDefault() {} });
  assert.deepEqual(game.messages.at(-1), { type: 'axolotl-game-character', nonce: 'platformer_nonce_12345', characterId: 'robin' });
  const remounted = boot('robin'); remounted.load(); assert.equal(remounted.element('characters').children.find(item => item.dataset.character === 'robin')!.attributes['aria-pressed'], 'true');
  const invalid = boot('javascript:unsafe'); invalid.load(); assert.equal(invalid.element('characters').children[0].attributes['aria-pressed'], 'true');
  assert.match(game.html, /connect-src 'none'/); assert.match(game.html, /img-src 'none'/); assert.match(game.html, /media-src 'none'/);
});


test('actual serialized platformer completes both levels with ordinary controls and reports aggregate points', () => {
  const spec = platformer();
  for (const level of spec.levels!) { level.seed = 194; level.rules.goal = 6; }
  let state: ReturnType<ReturnType<typeof createGameEngine>['create']>;
  const game = boot('kai', spec, engine => ({ ...engine, create(...args) { state = engine.create(...args); return state; } }));
  game.load(); game.tick();
  const setInput = (input: { left?: boolean; right?: boolean; jump?: boolean } = {}) => {
    for (const name of ['left', 'right', 'jump'] as const) game.element(name).fire(input[name] ? 'pointerdown' : 'pointerup', { pointerId: 1 });
    game.tick();
  };
  for (let levelIndex = 0; levelIndex < 2; levelIndex++) {
    game.element(levelIndex ? 'next' : 'start').fire('click');
    const walk = (center: number) => {
      for (let frame = 0; frame < 800 && state.outcome === 'playing'; frame++) {
        const difference = center - state.player.x - state.player.w / 2;
        if (Math.abs(difference) < 4) break;
        setInput({ left: difference < 0, right: difference > 0 });
      }
      setInput();
    };
    for (let round = 0; round < 5 && state!.outcome === 'playing'; round++) {
      for (let tier = 0; tier < state!.platforms.length && state!.outcome === 'playing'; tier++) {
        const surface = state!.platforms[tier];
        for (let pass = 0; pass < 40 && state!.outcome === 'playing'; pass++) {
          const coin = state!.entities.filter(entity => entity.kind === 'snack' && Math.abs(entity.y + entity.h - surface.y) < 1).sort((a, b) => Math.abs(a.x - state!.player.x) - Math.abs(b.x - state!.player.x))[0];
          if (!coin) break; walk(coin.x + coin.w / 2);
        }
        if (tier + 1 < state!.platforms.length && state!.outcome === 'playing') {
          const above = state!.platforms[tier + 1];
          walk((Math.max(surface.x, above.x) + Math.min(surface.x + surface.w, above.x + above.w)) / 2);
          setInput({ jump: true });
          for (let frame = 0; frame < 800 && !state!.player.grounded && state!.outcome === 'playing'; frame++) setInput();
        }
      }
    }
    assert.equal(state!.outcome, 'won'); setInput();
    const result = game.messages.filter(item => item.type === 'axolotl-game-result').at(-1)?.result;
    assert.equal(result.outcome, levelIndex ? 'won' : 'level-complete');
    assert.equal(result.score, (levelIndex + 1) * 6); assert.equal(result.points, (levelIndex + 1) * 60);
    assert.deepEqual(result.reviewedLevelIds, spec.levels!.slice(0, levelIndex + 1).map(level => level.id));
    assert.deepEqual(validateGameResult(result, spec), result);
  }
});
