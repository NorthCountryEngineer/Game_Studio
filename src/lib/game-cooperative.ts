import { validateArcadeGameSpec } from './game-design';
import { createGameEngine, installGameDisplayKeyboardBridge, gameCanvasViewportStyles, type GameEntity, type GamePlatform, type GamePowerUpEffects, type GamePowerUpWorld, type GameAdvancedWorld, type AdvancedWorld } from './game-runtime';
import type { CooperativeGameSpec } from './game-types';

/** One input bit field, with no player names, chat, or executable payloads. */
export type CooperativeInputMask = number;
export type CooperativePlayer = {
  x: number; y: number; vy: number; grounded: boolean; score: number; lives: number;
  invulnerable: number; angle: number; previousJump: boolean; fireCooldown: number; points: number; effects?: GamePowerUpEffects;
};
export type CooperativeBullet = { id: number; owner: 0 | 1; x: number; y: number; vx: number; vy: number; ttl: number };
export type CooperativeState = {
  levelIndex: number; elapsed: number; outcome: 'playing' | 'won' | 'lost'; running: boolean; paused: boolean;
  seed: number; nextId: number; nextSnack: number; nextHazard: number;
  powerUps?: GamePowerUpWorld;
  advanced?: GameAdvancedWorld;
  players: [CooperativePlayer, CooperativePlayer]; entities: GameEntity[]; bullets: CooperativeBullet[]; platforms: GamePlatform[];
};

/** The host advances one world exactly once. A guest sends only its own controls. */
export function createCooperativeEngine(base = createGameEngine()) {
  const width = 960, height = 540;
  function create(spec: CooperativeGameSpec, levelIndex = 0): CooperativeState {
    const single = base.create(spec, levelIndex);
    const player = (seat: 0 | 1): CooperativePlayer => ({ x: spec.genre === 'platformer' ? 48 + seat * 80 : 350 + seat * 200, y: single.player.y, vy: 0, grounded: single.player.grounded, score: 0, lives: single.lives, invulnerable: 1.5, angle: -Math.PI / 2, previousJump: false, fireCooldown: 0, points: 0, ...(spec.version === 5 || spec.version === 6 && spec.powerUps ? { effects: base.newEffects() } : {}) });
    return { levelIndex: single.levelIndex, elapsed: 0, outcome: 'playing', running: false, paused: true, seed: single.seed, nextId: single.nextId, nextSnack: single.nextSnack, nextHazard: single.nextHazard, players: [player(0), player(1)], entities: single.entities, bullets: [], platforms: single.platforms, ...((spec.version === 5 || spec.version === 6) && spec.powerUps ? { powerUps: { pickups: [], nextSpawn: spec.powerUps.spawnInterval } } : {}), ...(spec.version === 6 ? { advanced: single.advanced! } : {}) };
  }
  function random(state: CooperativeState) { state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0; return state.seed / 4294967296; }
  function spawn(state: CooperativeState, spec: CooperativeGameSpec, kind: 'snack' | 'hazard') {
    const rules = spec.levels[state.levelIndex].rules, arcade = spec.genre === 'dodge' && spec.arcade;
    if (state.entities.reduce((count, entity) => count + (entity.asteroid === 'large' && arcade && arcade.splitAsteroids ? 2 : 1), 0) + (kind === 'hazard' && arcade && arcade.splitAsteroids ? 2 : 1) > (spec.version === 5 ? 64 : 96)) return;
    const size = kind === 'snack' ? 22 : arcade && (arcade.shooting || arcade.rotation) ? 42 : 30;
    for (let attempt = 0; attempt < 40; attempt++) {
      let x = 35 + random(state) * (width - 70 - size), y = 35 + random(state) * (height - 130 - size), vx = 0, vy = 0;
      if (spec.genre === 'platformer') {
        const platform = state.platforms[1 + Math.floor(random(state) * (state.platforms.length - 1))];
        x = platform.x + 18 + random(state) * (platform.w - 60); y = platform.y - size;
        if (kind === 'hazard') vx = (random(state) > 0.5 ? 1 : -1) * (20 + rules.difficulty * 8);
      } else if (spec.genre === 'dodge') { y = -size - random(state) * 50; vy = kind === 'snack' ? 75 + rules.difficulty * 12 : 85 + rules.difficulty * 28; }
      else if (kind === 'hazard') { vx = (random(state) > 0.5 ? 1 : -1) * (25 + rules.difficulty * 10); vy = (random(state) > 0.5 ? 1 : -1) * (15 + rules.difficulty * 5); }
      const entity: GameEntity = { id: state.nextId, kind, x, y, w: size, h: size, vx, vy, ...(arcade && kind === 'hazard' ? { asteroid: 'large' as const } : {}) };
      if (state.players.some(player => base.overlaps({ x: player.x - 16, y: player.y - 16, w: 74, h: 66 }, entity)) || attempt < 39 && state.entities.some(other => base.overlaps({ ...other, x: other.x - 8, y: other.y - 8, w: other.w + 16, h: other.h + 16 }, entity))) continue;
      state.entities.push(entity); state.nextId++; return;
    }
  }
  function step(state: CooperativeState, spec: CooperativeGameSpec, masks: [number, number], elapsed: number): CooperativeState {
    if (!state.running || state.paused || state.outcome !== 'playing' || !Number.isFinite(elapsed) || elapsed <= 0) return state;
    if (spec.version === 6) {
      const inputs = masks.map(mask => ({ left: Boolean(mask & 1), right: Boolean(mask & 2), up: Boolean(mask & 4), down: Boolean(mask & 8), jump: Boolean(mask & 16), fire: Boolean(mask & 32) }));
      base.stepAdvanced(state as AdvancedWorld, base.forLevel(spec,state.levelIndex), state.players, inputs, elapsed);
      return state;
    }
    const dt = Math.min(elapsed, 1 / 20), rules = spec.levels[state.levelIndex].rules;
    const arcade = spec.genre === 'dodge' ? spec.arcade : undefined;
    state.elapsed = Math.min(rules.timeLimit, state.elapsed + dt);
    for (let seat = 0; seat < 2; seat++) {
      const player = state.players[seat], mask = masks[seat];
      player.invulnerable = Math.max(0, player.invulnerable - dt); player.fireCooldown = Math.max(0, player.fireCooldown - dt);
      if (!player.lives) continue;
      let dx = Number(Boolean(mask & 2)) - Number(Boolean(mask & 1)), dy = Number(Boolean(mask & 8)) - Number(Boolean(mask & 4));
      if (player.effects) base.tickEffects(player.effects, dt);
      const speed = (110 + spec.player.speed * 32) * (player.effects?.speedBoost ? 1.6 : 1);
      if (spec.genre === 'platformer') {
        const jump = Boolean(mask & 20);
        if (jump && !player.previousJump && player.grounded) { player.vy = -(300 + spec.player.jump * 17); player.grounded = false; }
        player.previousJump = jump;
        const oldBottom = player.y + 34;
        player.x = Math.max(0, Math.min(width - 42, player.x + dx * speed * dt));
        player.vy += 900 * dt; player.y += player.vy * dt; player.grounded = false;
        if (player.vy >= 0) for (const platform of state.platforms) if (oldBottom <= platform.y + 0.5 && player.y + 34 >= platform.y && player.x + 42 > platform.x && player.x < platform.x + platform.w) { player.y = platform.y - 34; player.vy = 0; player.grounded = true; break; }
        if (player.y > height + 26) { player.lives--; player.x = 48 + seat * 80; player.y = 464; player.vy = 0; player.invulnerable = 1.5; }
      } else if (arcade?.rotation) {
        player.angle = ((player.angle + dx * 2.8 * dt) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        const thrust = Number(Boolean(mask & 4)) - Number(Boolean(mask & 8));
        player.x = Math.max(0, Math.min(width - 42, player.x + Math.cos(player.angle) * thrust * speed * dt));
        player.y = Math.max(12, Math.min(height - 49, player.y + Math.sin(player.angle) * thrust * speed * dt));
      } else {
        if (dx && dy) { dx /= Math.SQRT2; dy /= Math.SQRT2; }
        player.x = Math.max(0, Math.min(width - 42, player.x + dx * speed * dt)); player.y = Math.max(12, Math.min(height - 49, player.y + dy * speed * dt));
      }
    }
    if (spec.version === 5 && spec.powerUps && state.powerUps) base.advancePrizes(state, state.powerUps, spec.powerUps, dt, state.players.map(player => ({ x: player.x, y: player.y, effects: player.effects!, lives: player.lives })));
    for (let seat = 0; seat < 2; seat++) {
      const player = state.players[seat], offsets = player.effects?.tripleShot ? [-0.18, 0, 0.18] : [0], limit = spec.version === 5 ? 32 : 16;
      if (player.lives && arcade?.shooting && (masks[seat] & 32) && !player.fireCooldown && state.bullets.filter(bullet => bullet.owner === seat).length + offsets.length <= limit && state.bullets.length + offsets.length <= limit * 2) {
        const forward = arcade.rotation ? player.angle : -Math.PI / 2;
        for (const offset of offsets) { const angle = forward + offset; state.bullets.push({ id: state.nextId++, owner: seat as 0 | 1, x: player.x + 21 + Math.cos(angle) * 25, y: player.y + 17 + Math.sin(angle) * 25, vx: Math.cos(angle) * 620, vy: Math.sin(angle) * 620, ttl: 1.6 }); }
        player.fireCooldown = player.effects?.rapidFire ? 0.08 : 0.22;
      }
    }
    if (spec.genre === 'dodge') {
      state.nextSnack -= dt; state.nextHazard -= dt;
      if (state.nextSnack <= 0) { spawn(state, spec, 'snack'); state.nextSnack = Math.min(0.8, rules.timeLimit / (rules.goal * 3.4)); }
      if (state.nextHazard <= 0) { spawn(state, spec, 'hazard'); state.nextHazard = 1.15 - rules.difficulty * 0.13; }
    }
    const removed = new Set<number>(), fragments: GameEntity[] = [];
    state.bullets = state.bullets.filter(bullet => {
      const dx = bullet.vx * dt, dy = bullet.vy * dt;
      let nearest: GameEntity | undefined, first = Infinity;
      for (const entity of state.entities) if (entity.kind === 'hazard' && !removed.has(entity.id)) { const hit = base.sweptHit(bullet.x, bullet.y, dx - entity.vx * dt, dy - entity.vy * dt, entity); if (hit !== undefined && hit < first) { nearest = entity; first = hit; } }
      if (nearest) {
        removed.add(nearest.id); if (arcade?.scoring) state.players[bullet.owner].points += nearest.asteroid === 'small' ? 50 : 20;
        if (arcade?.splitAsteroids && nearest.asteroid !== 'small') {
          const jitter = (random(state) - 0.5) * 0.3;
          for (const side of [-1, 1]) { const angle = Math.atan2(nearest.vy || 100, nearest.vx) + side * 0.65 + jitter, speed = Math.max(100, Math.hypot(nearest.vx, nearest.vy) * 0.8); fragments.push({ id: state.nextId++, kind: 'hazard', asteroid: 'small', x: Math.max(0, Math.min(width - 20, nearest.x + nearest.w / 2 - 10 + side * 8 + nearest.vx * dt * first)), y: Math.max(-128, Math.min(599, nearest.y + nearest.h / 2 - 10 + nearest.vy * dt * first)), w: 20, h: 20, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, grace: 0.18 }); }
        }
        return false;
      }
      bullet.x += dx; bullet.y += dy; bullet.ttl -= dt;
      return bullet.ttl > 0 && bullet.x > -30 && bullet.x < width + 30 && bullet.y > -30 && bullet.y < height + 30;
    });
    let collected = 0;
    for (const entity of state.entities) {
      if (removed.has(entity.id)) continue;
      entity.x += entity.vx * dt; entity.y += entity.vy * dt; if (entity.grace) entity.grace = Math.max(0, entity.grace - dt);
      if (spec.genre === 'collect') {
        if (entity.x <= 12 || entity.x + entity.w >= width - 12) entity.vx *= -1;
        if (entity.y <= 12 || entity.y + entity.h >= height - 35) entity.vy *= -1;
        entity.x = Math.max(12, Math.min(width - entity.w - 12, entity.x)); entity.y = Math.max(12, Math.min(height - entity.h - 35, entity.y));
      } else if (spec.genre === 'platformer' && entity.kind === 'hazard') { const surface = state.platforms.find(platform => Math.abs(platform.y - entity.y - entity.h) < 1); if (surface && (entity.x <= surface.x + 5 || entity.x + entity.w >= surface.x + surface.w - 5)) entity.vx *= -1; }
      // Alternate tie priority across entities; the same collectible is consumed once.
      for (const seat of entity.id % 2 ? [0, 1] : [1, 0]) {
        const player = state.players[seat];
        if (!player.lives || !base.overlaps({ x: player.x, y: player.y, w: 42, h: 34 }, entity)) continue;
        if (entity.kind === 'snack') {
          if (player.score >= rules.goal) continue;
          removed.add(entity.id); player.score++; if (arcade?.scoring) player.points += 10; collected++; break;
        }
        if (!player.invulnerable && !entity.grace) { if (player.effects?.shield) player.effects.shield = 0; else player.lives = Math.max(0, player.lives - 1); player.invulnerable = 1.5; if (spec.genre === 'platformer') { player.x = 48 + seat * 80; player.y = 464; player.vy = 0; } }
      }
    }
    state.entities = state.entities.filter(entity => !removed.has(entity.id) && entity.y < height + 60 && entity.x > -64 && entity.x < width + 64).concat(fragments);
    if (spec.genre !== 'dodge') for (let i = 0; i < collected && state.players.some(player => player.score < rules.goal); i++) spawn(state, spec, 'snack');
    if (state.players.every(player => player.score >= rules.goal)) state.outcome = 'won';
    else if (state.players.every(player => !player.lives) || state.elapsed >= rules.timeLimit) state.outcome = 'lost';
    return state;
  }
  /** Round snapshots without feeding network precision back into host physics. */
  function snapshot(state: CooperativeState): CooperativeState { return JSON.parse(JSON.stringify(state, (_key, value) => typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 1000) / 1000 : value)) as CooperativeState; }
  return { create, step, snapshot, drawPrizes: base.drawPrizes, effectLabel: base.effectLabel, drawAdvanced: base.drawAdvanced, endless: base.endless, width, height };
}

/** Untrusted relay data is bounded before entering the opaque drawing frame. */
export function validateCooperativeState(value: unknown, spec: CooperativeGameSpec): CooperativeState | undefined {
  function record(input: unknown, required: string[], optional: string[] = []): input is Record<string, any> { return Boolean(input && typeof input === 'object' && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)) && required.every(key => Object.prototype.hasOwnProperty.call(input, key)) && Object.keys(input).every(key => required.includes(key) || optional.includes(key))); }
  function num(input: unknown, low: number, high: number, integer = false): input is number { return typeof input === 'number' && Number.isFinite(input) && input >= low && input <= high && (!integer || Number.isInteger(input)); }
  try {
    const advanced = spec.version === 6 ? spec.asteroids! : undefined, endless = Boolean(advanced?.endless);
    const config = spec.version === 5 || spec.version === 6 ? spec.powerUps : undefined;
    const maxId = advanced ? 2147483647 : 10000000;
    const stateFields = ['levelIndex', 'elapsed', 'outcome', 'running', 'paused', 'seed', 'nextId', 'nextSnack', 'nextHazard', 'players', 'entities', 'bullets', 'platforms', ...(config ? ['powerUps'] : []), ...(advanced ? ['advanced'] : [])];
    if (JSON.stringify(value).length > 24000 || !record(value, stateFields) || !num(value.levelIndex, 0, endless ? 0 : spec.levels.length - 1, true)) return;
    const rules = spec.levels[value.levelIndex].rules;
    if (!num(value.elapsed, 0, endless ? 2147483647 : rules.timeLimit) || !(endless ? ['playing', 'lost'] : ['playing', 'won', 'lost']).includes(value.outcome) || typeof value.running !== 'boolean' || typeof value.paused !== 'boolean' || !num(value.seed, 0, 4294967295, true) || !num(value.nextId, 1, maxId, true) || !num(value.nextSnack, -1, 1) || !num(value.nextHazard, -1, 2)) return;
    if (!Array.isArray(value.players) || value.players.length !== 2 || !Array.isArray(value.entities) || value.entities.length > (config || advanced ? 64 : 96) || !Array.isArray(value.bullets) || value.bullets.length > (config || advanced ? 64 : 32) || !Array.isArray(value.platforms) || value.platforms.length > 6) return;
    const maxPoints = advanced ? Math.min(2147483647,Math.ceil(value.elapsed * 2000)+2000) : 1000000;
    for (const p of value.players) if (!record(p, ['x', 'y', 'vy', 'grounded', 'score', 'lives', 'invulnerable', 'angle', 'previousJump', 'fireCooldown', 'points', ...(config ? ['effects'] : [])]) || !num(p.x, 0, 918) || !num(p.y, -100, 600) || !num(p.vy, -1000, 1000) || typeof p.grounded !== 'boolean' || !num(p.score, 0, endless ? Math.min(2147483647,Math.ceil(value.elapsed*20)+40) : rules.goal, true) || !num(p.lives, 0, rules.lives, true) || !num(p.invulnerable, 0, 2) || !num(p.angle, -7, 7) || typeof p.previousJump !== 'boolean' || !num(p.fireCooldown, 0, 1) || !num(p.points, 0, maxPoints, true)) return;
    if (config) for (const p of value.players) {
      if (!record(p.effects, ['tripleShot', 'rapidFire', 'speedBoost', 'shield'])) return;
      for (const [key, type] of [['tripleShot', 'triple-shot'], ['rapidFire', 'rapid-fire'], ['speedBoost', 'speed-boost']] as const) if (!num(p.effects[key], 0, config.duration) || p.effects[key] > 0 && !config.types.includes(type)) return;
      if (!num(p.effects.shield, 0, 1, true) || p.effects.shield && !config.types.includes('shield')) return;
    }
    if (value.outcome === 'won' && value.players.some((p:CooperativePlayer) => p.score !== rules.goal)) return;
    const ids = new Set<number>();
    for (const entity of value.entities) {
      if (!record(entity, ['id', 'kind', 'x', 'y', 'w', 'h', 'vx', 'vy'], ['asteroid', 'grace']) || !num(entity.id, 1, maxId, true) || entity.id >= value.nextId || ids.has(entity.id) || !['snack', 'hazard'].includes(entity.kind) || !num(entity.x, -64, 1024) || !num(entity.y, -128, 600) || !num(entity.w, 1, 64) || !num(entity.h, 1, 64) || !num(entity.vx, -1000, 1000) || !num(entity.vy, -1000, 1000) || 'asteroid' in entity && !(advanced?.sizes === 3 ? ['large', 'medium', 'small'] : ['large', 'small']).includes(entity.asteroid) || 'grace' in entity && !num(entity.grace, 0, 1)) return;
      if (advanced) { const size = entity.kind === 'snack' ? 22 : entity.asteroid === 'large' ? 42 : entity.asteroid === 'medium' ? 30 : entity.asteroid === 'small' ? 18 : 0; if (entity.w !== size || entity.h !== size || entity.kind === 'snack' && ('asteroid' in entity || 'grace' in entity)) return; }
      ids.add(entity.id);
    }
    if ((config || advanced) && value.entities.reduce((count:number, entity:GameEntity) => count + (entity.kind === 'hazard' && spec.arcade?.splitAsteroids ? entity.asteroid === 'large' ? advanced?.sizes === 3 ? 4 : 2 : entity.asteroid === 'medium' ? 2 : 1 : 1), 0) > 64) return;
    for (const bullet of value.bullets) {
      if (!record(bullet, ['id', 'owner', 'x', 'y', 'vx', 'vy', 'ttl']) || !num(bullet.id, 1, maxId, true) || bullet.id >= value.nextId || ids.has(bullet.id) || !num(bullet.owner, 0, 1, true) || !num(bullet.x, -30, 990) || !num(bullet.y, -30, 570) || !num(bullet.vx, -1000, 1000) || !num(bullet.vy, -1000, 1000) || !num(bullet.ttl, 0, 2)) return;
      ids.add(bullet.id);
    }
    if (config || advanced) for (const owner of [0, 1]) if (value.bullets.filter((bullet:CooperativeBullet) => bullet.owner === owner).length > 32) return;
    if (config) {
      if (!record(value.powerUps, ['pickups', 'nextSpawn']) || !num(value.powerUps.nextSpawn, 0, config.spawnInterval) || !Array.isArray(value.powerUps.pickups) || value.powerUps.pickups.length > 3) return;
      for (const pickup of value.powerUps.pickups) {
        if (!record(pickup, ['id', 'type', 'x', 'y', 'ttl']) || !num(pickup.id, 1, maxId, true) || pickup.id >= value.nextId || ids.has(pickup.id) || typeof pickup.type !== 'string' || !config.types.includes(pickup.type as typeof config.types[number]) || !num(pickup.x, 0, 932) || !num(pickup.y, -28, 568) || !num(pickup.ttl, 0, 12)) return;
        ids.add(pickup.id);
      }
    }
    if (advanced) {
      const current = value.advanced;
      if (!record(current,['difficulty','nextEnemy','enemies','enemyBullets']) || !num(current.difficulty,1,214748365,true) || !num(current.nextEnemy,0,60) || !Array.isArray(current.enemies) || current.enemies.length > (advanced.enemies.enabled ? advanced.enemies.maxShips : 0) || !Array.isArray(current.enemyBullets) || current.enemyBullets.length > (advanced.enemies.enabled && advanced.enemies.difficulty === 'hard' ? 24 : 0)) return;
      if (!endless && current.difficulty !== rules.difficulty) return;
      for (const enemy of current.enemies) {
        if (!record(enemy,['id','x','y','w','h','vx','vy','hp','maxHp','fireCooldown','phase']) || !num(enemy.id,1,maxId,true) || enemy.id >= value.nextId || ids.has(enemy.id) || !num(enemy.x,-64,1024) || !num(enemy.y,-64,600) || enemy.w !== 38 || enemy.h !== 28 || !num(enemy.vx,-800,800) || !num(enemy.vy,-800,800) || !num(enemy.hp,1,advanced.enemies.hitPoints,true) || enemy.maxHp !== advanced.enemies.hitPoints || !num(enemy.fireCooldown,0,3) || !num(enemy.phase,0,Math.PI*2)) return;
        ids.add(enemy.id);
      }
      for (const bullet of current.enemyBullets) {
        if (!record(bullet,['id','x','y','vx','vy','ttl']) || !num(bullet.id,1,maxId,true) || bullet.id >= value.nextId || ids.has(bullet.id) || !num(bullet.x,-30,990) || !num(bullet.y,-30,570) || !num(bullet.vx,-800,800) || !num(bullet.vy,-800,800) || !num(bullet.ttl,0,4)) return;
        ids.add(bullet.id);
      }
    }
    for (const platform of value.platforms) if (!record(platform, ['x', 'y', 'w', 'h']) || !num(platform.x, 0, 960) || !num(platform.y, 0, 540) || !num(platform.w, 1, 960) || !num(platform.h, 1, 64)) return;
    return structuredClone(value) as CooperativeState;
  } catch { return; }
}

/** No networking exists here; only the trusted parent can relay bounded state. */
export function startCooperativeSandbox(engine: ReturnType<typeof createCooperativeEngine>, validate: typeof validateArcadeGameSpec, validateState: typeof validateCooperativeState, nonce: string) {
  const canvas = document.getElementById('game') as HTMLCanvasElement, ctx = canvas.getContext('2d');
  const title = document.getElementById('title')!, status = document.getElementById('status')!, announce = document.getElementById('announce')!, instruction = document.getElementById('instruction')!;
  const start = document.getElementById('start') as HTMLButtonElement, pause = document.getElementById('pause') as HTMLButtonElement, next = document.getElementById('next') as HTMLButtonElement;
  let spec: CooperativeGameSpec | undefined, seat: 0 | 1 = 0, state: CooperativeState | undefined, connected = false, previous = 0, accumulator = 0, broadcast = 0, inputTimer = 0, seq = 0, remoteSeq = 0, remoteMask = 0, remoteAge = 0, lastMask = -1;
  const keys = new Set<string>(), pressed = new Set<string>();
  const mask = () => Number(keys.has('arrowleft') || keys.has('a') || pressed.has('left')) | Number(keys.has('arrowright') || keys.has('d') || pressed.has('right')) * 2 | Number(keys.has('arrowup') || keys.has('w') || pressed.has('up')) * 4 | Number(keys.has('arrowdown') || keys.has('s') || pressed.has('down')) * 8 | Number(keys.has(' ') || pressed.has('jump')) * 16 | Number(keys.has(' ') || keys.has('z') || pressed.has('fire')) * 32;
  function clear() { keys.clear(); pressed.clear(); remoteMask = 0; }
  function emitState() { if (seat === 0 && state) parent.postMessage({ type: 'game-coop-state', nonce, seq: ++seq, state: engine.snapshot(state) }, '*'); }
  function reset(level = state?.levelIndex || 0) { if (!spec || seat !== 0 || !connected) return; state = engine.create(spec, level); state.running = true; state.paused = false; clear(); accumulator = 0; emitState(); draw(); canvas.focus(); }
  start.addEventListener('click', () => reset());
  pause.addEventListener('click', () => { if (seat !== 0 || !state || !connected || !state.running || state.outcome !== 'playing') return; state.paused = !state.paused; clear(); emitState(); draw(); if (!state.paused) canvas.focus(); });
  next.addEventListener('click', () => { if (seat === 0 && state?.outcome === 'won' && spec && state.levelIndex + 1 < spec.levels.length) reset(state.levelIndex + 1); });
  document.addEventListener('keydown', event => { const key = event.key.toLowerCase(); if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's', ' ', 'z'].includes(key)) { if ((event.target as HTMLElement)?.tagName === 'BUTTON') return; event.preventDefault(); keys.add(key); } });
  document.addEventListener('keyup', event => { keys.delete(event.key.toLowerCase()); });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-control]')) {
    const control = button.dataset.control!;
    button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); pressed.add(control); });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(name, () => { pressed.delete(control); });
    button.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); pressed.add(control); } }); button.addEventListener('keyup', () => pressed.delete(control));
  }
  // Focusing the invitation or another window releases this player's controls;
  // it must not freeze the other player's still-connected adventure.
  function blur() { keys.clear(); pressed.clear(); if (seat === 1) parent.postMessage({ type: 'game-coop-input', nonce, seq: ++seq, mask: 0 }, '*'); }
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    blur();
    // Hidden tabs suspend animation frames even while the parent's socket
    // heartbeat survives. Publish the pause before that suspension happens.
    if (seat === 0 && state?.running && state.outcome === 'playing') {
      state.paused = true; remoteMask = 0;
      announce.textContent = 'The host game tab is in the background. Return here and choose Resume together.';
      emitState();
    }
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || event.data.nonce !== nonce || typeof event.data !== 'object') return;
    const data = event.data, exact = (fields: string[]) => Object.keys(data).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(data, key));
    if (data.type === 'game-coop-load' && !spec && exact(['type', 'nonce', 'spec', 'seat']) && (data.seat === 0 || data.seat === 1)) {
      try {
        const loaded = validate(data.spec); if (loaded.version !== 4 && !((loaded.version === 5 || loaded.version === 6) && loaded.multiplayer)) return; spec = loaded as CooperativeGameSpec; seat = data.seat;
        state = engine.create(spec); title.textContent = `${spec.title} · Cooperative play`; instruction.textContent = `You are Player ${seat + 1}. Both players collect their own goal. Shared world; separate lives and points. No friendly fire. The host starts and pauses each level. If a player runs out of lives before finishing their goal, restart the level to try together again.`;
        if (engine.endless(spec)) instruction.textContent = `You are Player ${seat + 1}. Survive together for as long as possible. Difficulty rises every ${spec.asteroids!.difficultyInterval} active seconds. The run ends when both ships lose all lives. Shared world; separate lives and points; no friendly fire. The authored treasure goal and timer do not end this run.`;
        document.getElementById('jump')!.hidden = spec.genre !== 'platformer'; document.getElementById('fire')!.hidden = !spec.arcade?.shooting;
        document.getElementById('controls-help')!.textContent = spec.arcade?.rotation ? 'Left / Right turn · Up thrusts · Down reverses · Space / Z fires' : spec.genre === 'platformer' ? 'Arrows / WASD move · Space / Up jumps' : `Arrows / WASD move${spec.arcade?.shooting ? ' · Space / Z fires' : ''}`;
        if (spec.powerUps) instruction.textContent += ` Falling prizes: 3 triple shot, » rapid fire, S one-hit shield, ↑ speed boost. Pickups affect only the ship that collects them.${engine.endless(spec) ? ' Any damaging impact clears that ship’s prizes; a shield absorbs one hit and also clears every prize.' : ''}`;
        if (spec.version === 6) instruction.textContent += `${spec.arcade?.splitAsteroids ? spec.asteroids!.sizes === 3 ? ' Asteroids split large → two medium → four small pieces.' : ' Large asteroids split into two small pieces.' : ''}${spec.asteroids!.enemies.enabled ? ` Enemy ships take ${spec.asteroids!.enemies.hitPoints} hits; ${spec.asteroids!.enemies.difficulty === 'easy' ? 'easy enemies wander' : spec.asteroids!.enemies.difficulty === 'medium' ? 'medium enemies track gradually' : 'hard enemies pursue and fire aimed shots'}.` : ''}`;
        start.hidden = pause.hidden = seat !== 0; draw(); parent.postMessage({ type: 'game-coop-loaded', nonce }, '*');
      } catch { announce.textContent = 'This cooperative game could not be loaded safely.'; }
    } else if (data.type === 'game-coop-peer' && exact(['type', 'nonce', 'connected']) && typeof data.connected === 'boolean') {
      connected = data.connected; clear(); lastMask = -1; inputTimer = 0;
      if (state && seat === 0) { if (!connected) state.paused = true; emitState(); }
      announce.textContent = connected ? seat === 0 ? 'Partner connected. Start or resume when ready.' : 'Connected. The host starts or resumes the game.' : 'Waiting for your partner. Play is paused.';
      // Connection callbacks can arrive while the browser defers this frame's
      // animation loop. Admission must update controls and canvas immediately.
      draw();
    } else if (spec && data.type === 'game-coop-input' && seat === 0 && exact(['type', 'nonce', 'seq', 'mask']) && Number.isInteger(data.seq) && data.seq > remoteSeq && data.seq <= 10000000 && Number.isInteger(data.mask) && data.mask >= 0 && data.mask <= 63) { remoteSeq = data.seq; remoteMask = connected ? data.mask : 0; remoteAge = 0; }
    else if (spec && data.type === 'game-coop-state' && seat === 1 && exact(['type', 'nonce', 'seq', 'state']) && Number.isInteger(data.seq) && data.seq > remoteSeq && data.seq <= 10000000) { const checked = validateState(data.state, spec); if (checked) { remoteSeq = data.seq; state = checked; draw(); } }
  });
  function draw() {
    if (!ctx || !state || !spec) return;
    const level = spec.levels[state.levelIndex], dark = level.theme === 'space';
    ctx.fillStyle = dark ? '#211d3e' : level.theme === 'garden' ? '#f6f1cf' : '#e4f2e8'; ctx.fillRect(0, 0, 960, 540);
    ctx.fillStyle = dark ? '#baaddb' : '#38796c'; for (let i = 0; i < 25; i++) { ctx.beginPath(); ctx.arc((i * 139 + 31) % 960, (i * 83 + 57) % 520, dark ? 2 : 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = dark ? '#887da5' : '#6a8547'; for (const platform of state.platforms) ctx.fillRect(platform.x, platform.y, platform.w, platform.h);
    for (const entity of state.entities) { ctx.fillStyle = entity.kind === 'snack' ? '#ecc96b' : entity.asteroid === 'medium' ? '#bc9382' : entity.asteroid === 'small' ? '#8eabb0' : '#9b82a7'; ctx.strokeStyle = '#4b4458'; ctx.lineWidth = 2; ctx.beginPath(); if (entity.kind === 'snack') { const x = entity.x + entity.w / 2, y = entity.y + entity.h / 2; ctx.moveTo(x, y - 12); ctx.lineTo(x + 11, y); ctx.lineTo(x, y + 12); ctx.lineTo(x - 11, y); ctx.closePath(); } else ctx.ellipse(entity.x + entity.w / 2, entity.y + entity.h / 2, entity.w / 2, entity.h / 2, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    if (state.advanced) engine.drawAdvanced(ctx,state.advanced);
    if (state.powerUps) engine.drawPrizes(ctx, state.powerUps.pickups);
    for (const bullet of state.bullets) { ctx.strokeStyle = bullet.owner === 0 ? '#f6c6de' : '#7edbed'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(bullet.x - bullet.vx / 60, bullet.y - bullet.vy / 60); ctx.lineTo(bullet.x, bullet.y); ctx.stroke(); }
    state.players.forEach((player, index) => {
      if (!player.lives || player.invulnerable > 0 && Math.floor(state!.elapsed * 9) % 2) return;
      if (player.effects?.shield) { ctx.strokeStyle = '#36cad7'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(player.x + 21, player.y + 17, 34, 0, Math.PI * 2); ctx.stroke(); }
      ctx.save(); ctx.translate(player.x + 21, player.y + 17); ctx.fillStyle = index === 0 ? spec!.player.color : '#63cadd'; ctx.strokeStyle = dark ? '#fffaf0' : '#254e45'; ctx.lineWidth = index === seat ? 4 : 2;
      if (spec!.arcade?.shooting || spec!.arcade?.rotation) { ctx.rotate(player.angle + Math.PI / 2); ctx.beginPath(); ctx.moveTo(0, -25); ctx.lineTo(23, 17); ctx.lineTo(0, 11); ctx.lineTo(-23, 17); ctx.closePath(); }
      else { ctx.beginPath(); ctx.ellipse(0, 0, 21, 17, 0, 0, Math.PI * 2); } ctx.fill(); ctx.stroke(); ctx.restore();
      ctx.fillStyle = dark ? '#fffaf0' : '#254e45'; ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`P${index + 1}`, player.x + 21, player.y - 12);
    });
    if (!connected || !state.running || state.paused || state.outcome !== 'playing') {
      ctx.fillStyle = dark ? '#211d3ed9' : '#fffaf0df'; ctx.fillRect(0, 0, 960, 540); ctx.fillStyle = dark ? '#fffaf0' : '#254e45'; ctx.textAlign = 'center'; ctx.font = 'bold 34px system-ui'; ctx.fillText(!connected ? 'Waiting for your partner' : !state.running ? 'Two explorers. One adventure.' : state.paused ? 'Cooperative play paused' : state.outcome === 'won' ? 'Both goals complete!' : 'Try this adventure again', 480, 245); ctx.font = '20px system-ui'; ctx.fillText(seat === 0 ? 'Use the host controls below.' : 'The host starts or resumes the level.', 480, 285);
    }
    const labels = state.players.map((p, index) => `Player ${index + 1}${index === seat ? ' (you)' : ''}: ${engine.endless(spec!) ? `${p.score} collected` : `${p.score}/${level.rules.goal} goal`} · ${p.lives} lives${spec!.arcade?.scoring ? ` · ${p.points} points` : ''}${p.effects ? ` · ${engine.effectLabel(p.effects,engine.endless(spec!))}` : ''}`);
    status.textContent = engine.endless(spec) ? `Survival ${Math.floor(state.elapsed / 60)}:${String(Math.floor(state.elapsed%60)).padStart(2,'0')} · Difficulty ${state.advanced!.difficulty}` : `Level ${state.levelIndex + 1}/${spec.levels.length} · ${Math.max(0, Math.ceil(level.rules.timeLimit - state.elapsed))}s remaining`;
    document.getElementById('player-1')!.textContent = labels[0]; document.getElementById('player-2')!.textContent = labels[1];
    start.disabled = !connected; start.textContent = state.running ? 'Restart level' : 'Start together'; pause.disabled = !connected || !state.running || state.outcome !== 'playing'; pause.textContent = state.paused ? 'Resume together' : 'Pause together'; next.hidden = seat !== 0 || state.outcome !== 'won' || state.levelIndex + 1 >= spec.levels.length;
  }
  function frame(now: number) {
    const dt = previous ? Math.min((now - previous) / 1000, 0.1) : 0; previous = now;
    remoteAge += dt;
    if (seat === 0 && state && spec && connected && state.running && !state.paused && state.outcome === 'playing') { accumulator += dt; while (accumulator >= 1 / 60) { engine.step(state, spec, [mask(), remoteAge <= 0.5 ? remoteMask : 0], 1 / 60); accumulator -= 1 / 60; } } else accumulator = 0;
    broadcast += dt; inputTimer += dt;
    // Active worlds stay responsive; a paused world needs only an occasional
    // resync. Changes to start, pause and connection state emit immediately.
    const stateInterval = state?.running && !state.paused && state.outcome === 'playing' ? 0.1 : 2;
    if (seat === 0 && connected && broadcast >= stateInterval) { broadcast = 0; emitState(); }
    // Released controls do not need continuous zero packets. Held controls
    // refresh before the host's existing half-second stale-input watchdog.
    if (seat === 1 && connected && spec && (mask() !== lastMask || mask() !== 0 && inputTimer >= 0.2)) { inputTimer = 0; lastMask = mask(); parent.postMessage({ type: 'game-coop-input', nonce, seq: ++seq, mask: lastMask }, '*'); }
    draw(); requestAnimationFrame(frame);
  }
  parent.postMessage({ type: 'game-coop-ready', nonce }, '*'); requestAnimationFrame(frame);
}

export function cooperativeGameSandboxDocument(nonce: string): string {
  if (!/^[a-zA-Z0-9_-]{16,100}$/u.test(nonce)) throw new Error('A safe random game nonce is required.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'"><style>*{box-sizing:border-box}body{margin:0;background:#fffaf0;color:#254e45;font:15px/1.4 system-ui}main{padding:12px}h2{font-size:20px;margin:0 0 6px}canvas{display:block;width:100%;aspect-ratio:16/9;border-radius:10px;outline-offset:3px}button{font:inherit;min-height:44px;min-width:56px;padding:8px 15px;border:1px solid #497267;border-radius:8px;background:#fffaf0;color:#254e45;cursor:pointer;touch-action:none;user-select:none}button:disabled{opacity:.5;cursor:default}button:focus-visible,canvas:focus-visible{outline:3px solid #a94c7b}.buttons,.touch,.players{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:10px 0}.players>div{flex:1;min-width:240px;padding:8px;border-radius:8px;border:2px solid #b96e98;font-weight:600}.players>div+div{border-color:#2995aa}#status{font-weight:700}#instruction,#controls-help{font-size:13px}#announce{text-align:center;min-height:24px}[hidden]{display:none!important}${gameCanvasViewportStyles}</style></head><body><main><h2 id="title">Loading cooperative game…</h2><div id="status"></div><div class="players"><div id="player-1"></div><div id="player-2"></div></div><p id="instruction"></p><canvas id="game" width="960" height="540" tabindex="0" aria-label="Cooperative game. Separate Player 1 and Player 2 characters share this world."></canvas><div class="buttons"><button id="start" disabled>Start together</button><button id="pause" disabled>Pause together</button><button id="next" hidden>Next level</button></div><div class="touch" aria-label="Your movement controls"><button data-control="left" aria-label="Move left">←</button><button data-control="up" aria-label="Move up or jump">↑</button><button data-control="down" aria-label="Move down">↓</button><button data-control="right" aria-label="Move right">→</button><button data-control="jump" id="jump">Jump</button><button data-control="fire" id="fire" hidden>Fire</button></div><p id="announce" role="status" aria-live="polite">Waiting for your partner.</p><p id="controls-help"></p></main><script nonce="${nonce}">const __name=(fn)=>fn;(${installGameDisplayKeyboardBridge.toString()})("${nonce}");(${startCooperativeSandbox.toString()})((${createCooperativeEngine.toString()})((${createGameEngine.toString()})()),(${validateArcadeGameSpec.toString()}),(${validateCooperativeState.toString()}),"${nonce}");</script></body></html>`;
}
