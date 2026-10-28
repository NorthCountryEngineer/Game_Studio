import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { defaultGameSpec, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design';
import { createCooperativeEngine, createCooperativePresentation, startCooperativeSandbox, validateCooperativeState, type CooperativeState } from '../src/lib/game-cooperative';
import type { CooperativeGameSpec } from '../src/lib/game-types';

function game(genre: 'collect' | 'dodge' | 'platformer' = 'dodge', rotation = false): CooperativeGameSpec {
  const base = planGameLevels({ ...defaultGameSpec(), genre, rules: { goal: 3, timeLimit: 60, lives: 3, difficulty: 1 }, ...(genre === 'dodge' ? { arcade: { rotation, shooting: true, splitAsteroids: true, scoring: true, highScores: false } } : {}) }, 2, 'synthetic presentation');
  return validateArcadeGameSpec({ ...base, version: 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } }) as CooperativeGameSpec;
}
function active(spec = game()): CooperativeState {
  const state = createCooperativeEngine().create(spec); state.running = true; state.paused = false; state.entities = []; state.nextSnack = 1; state.nextHazard = 1; state.players.forEach(player => { player.invulnerable = 0; }); return state;
}
const almost = (actual: number, expected: number, tolerance = 0.0001) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);

test('guest movement and existing projectiles draw between snapshots without changing gameplay authority', () => {
  const spec = game(), state = active(spec), presentation = createCooperativePresentation(spec);
  state.entities = [{ id: 1, kind: 'hazard', x: state.players[1].x, y: state.players[1].y, w: 42, h: 42, vx: 40, vy: 30, asteroid: 'large' }];
  state.bullets = [{ id: 2, owner: 1, x: 400, y: 300, vx: 620, vy: 0, ttl: 1 }]; state.nextId = 3;
  const original = structuredClone(state); presentation.receive(state, 0); presentation.render(2 | 32, 0);
  const frames = [16, 32, 48, 64, 80].map(now => presentation.render(2 | 32, now)!);
  frames.forEach((view, index) => {
    assert.ok(view.players[1].x > (index ? frames[index - 1].players[1].x : original.players[1].x));
    assert.ok(view.bullets[0].x > (index ? frames[index - 1].bullets[0].x : original.bullets[0].x));
    assert.deepEqual(view.players.map(player => [player.score, player.points, player.lives, player.invulnerable, player.fireCooldown, player.effects]), original.players.map(player => [player.score, player.points, player.lives, player.invulnerable, player.fireCooldown, player.effects]));
    assert.equal(view.elapsed, original.elapsed); assert.equal(view.outcome, original.outcome); assert.equal(view.seed, original.seed); assert.equal(view.nextId, original.nextId); assert.equal(view.bullets.length, original.bullets.length); assert.equal(view.entities.length, original.entities.length);
  });
  assert.deepEqual(state, original, 'drawing must never mutate its source snapshot');
});

test('guest release stops local movement on the next draw without waiting for a host update', () => {
  const spec = game(), presentation = createCooperativePresentation(spec); presentation.receive(active(spec), 0); presentation.render(2, 0);
  presentation.render(2, 40); const released = presentation.render(0, 50)!;
  almost(presentation.render(0, 80)!.players[1].x, released.players[1].x);
  almost(presentation.render(0, 150)!.players[1].x, released.players[1].x);
});

test('prediction freezes at 200 ms and repeated non-advancing snapshots cannot re-arm it', () => {
  const spec = game(), initial = active(spec), presentation = createCooperativePresentation(spec); presentation.receive(initial, 0); presentation.render(2, 0);
  const limit = presentation.render(2, 200)!; assert.equal(presentation.isStale(), true);
  almost(presentation.render(2, 600)!.players[1].x, limit.players[1].x);
  presentation.receive(structuredClone(initial), 700); assert.equal(presentation.isStale(), true);
  almost(presentation.render(2, 900)!.players[1].x, limit.players[1].x);
  const fresh = structuredClone(initial); fresh.elapsed = 0.5; fresh.players[1].x += 30; presentation.receive(fresh, 1000);
  assert.equal(presentation.isStale(), false); almost(presentation.render(0, 1000)!.players[1].x, fresh.players[1].x);
});

test('pause, outcome, life loss, restart, level change, teleport and disconnect reset speculative poses', () => {
  const spec = game();
  for (const alter of [
    (state: CooperativeState) => { state.paused = true; },
    (state: CooperativeState) => { state.outcome = 'lost'; },
    (state: CooperativeState) => { state.players[1].lives--; },
    (state: CooperativeState) => { state.elapsed = 0; },
    (state: CooperativeState) => { state.levelIndex = 1; },
    (state: CooperativeState) => { state.players[1].x = 100; },
  ]) {
    const presentation = createCooperativePresentation(spec), initial = active(spec); initial.elapsed = 1;
    presentation.receive(initial, 0); presentation.render(2, 0); assert.ok(presentation.render(2, 80)!.players[1].x > initial.players[1].x);
    const next = structuredClone(initial); next.elapsed += 0.1; alter(next); presentation.receive(next, 100);
    const reset = presentation.render(0, 100)!; almost(reset.players[1].x, next.players[1].x); assert.equal(reset.players[1].lives, next.players[1].lives); assert.equal(reset.outcome, next.outcome);
  }
  const presentation = createCooperativePresentation(spec); presentation.receive(active(spec), 0); presentation.render(2, 0); presentation.render(2, 50); presentation.reset(); assert.equal(presentation.render(2, 100), undefined);
});

test('render-only movement matches collision-free authoritative movement for each supported control style', () => {
  for (const [genre, rotation, mask] of [['collect', false, 2 | 4], ['dodge', false, 2 | 4], ['dodge', true, 2 | 4], ['platformer', false, 2 | 16]] as const) {
    const spec = game(genre, rotation), authoritative = active(spec), engine = createCooperativeEngine(), presentation = createCooperativePresentation(spec);
    presentation.receive(authoritative, 0); presentation.render(mask, 0);
    let view = presentation.render(mask, 0)!;
    for (let frame = 1; frame <= 6; frame++) { engine.step(authoritative, spec, [0, mask], 1 / 60); view = presentation.render(mask, frame * 1000 / 60)!; }
    almost(view.players[1].x, authoritative.players[1].x); almost(view.players[1].y, authoritative.players[1].y); almost(view.players[1].angle, authoritative.players[1].angle);
  }
});

test('80 ms each-way latency keeps held movement continuous while reconciling 100 ms snapshots', () => {
  const spec = game(), engine = createCooperativeEngine(), host = active(spec), presentation = createCooperativePresentation(spec), deliveries: { at: number; state: CooperativeState }[] = [];
  presentation.receive(host, 80); presentation.render(0, 80);
  const positions: number[] = [], errors: number[] = [];
  for (let frame = 1; frame <= 72; frame++) {
    const now = 80 + frame * 1000 / 60, guestMask = now >= 100 && now < 700 ? 2 : 0, hostMask = now >= 180 && now < 780 ? 2 : 0;
    engine.step(host, spec, [0, hostMask], 1 / 60);
    if (frame % 6 === 0) deliveries.push({ at: now + 80, state: engine.snapshot(host) });
    while (deliveries[0]?.at <= now) presentation.receive(deliveries.shift()!.state, now);
    const view = presentation.render(guestMask, now)!;
    if (now >= 120 && now < 690) { if (positions.length) assert.ok(view.players[1].x > positions.at(-1)! - 0.00001, `local position reversed at ${now} ms`); positions.push(view.players[1].x); }
    errors.push(Math.abs(view.players[1].x - host.players[1].x));
  }
  const steps = positions.slice(1).map((position, index) => position - positions[index]);
  assert.ok(steps.every(value => value > 0.1), `movement increments: ${steps.join(',')}`);
  assert.ok(Math.max(...errors) < (110 + spec.player.speed * 32) * 0.2 + 9);
  assert.equal(presentation.isStale(), false);
});

function sandbox(seat: 0 | 1, spec = game()) {
  const elements = new Map<string, any>(), frames: ((now: number) => void)[] = [], listeners: Record<string, (event: any) => void> = {}, messages: any[] = [], positions: number[] = []; let now = 1000;
  const ctx = new Proxy({}, { get(_target, key) { return key === 'fillText' ? (value: string, x: number) => { if (value === 'P2') positions.push(x); } : () => {}; } });
  function element(id: string) { if (!elements.has(id)) elements.set(id, { textContent: '', handlers: {}, addEventListener(name: string, handler: () => void) { this.handlers[name] = handler; }, focus() {}, getContext: () => ctx }); return elements.get(id); }
  const parent = { postMessage(value: any) { messages.push(structuredClone(value)); } };
  new Script(`const __name = fn => fn; (${startCooperativeSandbox.toString()})(engine, validate, validateState, 'synthetic_coop_test_123');`).runInNewContext({
    engine: createCooperativeEngine(), validate: validateArcadeGameSpec, validateState: validateCooperativeState, parent,
    document: { hidden: false, getElementById: element, querySelectorAll: () => [], addEventListener(name: string, handler: (event: any) => void) { listeners[`document:${name}`] = handler; } },
    window: { addEventListener(name: string, handler: (event: any) => void) { listeners[name] = handler; } }, performance: { now: () => now }, requestAnimationFrame(callback: (value: number) => void) { frames.push(callback); },
  });
  const send = (data: unknown) => listeners.message({ source: parent, data: { nonce: 'synthetic_coop_test_123', ...(data as object) } });
  send({ type: 'game-coop-load', seat, spec }); send({ type: 'game-coop-peer', connected: true });
  return { positions, messages, elements, send, key(key: string, down = true) { listeners[`document:${down ? 'keydown' : 'keyup'}`]({ key, target: { tagName: 'CANVAS' }, preventDefault() {} }); }, click(id: string) { element(id).handlers.click(); }, tick(count = 1) { for (let index = 0; index < count; index++) frames.shift()!(now += 1000 / 60); } };
}

test('sandbox sends press/release without RAF and draws guest movement before the next host snapshot', () => {
  const spec = game(), guest = sandbox(1, spec), state = active(spec); guest.send({ type: 'game-coop-state', seq: 1, state });
  const original = guest.positions.at(-1)!; guest.key('ArrowRight'); assert.equal(guest.messages.at(-1).mask, 2);
  guest.tick(3); assert.ok(guest.positions.at(-1)! > original);
  guest.key('ArrowRight', false); assert.equal(guest.messages.at(-1).mask, 0); const released = guest.positions.at(-1)!;
  guest.tick(3); almost(guest.positions.at(-1)!, released); assert.equal(guest.messages.some(message => message.type === 'game-coop-state'), false);
});

test('host executes a released fire edge once and rejects malformed or replayed pressed masks', () => {
  const host = sandbox(0); host.click('start');
  for (const pressedMask of [64, -1, 1.5, '32', null]) host.send({ type: 'game-coop-input', seq: 1, mask: 0, pressedMask });
  host.tick(8); assert.equal(host.messages.at(-1).state.bullets.filter((bullet: any) => bullet.owner === 1).length, 0);
  host.send({ type: 'game-coop-input', seq: 1, mask: 0, pressedMask: 32 }); host.tick(8);
  assert.equal(host.messages.at(-1).state.bullets.filter((bullet: any) => bullet.owner === 1).length, 1);
  host.send({ type: 'game-coop-input', seq: 1, mask: 0, pressedMask: 32 }); host.tick(8);
  assert.equal(host.messages.at(-1).state.bullets.filter((bullet: any) => bullet.owner === 1).length, 1);
});

test('released jump edges get one host physics tick and pause/reconnect revoke pending edges', () => {
  const spec = game('platformer'), host = sandbox(0, spec); host.click('start'); host.tick(2);
  host.send({ type: 'game-coop-input', seq: 1, mask: 0, pressedMask: 16 }); host.tick(8);
  assert.ok(host.messages.at(-1).state.players[1].vy < 0);
  const reset = sandbox(0); reset.click('start'); reset.send({ type: 'game-coop-input', seq: 1, mask: 0, pressedMask: 32 }); reset.click('pause'); reset.click('pause'); reset.tick(8);
  assert.equal(reset.messages.at(-1).state.bullets.filter((bullet: any) => bullet.owner === 1).length, 0);
  reset.send({ type: 'game-coop-input', seq: 2, mask: 0, pressedMask: 32 }); reset.send({ type: 'game-coop-peer', connected: false }); reset.send({ type: 'game-coop-peer', connected: true }); reset.click('pause'); reset.tick(8);
  assert.equal(reset.messages.at(-1).state.bullets.filter((bullet: any) => bullet.owner === 1).length, 0);
});
