import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { defaultGameSpec, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { createGameEngine, gameSandboxDocument, type GameState, type GamePowerUpPickup } from '../src/lib/game-runtime.ts';
import { cooperativeGameSandboxDocument, createCooperativeEngine, validateCooperativeState } from '../src/lib/game-cooperative.ts';
import type { ArcadeGameSpec, CooperativeGameSpec } from '../src/lib/game-types.ts';

function game(cooperative = false): ArcadeGameSpec {
  const planned = planGameLevels({ ...defaultGameSpec(), genre: 'dodge', rules: { goal: 40, timeLimit: 180, lives: 5, difficulty: 1 }, arcade: { rotation: false, shooting: true, splitAsteroids: true, scoring: true, highScores: true } }, 2, 'synthetic prizes');
  return validateArcadeGameSpec({ ...planned, version: 5, powerUps: { spawnInterval: 5, duration: 10, types: ['triple-shot', 'rapid-fire', 'shield', 'speed-boost'] }, ...(cooperative ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 } } : {}) });
}
function safe(state: GameState) { state.entities = []; state.nextSnack = 1; state.nextHazard = 1; }
function pickup(state: GameState, type: GamePowerUpPickup['type']) {
  state.powerUps!.pickups.push({ id: state.nextId++, type, x: state.player.x, y: state.player.y, ttl: 12 });
}

test('prizes spawn periodically from the seeded world, stay bounded, fall and expire without changing old state shapes', () => {
  const engine = createGameEngine(), spec = game(), a = engine.create(spec), b = engine.create(spec);
  assert.equal(a.powerUps!.nextSpawn, 5); assert.deepEqual(a.powerUps!.pickups, []);
  for (let i = 0; i < 301; i++) for (const state of [a, b]) { safe(state); engine.step(state, spec, {}, 1 / 60); }
  assert.deepEqual(a, b); assert.equal(a.powerUps!.pickups.length, 1);
  assert.ok(a.powerUps!.pickups[0].y > -28); assert.ok(spec.powerUps!.types.includes(a.powerUps!.pickups[0].type));
  a.powerUps!.nextSpawn = 1; a.powerUps!.pickups[0].ttl = 0.01; engine.step(a, spec, {}, 1 / 20); assert.equal(a.powerUps!.pickups.length, 0);
  a.powerUps!.pickups = Array.from({ length: 3 }, (_, i) => ({ id: a.nextId++, type: 'shield', x: i * 80, y: 100, ttl: 12 }));
  a.powerUps!.nextSpawn = 0; engine.step(a, spec, {}, 1 / 60); assert.equal(a.powerUps!.pickups.length, 3);
  for (const old of [defaultGameSpec(), { ...game(), version: 2, powerUps: undefined }]) {
    const state = engine.create(old as ArcadeGameSpec); assert.equal('powerUps' in state, false);
  }
});

test('triple shot produces exactly three diverging rounds from one trigger and combines with rapid fire', () => {
  const engine = createGameEngine(), spec = game(), state = engine.create(spec); safe(state);
  pickup(state, 'triple-shot'); engine.step(state, spec, { fire: true }, 1 / 60);
  assert.equal(state.powerUps!.pickups.length, 0); assert.equal(state.bullets!.length, 3);
  const shots = state.bullets!; assert.ok(shots[0].vx < 0); assert.ok(Math.abs(shots[1].vx) < 1e-8); assert.ok(shots[2].vx > 0);
  assert.ok(shots.every(shot => shot.vy < -600)); assert.equal(new Set(shots.map(shot => shot.id)).size, 3);
  state.bullets = []; state.fireCooldown = 0; pickup(state, 'rapid-fire'); engine.step(state, spec, { fire: true }, 1 / 60);
  assert.equal(state.bullets.length, 3); assert.equal(state.fireCooldown, 0.08); assert.ok(state.powerUps!.effects.tripleShot > 0);
});

test('holding fire during rapid-fire creates a denser stream and timed effects refresh instead of stacking', () => {
  const engine = createGameEngine(), spec = game(), normal = engine.create(spec), rapid = engine.create(spec);
  rapid.powerUps!.effects.rapidFire = 10;
  for (let i = 0; i < 120; i++) for (const state of [normal, rapid]) { safe(state); engine.step(state, spec, { fire: true }, 1 / 60); }
  assert.ok(rapid.nextId > normal.nextId * 2, `normal=${normal.nextId}, rapid=${rapid.nextId}`);
  pickup(rapid, 'rapid-fire'); engine.step(rapid, spec, {}, 1 / 60); assert.equal(rapid.powerUps!.effects.rapidFire, 10);
  pickup(rapid, 'rapid-fire'); engine.step(rapid, spec, {}, 1 / 60); assert.equal(rapid.powerUps!.effects.rapidFire, 10);
  rapid.powerUps!.effects.rapidFire = 0.01; rapid.fireCooldown = 0; engine.step(rapid, spec, { fire: true }, 1 / 20);
  assert.equal(rapid.powerUps!.effects.rapidFire, 0); assert.equal(rapid.fireCooldown, 0.22);
});

test('shield absorbs one additional hit without stacking and protects against simultaneous hazards', () => {
  const engine = createGameEngine(), spec = game(), state = engine.create(spec); safe(state);
  pickup(state, 'shield'); pickup(state, 'shield'); engine.step(state, spec, {}, 1 / 60); assert.equal(state.powerUps!.effects.shield, 1);
  state.invulnerable = 0;
  state.entities = [1, 2].map(() => ({ id: state.nextId++, kind: 'hazard', asteroid: 'small', x: state.player.x, y: state.player.y, w: 20, h: 20, vx: 0, vy: 0 }));
  engine.step(state, spec, {}, 1 / 60); assert.equal(state.lives, 5); assert.equal(state.powerUps!.effects.shield, 0);
  state.invulnerable = 0; engine.step(state, spec, {}, 1 / 60); assert.equal(state.lives, 4);
});

test('speed boost multiplies translation, expires, and all effects reset on level or game restart', () => {
  const engine = createGameEngine(), spec = game(), normal = engine.create(spec), boosted = engine.create(spec);
  for (const state of [normal, boosted]) { safe(state); state.player.x = 300; state.player.y = 300; }
  boosted.powerUps!.effects.speedBoost = 10;
  engine.step(normal, spec, { right: true }, 1 / 20); engine.step(boosted, spec, { right: true }, 1 / 20);
  assert.ok(Math.abs((boosted.player.x - 300) / (normal.player.x - 300) - 1.6) < 1e-10);
  boosted.powerUps!.effects.speedBoost = 0.01; const x = boosted.player.x; engine.step(boosted, spec, { right: true }, 1 / 20);
  assert.ok(Math.abs(boosted.player.x - x - (normal.player.x - 300)) < 1e-10);
  boosted.powerUps!.effects = { shield: 1, tripleShot: 10, rapidFire: 10, speedBoost: 10 }; boosted.outcome = 'won';
  for (const state of [engine.create(spec), engine.nextLevel(boosted, spec)!]) assert.deepEqual(state.powerUps, { pickups: [], nextSpawn: 5, effects: { shield: 0, tripleShot: 0, rapidFire: 0, speedBoost: 0 } });
  const before = structuredClone(boosted); engine.step(boosted, spec, { fire: true }, 0); assert.deepEqual(boosted, before);
});

test('cooperative prizes affect only the collecting ship and preserve bullet ownership without friendly fire', () => {
  const spec = game(true) as CooperativeGameSpec, engine = createCooperativeEngine(), state = engine.create(spec);
  state.running = true; state.paused = false; state.entities = []; state.nextHazard = state.nextSnack = 1;
  state.powerUps!.pickups = ['triple-shot', 'rapid-fire', 'shield', 'speed-boost'].map(type => ({ id: state.nextId++, type: type as GamePowerUpPickup['type'], x: state.players[1].x, y: state.players[1].y, ttl: 12 }));
  // Collect at most three pickups in an actual world; fourth is fed next frame.
  const fourth = state.powerUps!.pickups.pop()!;
  engine.step(state, spec, [0, 32], 1 / 60); assert.equal(state.powerUps!.pickups.length, 0);
  assert.deepEqual(state.players[0].effects, { shield: 0, tripleShot: 0, rapidFire: 0, speedBoost: 0 });
  assert.equal(state.players[1].effects!.shield, 1); assert.equal(state.bullets.length, 3); assert.ok(state.bullets.every(b => b.owner === 1));
  state.powerUps!.pickups.push(fourth); engine.step(state, spec, [0, 0], 1 / 60); assert.equal(state.players[1].effects!.speedBoost, 10);
  state.bullets = [{ id: state.nextId++, owner: 1, x: state.players[0].x + 10, y: state.players[0].y + 10, vx: 0, vy: 0, ttl: 1 }];
  state.players[0].invulnerable = 0; engine.step(state, spec, [0, 0], 1 / 60); assert.equal(state.players[0].lives, 5);
  state.paused = true; const paused = structuredClone(state); engine.step(state, spec, [63, 63], 10); assert.deepEqual(state, paused);
  assert.ok(validateCooperativeState(engine.snapshot(state), spec));
});

test('cooperative shield is personal, timed buffs expire, and level restart resets both ships', () => {
  const spec = game(true) as CooperativeGameSpec, engine = createCooperativeEngine(), state = engine.create(spec);
  state.running = true; state.paused = false; state.nextHazard = state.nextSnack = 1;
  state.players.forEach(player => { player.invulnerable = 0; player.effects!.rapidFire = 0.01; }); state.players[1].effects!.shield = 1;
  state.entities = state.players.map(player => ({ id: state.nextId++, kind: 'hazard', asteroid: 'small', x: player.x, y: player.y, w: 20, h: 20, vx: 0, vy: 0 }));
  engine.step(state, spec, [0, 0], 1 / 20); assert.deepEqual(state.players.map(p => p.lives), [4, 5]); assert.deepEqual(state.players.map(p => p.effects!.rapidFire), [0, 0]);
  assert.equal(state.players[1].effects!.shield, 0);
  for (const player of engine.create(spec, 1).players) assert.deepEqual(player.effects, { shield: 0, tripleShot: 0, rapidFire: 0, speedBoost: 0 });
});

test('maximum rounded prize snapshot fits the existing relay budget and rejects extra, duplicate or unauthorized state', () => {
  const spec = game(true) as CooperativeGameSpec, engine = createCooperativeEngine(), state = engine.create(spec); state.nextId = 9999999;
  state.entities = Array.from({ length: 64 }, (_, i) => ({ id: 9000000 + i, kind: 'hazard', asteroid: 'small', x: 900.123, y: 599.123, w: 20, h: 20, vx: -999.123, vy: 999.123, grace: 0.123 }));
  state.bullets = Array.from({ length: 64 }, (_, i) => ({ id: 9000100 + i, owner: (i % 2) as 0 | 1, x: 989.123, y: 569.123, vx: -999.123, vy: 999.123, ttl: 1.999 }));
  state.powerUps!.pickups = Array.from({ length: 3 }, (_, i) => ({ id: 9000200 + i, type: 'speed-boost', x: 931.123, y: 567.123, ttl: 11.123 }));
  const snapshot = engine.snapshot(state); assert.ok(JSON.stringify(snapshot).length < 24000); assert.ok(validateCooperativeState(snapshot, spec));
  const clone = () => structuredClone(snapshot);
  const bad = [clone(), clone(), clone(), clone(), clone(), clone()];
  bad[0].powerUps!.pickups[0].id = bad[0].entities[0].id;
  bad[1].players[0].effects!.shield = 2 as 1;
  bad[2].players[0].effects!.tripleShot = 11;
  bad[3].powerUps!.pickups[0].ttl = 13;
  bad[4].bullets[1].owner = 0; // 33 bullets for one owner.
  bad[5].entities[0].asteroid = 'large'; // Weighted 65 entities after splitting.
  bad.forEach(value => assert.equal(validateCooperativeState(value, spec), undefined));
  const restricted = { ...spec, powerUps: { ...spec.powerUps!, types: ['shield'] as ['shield'] } }; assert.equal(validateCooperativeState(snapshot, restricted), undefined);
});

test('prize physics and drawing serialize into fixed network-disabled solo and cooperative players', () => {
  for (const html of [gameSandboxDocument('synthetic_powerups_12345'), cooperativeGameSandboxDocument('synthetic_powerups_12345')]) {
    assert.match(html, /connect-src 'none'/); assert.match(html, /No active prizes/); assert.match(html, /Triple shot/);
    assert.doesNotThrow(() => new Script(html.match(/<script[^>]*>([\s\S]*)<\/script>/)![1]));
    assert.doesNotMatch(html, /WebSocket|RTCPeerConnection|fetch\(/);
  }
});


test('live-style cooperative prize snapshots and hostile variants agree with the independent Python relay validator', () => {
  const spec = game(true) as CooperativeGameSpec, engine = createCooperativeEngine(), state = engine.create(spec);
  state.running = true; state.paused = false; state.players.forEach(p => { p.effects!.tripleShot = p.effects!.rapidFire = p.effects!.speedBoost = 10; p.effects!.shield = 1; });
  const snapshots: unknown[] = [engine.snapshot(state)];
  for (let i = 0; i < 1000 && state.outcome === 'playing'; i++) {
    state.players.forEach(p => { p.invulnerable = 2; });
    engine.step(state, spec, [32 | (i % 60 < 30 ? 1 : 2), 32 | (i % 60 < 30 ? 2 : 1)], 1 / 60);
    if (i % 100 === 0) snapshots.push(engine.snapshot(state));
  }
  const valid = engine.snapshot(state), hostile = [structuredClone(valid), structuredClone(valid), structuredClone(valid), structuredClone(valid)];
  hostile[0].powerUps!.pickups = [{ id: hostile[0].nextId++, type: 'shield', x: 0, y: 0, ttl: 13 }];
  hostile[1].players[0].effects!.speedBoost = 31;
  delete hostile[2].players[0].effects;
  (hostile[3].powerUps as unknown as Record<string, unknown>).chat = 'unexpected';
  snapshots.push(...hostile);
  const expected = snapshots.map(value => Boolean(validateCooperativeState(value, spec)));
  const python = `import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('prize_relay_parity',Path.cwd()/'backend/nce_api/multiplayer.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
data=json.load(sys.stdin)
out=[]
for value in data['states']:
 try: m.validate_state(value,data['spec']);out.append(True)
 except m.MultiplayerError: out.append(False)
print(json.dumps(out))`;
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify({ spec, states: snapshots }), encoding: 'utf8' }));
  assert.deepEqual(actual, expected); assert.ok(expected.slice(0, -4).every(Boolean)); assert.ok(expected.slice(-4).every(value => !value));
});

test('combined prizes stay within shot and weighted entity limits throughout sustained cooperative firing', () => {
  const spec = game(true) as CooperativeGameSpec, engine = createCooperativeEngine(), state = engine.create(spec);
  state.running = true; state.paused = false; state.players.forEach(p => { p.y = 480; });
  for (let tick = 0; tick < 600 && state.outcome === 'playing'; tick++) {
    state.players.forEach(p => { p.effects!.tripleShot = 10; p.effects!.rapidFire = 10; p.invulnerable = 2; });
    state.nextHazard = 0; state.nextSnack = 0;
    engine.step(state, spec, [32, 32], 1 / 60);
    assert.ok(state.bullets.length <= 64); for (const owner of [0, 1]) assert.ok(state.bullets.filter(b => b.owner === owner).length <= 32);
    assert.ok(state.entities.reduce((count, e) => count + (e.asteroid === 'large' ? 2 : 1), 0) <= 64);
    assert.ok(validateCooperativeState(engine.snapshot(state), spec), `snapshot ${tick}`);
  }
  const blocked = engine.create(spec); blocked.running = true; blocked.paused = false; blocked.nextSnack = blocked.nextHazard = 1;
  blocked.players[0].effects!.tripleShot = 10;
  blocked.bullets = Array.from({ length: 30 }, () => ({ id: blocked.nextId++, owner: 0, x: 100, y: 100, vx: 0, vy: 0, ttl: 1 }));
  engine.step(blocked, spec, [32, 0], 1 / 60); assert.equal(blocked.bullets.length, 30, 'a triple volley is never partially emitted');
});
