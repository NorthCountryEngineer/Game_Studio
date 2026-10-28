import { validateArcadeGameSpec } from './game-design';
import type { GameLevel, GameResult, ArcadeGameSpec, GameSpec, GamePowerUpType, GamePowerUps, GameSprites, GameSpriteRole } from './game-types';

export type GameInput = { left?: boolean; right?: boolean; up?: boolean; down?: boolean; jump?: boolean; fire?: boolean };
export type GameEntity = { id: number; kind: 'snack' | 'hazard'; x: number; y: number; w: number; h: number; vx: number; vy: number; asteroid?: 'large' | 'medium' | 'small'; grace?: number };
export type GameBullet = { id: number; x: number; y: number; vx: number; vy: number; ttl: number; owner?: 0 | 1 };
export type GameEnemy = { id: number; x: number; y: number; w: number; h: number; vx: number; vy: number; hp: number; maxHp: number; fireCooldown: number; phase: number };
export type GameAdvancedWorld = { difficulty: number; nextEnemy: number; enemies: GameEnemy[]; enemyBullets: GameBullet[] };
export type AdvancedPlayer = { x: number; y: number; vy: number; grounded: boolean; score: number; lives: number; invulnerable: number; angle: number; previousJump: boolean; fireCooldown: number; points: number; effects?: GamePowerUpEffects };
export type AdvancedWorld = { elapsed: number; seed: number; nextId: number; nextSnack: number; nextHazard: number; entities: GameEntity[]; bullets: GameBullet[]; advanced: GameAdvancedWorld; powerUps?: GamePowerUpWorld; outcome: 'playing' | 'won' | 'lost' };
export type GamePowerUpEffects = { tripleShot: number; rapidFire: number; speedBoost: number; shield: 0 | 1 };
export type GamePowerUpPickup = { id: number; type: GamePowerUpType; x: number; y: number; ttl: number };
export type GamePowerUpWorld = { pickups: GamePowerUpPickup[]; nextSpawn: number };
export type GamePlatform = { x: number; y: number; w: number; h: number };
export type GameState = {
  player: { x: number; y: number; w: number; h: number; vy: number; grounded: boolean };
  entities: GameEntity[];
  platforms: GamePlatform[];
  score: number;
  lives: number;
  elapsed: number;
  invulnerable: number;
  nextSnack: number;
  nextHazard: number;
  seed: number;
  nextId: number;
  previousJump: boolean;
  outcome: 'playing' | 'won' | 'lost';
  levelIndex: number;
  levelId: string;
  angle?: number;
  bullets?: GameBullet[];
  fireCooldown?: number;
  points?: number;
  powerUps?: GamePowerUpWorld & { effects: GamePowerUpEffects };
  advanced?: GameAdvancedWorld;
};

/** Self-contained so the exact tested engine can also run in an opaque-origin iframe. */
export function createGameEngine() {
  const width = 960, height = 540;
  function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function random(state: { seed: number }) { state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0; return state.seed / 4294967296; }
  /** Pixel-only assets use an in-memory canvas; no image URL or network is involved. */
  function spritePainter(sprites?: GameSprites) {
    const cache = new Map<string, HTMLCanvasElement>();
    return (ctx: CanvasRenderingContext2D, role: GameSpriteRole, x: number, y: number, w: number, h: number) => {
      const sprite = sprites?.[role]; if (!sprite) return false;
      let bitmap = cache.get(role);
      if (!bitmap) {
        bitmap = document.createElement('canvas'); bitmap.width = sprite.width; bitmap.height = sprite.height;
        const surface = bitmap.getContext('2d'); if (!surface) return false;
        const pixels = surface.createImageData(sprite.width, sprite.height), bytes = atob(sprite.pixels);
        for (let i = 0; i < bytes.length; i++) pixels.data[i] = bytes.charCodeAt(i);
        surface.putImageData(pixels, 0, 0); cache.set(role, bitmap);
      }
      const scale = Math.min(w / sprite.width, h / sprite.height), drawnWidth = sprite.width * scale, drawnHeight = sprite.height * scale;
      ctx.drawImage(bitmap, x + (w - drawnWidth) / 2, y + (h - drawnHeight) / 2, drawnWidth, drawnHeight); return true;
    };
  }
  /** Select a deterministic edge and aim inward, avoiding a parallel off-screen path. */
  function edgeSpawn(state: { seed: number }, size: number, speed: number) {
    const edge = Math.floor(random(state) * 4), position = random(state);
    const x = edge === 2 ? -size : edge === 3 ? width : position * (width - size);
    const y = edge === 0 ? -size : edge === 1 ? height : position * (height - size);
    const dx = width * (0.2 + random(state) * 0.6) - x, dy = height * (0.2 + random(state) * 0.6) - y, length = Math.hypot(dx, dy);
    return { x, y, vx: dx / length * speed, vy: dy / length * speed };
  }
  function collectPrize(player: { effects: GamePowerUpEffects }, pickup: GamePowerUpPickup, config: GamePowerUps) {
    if (pickup.type === 'shield') player.effects.shield = 1;
    else if (pickup.type === 'triple-shot') player.effects.tripleShot = config.duration;
    else if (pickup.type === 'rapid-fire') player.effects.rapidFire = config.duration;
    else player.effects.speedBoost = config.duration;
  }
  function shotPrize(bullet: GameBullet, dt: number, world: GamePowerUpWorld | undefined, config: GamePowerUps | undefined, player: { effects?: GamePowerUpEffects; lives: number }, before = Infinity) {
    if (!world || !config || !player.lives || !player.effects) return false;
    let nearest: GamePowerUpPickup | undefined, first = before;
    for (const pickup of world.pickups) {
      const hit = sweptHit(bullet.x, bullet.y, bullet.vx * dt, (bullet.vy - 72) * dt, { id: pickup.id, kind: 'snack', x: pickup.x, y: pickup.y - 72 * dt, w: 28, h: 28, vx: 0, vy: 72 });
      if (hit !== undefined && hit < first) { nearest = pickup; first = hit; }
    }
    if (!nearest) return false;
    collectPrize(player as { effects: GamePowerUpEffects }, nearest, config);
    world.pickups = world.pickups.filter(pickup => pickup.id !== nearest!.id); return true;
  }
  function newEffects(): GamePowerUpEffects { return { tripleShot: 0, rapidFire: 0, speedBoost: 0, shield: 0 }; }
  function tickEffects(effects: GamePowerUpEffects, dt: number) {
    effects.tripleShot = Math.max(0, effects.tripleShot - dt); effects.rapidFire = Math.max(0, effects.rapidFire - dt); effects.speedBoost = Math.max(0, effects.speedBoost - dt);
  }
  function advancePrizes(state: { seed: number; nextId: number }, world: GamePowerUpWorld, config: GamePowerUps, dt: number, players: { x: number; y: number; effects: GamePowerUpEffects; lives: number }[], allowSpawn = true) {
    world.nextSpawn = Math.max(0, world.nextSpawn - dt);
    if (!world.nextSpawn) {
      if (allowSpawn && world.pickups.length < 3) world.pickups.push({ id: state.nextId++, type: config.types[Math.floor(random(state) * config.types.length)], x: 32 + random(state) * (width - 92), y: -28, ttl: 12 });
      world.nextSpawn = config.spawnInterval;
    }
    world.pickups = world.pickups.filter(pickup => {
      pickup.y += 72 * dt; pickup.ttl = Math.max(0, pickup.ttl - dt);
      if (!pickup.ttl || pickup.y > height + 28) return false;
      // One pickup belongs to one living ship, with alternating tie priority.
      for (const index of pickup.id % 2 && players.length > 1 ? [1, 0] : players.map((_player, i) => i)) {
        const player = players[index];
        if (!player.lives || !overlaps({ x: player.x, y: player.y, w: 42, h: 34 }, { x: pickup.x, y: pickup.y, w: 28, h: 28 })) continue;
        collectPrize(player, pickup, config);
        return false;
      }
      return true;
    });
  }
  function effectLabel(effects?: GamePowerUpEffects, persistent = false) {
    if (!effects) return '';
    const labels: string[] = [];
    if (effects.tripleShot > 0) labels.push(persistent ? 'Triple shot until impact' : `Triple shot ${Math.ceil(effects.tripleShot)}s`);
    if (effects.rapidFire > 0) labels.push(persistent ? 'Rapid fire until impact' : `Rapid fire ${Math.ceil(effects.rapidFire)}s`);
    if (effects.speedBoost > 0) labels.push(persistent ? 'Speed boost until impact' : `Speed boost ${Math.ceil(effects.speedBoost)}s`);
    if (effects.shield) labels.push('Shield: 1 extra hit');
    return labels.join(' · ') || 'No active prizes';
  }
  function drawPrizes(ctx: CanvasRenderingContext2D, pickups: GamePowerUpPickup[], paint?: ReturnType<typeof spritePainter>) {
    for (const pickup of pickups) {
      const color = pickup.type === 'triple-shot' ? '#c369e0' : pickup.type === 'rapid-fire' ? '#ffb23e' : pickup.type === 'shield' ? '#36cad7' : '#7ddc62';
      const symbol = pickup.type === 'triple-shot' ? '3' : pickup.type === 'rapid-fire' ? '»' : pickup.type === 'shield' ? 'S' : '↑';
      const custom = paint?.(ctx, 'reward', pickup.x, pickup.y, 28, 28);
      if (!custom) {
      ctx.fillStyle = color; ctx.strokeStyle = '#211d3e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(pickup.x + 14, pickup.y + 14, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      if (custom) { ctx.fillStyle = color; ctx.fillRect(pickup.x + 18, pickup.y - 5, 15, 17); }
      ctx.fillStyle = '#211d3e'; ctx.font = `bold ${custom ? 14 : 20}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(symbol, pickup.x + (custom ? 25 : 14), pickup.y + (custom ? 8 : 21));
    }
  }
  function getLevels(spec: ArcadeGameSpec): GameLevel[] {
    return spec.version !== 1 && spec.levels ? spec.levels.map(level => ({ ...level, rules: { ...level.rules } })) : [{ id: 'level-1', title: spec.title, brief: spec.instructions || 'Collect treasures and avoid obstacles.', theme: spec.theme, rules: { ...spec.rules }, seed: 17031 }];
  }
  function forLevel(spec: ArcadeGameSpec, index: number): ArcadeGameSpec {
    const level = getLevels(spec)[index];
    if (!level) throw new Error('Choose a level in this game.');
    return { ...spec, theme: level.theme, rules: { ...level.rules } };
  }
  function maxPoints(spec: ArcadeGameSpec, selectedLevelIds?: string[], elapsed?: number) {
    if (!spec.arcade?.scoring) return 0;
    if (spec.version === 6) {
      const seconds = elapsed !== undefined ? Math.max(0, elapsed) : spec.asteroids!.endless ? 2147483647 : getLevels(spec).filter(level => !selectedLevelIds || selectedLevelIds.includes(level.id)).reduce((sum, level) => sum + level.rules.timeLimit, 0);
      // Hardest sustained asteroid/enemy pressure is below 2,000 points/sec;
      // the extra allowance covers collectible bonuses and boundary rounding.
      return Math.min(2147483647, Math.ceil(seconds * 2000) + 2000);
    }
    return getLevels(spec).filter(level => !selectedLevelIds || selectedLevelIds.includes(level.id)).reduce((total, level) => total + level.rules.goal * 10 + (Math.ceil(level.rules.timeLimit / 0.5) + 8) * (spec.arcade?.splitAsteroids ? 120 : 20), 0);
  }
  // Segment against a rectangle expanded by the projectile radius. Relative
  // motion catches fast bullets even when a moving asteroid crosses their path.
  function sweptHit(x: number, y: number, dx: number, dy: number, target: GameEntity, radius = 3) {
    let near = 0, far = 1;
    for (const [position, delta, low, high] of [[x, dx, target.x - radius, target.x + target.w + radius], [y, dy, target.y - radius, target.y + target.h + radius]]) {
      if (Math.abs(delta) < 1e-9) { if (position < low || position > high) return undefined; }
      else {
        const a = (low - position) / delta, b = (high - position) / delta;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        if (near > far) return undefined;
      }
    }
    return near;
  }
  function endless(spec: ArcadeGameSpec) { return spec.version === 6 && spec.asteroids!.endless; }
  function advancedWorld(spec: ArcadeGameSpec): GameAdvancedWorld { return { difficulty: endless(spec) ? 1 : spec.rules.difficulty, nextEnemy: spec.asteroids!.enemies.spawnInterval, enemies: [], enemyBullets: [] }; }
  function difficulty(spec: ArcadeGameSpec, elapsed: number) {
    const growth = Math.max(0, elapsed) / spec.asteroids!.difficultyInterval;
    return { level: Math.floor(growth) + 1, pressure: 1 + 1.8 * (1 - Math.exp(-growth / 12)) };
  }
  function descendantBudget(entities: GameEntity[], spec: ArcadeGameSpec) {
    return entities.reduce((sum, item) => sum + (item.kind === 'hazard' && spec.arcade?.splitAsteroids ? item.asteroid === 'large' ? spec.asteroids!.sizes === 3 ? 4 : 2 : item.asteroid === 'medium' ? 2 : 1 : 1), 0);
  }
  function advancedImpact(player: AdvancedPlayer, persistent: boolean) {
    if (!player.lives || player.invulnerable) return false;
    if (player.effects?.shield) player.effects.shield = 0; else player.lives = Math.max(0, player.lives - 1);
    if (persistent && player.effects) Object.assign(player.effects, newEffects());
    player.invulnerable = 1.5;
    return true;
  }
  function advancedSpawn(world: AdvancedWorld, spec: ArcadeGameSpec, kind: 'snack' | 'hazard', pressure: number) {
    const reserved = kind === 'hazard' && spec.arcade?.splitAsteroids ? spec.asteroids!.sizes === 3 ? 4 : 2 : 1;
    if (descendantBudget(world.entities, spec) + reserved > 64 || world.nextId >= 2147483600) return;
    const size = kind === 'snack' ? 22 : 42;
    const edge = kind === 'hazard' ? edgeSpawn(world, size, Math.min(700, (85 + spec.rules.difficulty * 28) * pressure)) : {};
    world.entities.push({ id: world.nextId++, kind, x: 28 + random(world) * (width - size - 56), y: -size - random(world) * 45,
      w: size, h: size, vx: kind === 'hazard' ? (random(world) - 0.5) * 60 * pressure : 0,
      vy: Math.min(700, (kind === 'snack' ? 75 + spec.rules.difficulty * 12 : 85 + spec.rules.difficulty * 28) * pressure),
      ...(kind === 'hazard' ? { asteroid: 'large' as const } : {}), ...edge });
  }
  function fragments(world: AdvancedWorld, spec: ArcadeGameSpec, target: GameEntity, dt: number, hit: number): GameEntity[] {
    if (!spec.arcade?.splitAsteroids || target.asteroid === 'small' || world.nextId >= 2147483600) return [];
    const tier = spec.asteroids!.sizes === 3 && target.asteroid !== 'medium' ? 'medium' : 'small';
    const size = tier === 'medium' ? 30 : 18, jitter = (random(world) - 0.5) * 0.3;
    return [-1, 1].map(side => {
      const angle = Math.atan2(target.vy || 100, target.vx) + side * 0.65 + jitter, speed = Math.min(750, Math.max(100, Math.hypot(target.vx, target.vy) * 0.85));
      return { id: world.nextId++, kind: 'hazard', asteroid: tier, x: Math.max(0, Math.min(width - size, target.x + target.w / 2 - size / 2 + side * 9 + target.vx * dt * hit)),
        y: Math.max(-100, Math.min(590, target.y + target.h / 2 - size / 2 + target.vy * dt * hit)), w: size, h: size,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, grace: 0.2 };
    });
  }
  function advancedEnemyStep(world: AdvancedWorld, spec: ArcadeGameSpec, players: AdvancedPlayer[], dt: number, pressure: number) {
    const config = spec.asteroids!.enemies, living = players.filter(player => player.lives > 0), active = world.advanced;
    active.nextEnemy = Math.max(0, active.nextEnemy - dt);
    if (config.enabled && !active.nextEnemy) {
      if (active.enemies.length < config.maxShips && world.nextId < 2147483600) {
        active.enemies.push({ id: world.nextId++, x: 24 + random(world) * (width - 86), y: -40, w: 38, h: 28,
          vx: (random(world) - 0.5) * 100, vy: 55, hp: config.hitPoints, maxHp: config.hitPoints, fireCooldown: 2, phase: random(world) * Math.PI * 2 });
      }
      active.nextEnemy = Math.max(1.5, config.spawnInterval / pressure);
    }
    for (const enemy of active.enemies) {
      enemy.phase = (enemy.phase + dt * 0.8) % (Math.PI * 2);
      const nearest = living.reduce<AdvancedPlayer | undefined>((found, player) => !found || Math.hypot(player.x - enemy.x, player.y - enemy.y) < Math.hypot(found.x - enemy.x, found.y - enemy.y) ? player : found, undefined);
      if (config.difficulty === 'easy' || !nearest) { enemy.vx += (Math.sin(enemy.phase) * 75 - enemy.vx) * Math.min(1, dt * 1.5); enemy.vy = 50 + Math.cos(enemy.phase) * 20; }
      else {
        const dx = nearest.x + 21 - enemy.x - 19, dy = nearest.y + 17 - enemy.y - 14, length = Math.max(1, Math.hypot(dx, dy));
        const speed = Math.min(215, (config.difficulty === 'hard' ? 115 : 72) * Math.sqrt(pressure)), steering = config.difficulty === 'hard' ? 2.4 : 0.65;
        enemy.vx += (dx / length * speed - enemy.vx) * Math.min(1, dt * steering); enemy.vy += (dy / length * speed - enemy.vy) * Math.min(1, dt * steering);
      }
      enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt;
      if (enemy.x < 4 || enemy.x > width - enemy.w - 4) { enemy.vx *= -1; enemy.x = Math.max(4, Math.min(width - enemy.w - 4, enemy.x)); }
      enemy.fireCooldown = Math.max(0, enemy.fireCooldown - dt);
      if (config.difficulty === 'hard' && nearest && enemy.y >= 0 && !enemy.fireCooldown && active.enemyBullets.length < 24 && world.nextId < 2147483600) {
        const dx = nearest.x + 21 - enemy.x - 19, dy = nearest.y + 17 - enemy.y - 14, length = Math.max(1, Math.hypot(dx, dy));
        const speed = Math.min(235, 150 + pressure * 22);
        active.enemyBullets.push({ id: world.nextId++, x: enemy.x + 19, y: enemy.y + 14, vx: dx / length * speed, vy: dy / length * speed, ttl: 4 });
        enemy.fireCooldown = Math.max(1.5, 2.5 - pressure * 0.3);
      }
    }
    active.enemies = active.enemies.filter(enemy => enemy.y < height + 50 && enemy.hp > 0);
  }
  /** One advanced world implementation serves solo and both cooperative ships. */
  function stepAdvanced(world: AdvancedWorld, spec: ArcadeGameSpec, players: AdvancedPlayer[], inputs: GameInput[], elapsed: number) {
    if (world.outcome !== 'playing' || !Number.isFinite(elapsed) || elapsed <= 0) return;
    const dt = Math.min(elapsed, 1 / 20), persistent = endless(spec);
    world.elapsed = persistent ? world.elapsed + dt : Math.min(spec.rules.timeLimit, world.elapsed + dt);
    const scale = persistent ? difficulty(spec, world.elapsed) : { level: spec.rules.difficulty, pressure: 1 }; world.advanced.difficulty = scale.level;
    for (let seat = 0; seat < players.length; seat++) {
      const player = players[seat], input = inputs[seat] || {};
      player.invulnerable = Math.max(0, player.invulnerable - dt); player.fireCooldown = Math.max(0, player.fireCooldown - dt);
      if (!player.lives) continue;
      if (player.effects && !persistent) tickEffects(player.effects, dt);
      const speed = (110 + spec.player.speed * 32) * (player.effects?.speedBoost ? 1.6 : 1);
      let dx = Number(Boolean(input.right)) - Number(Boolean(input.left)), dy = Number(Boolean(input.down)) - Number(Boolean(input.up));
      if (spec.arcade?.rotation) {
        player.angle = ((player.angle + dx * 2.8 * dt) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        const thrust = Number(Boolean(input.up)) - Number(Boolean(input.down)); dx = Math.cos(player.angle) * thrust; dy = Math.sin(player.angle) * thrust;
      } else if (dx && dy) { dx /= Math.SQRT2; dy /= Math.SQRT2; }
      player.x = Math.max(0, Math.min(width - 42, player.x + dx * speed * dt)); player.y = Math.max(12, Math.min(height - 49, player.y + dy * speed * dt));
    }
    if (spec.powerUps && world.powerUps) advancePrizes(world, world.powerUps, spec.powerUps, dt, players.map(player => ({ x: player.x, y: player.y, effects: player.effects!, lives: player.lives })), world.nextId < 2147483600);
    for (let seat = 0; seat < players.length; seat++) {
      const player = players[seat], offsets = player.effects?.tripleShot ? [-0.18, 0, 0.18] : [0];
      if (!player.lives || !inputs[seat]?.fire || player.fireCooldown || world.bullets.filter(bullet => (bullet.owner || 0) === seat).length + offsets.length > 32 || world.bullets.length + offsets.length > 64 || world.nextId >= 2147483600) continue;
      const forward = spec.arcade?.rotation ? player.angle : -Math.PI / 2;
      for (const offset of offsets) { const angle = forward + offset; world.bullets.push({ id: world.nextId++, owner: seat as 0 | 1, x: player.x + 21 + Math.cos(angle) * 25, y: player.y + 17 + Math.sin(angle) * 25, vx: Math.cos(angle) * 620, vy: Math.sin(angle) * 620, ttl: 1.6 }); }
      player.fireCooldown = player.effects?.rapidFire ? 0.08 : 0.22;
    }
    world.nextSnack -= dt; world.nextHazard -= dt;
    if (world.nextSnack <= 0) { if (players.some(player => player.lives && (persistent || player.score < spec.rules.goal))) advancedSpawn(world, spec, 'snack', scale.pressure); world.nextSnack = Math.min(0.8, spec.rules.timeLimit / (spec.rules.goal * (players.length === 2 ? 3.4 : 1.7))); }
    if (world.nextHazard <= 0) { advancedSpawn(world, spec, 'hazard', scale.pressure); world.nextHazard = Math.max(0.15, (1.15 - spec.rules.difficulty * 0.13) / scale.pressure); }
    advancedEnemyStep(world, spec, players, dt, scale.pressure);
    const removed = new Set<number>(), deadEnemies = new Set<number>(), children: GameEntity[] = [];
    world.bullets = world.bullets.filter(bullet => {
      const dx = bullet.vx * dt, dy = bullet.vy * dt;
      let nearest: GameEntity | GameEnemy | undefined, first = Infinity, enemyHit = false;
      for (const entity of world.entities) if (!removed.has(entity.id) && (entity.kind === 'hazard' || players[bullet.owner || 0].lives && (persistent || players[bullet.owner || 0].score < spec.rules.goal))) {
        const hit = sweptHit(bullet.x, bullet.y, dx - entity.vx * dt, dy - entity.vy * dt, entity);
        if (hit !== undefined && hit < first) { nearest = entity; first = hit; enemyHit = false; }
      }
      for (const enemy of world.advanced.enemies) if (!deadEnemies.has(enemy.id)) {
        const hit = sweptHit(bullet.x, bullet.y, dx, dy, { ...enemy, kind: 'hazard' });
        if (hit !== undefined && hit < first) { nearest = enemy; first = hit; enemyHit = true; }
      }
      if (shotPrize(bullet, dt, world.powerUps, spec.powerUps, players[bullet.owner || 0], first)) return false;
      if (nearest) {
        let earned = 0;
        if (enemyHit) { const enemy = nearest as GameEnemy; enemy.hp--; if (!enemy.hp) { deadEnemies.add(enemy.id); earned = spec.asteroids!.enemies.difficulty === 'hard' ? 300 : spec.asteroids!.enemies.difficulty === 'medium' ? 200 : 100; } }
        else if ((nearest as GameEntity).kind === 'snack') { removed.add(nearest.id); const owner = players[bullet.owner || 0]; owner.score = Math.min(persistent ? 2147483647 : spec.rules.goal, owner.score + 1); earned = 10; }
        else { const asteroid = nearest as GameEntity; removed.add(asteroid.id); earned = asteroid.asteroid === 'small' ? 50 : asteroid.asteroid === 'medium' ? 30 : 20; children.push(...fragments(world, spec, asteroid, dt, first)); }
        const owner = players[bullet.owner || 0]; if (spec.arcade?.scoring) owner.points = Math.min(2147483647, owner.points + earned);
        return false;
      }
      bullet.x += dx; bullet.y += dy; bullet.ttl -= dt;
      return bullet.ttl > 0 && bullet.x > -30 && bullet.x < width + 30 && bullet.y > -30 && bullet.y < height + 30;
    });
    world.advanced.enemies = world.advanced.enemies.filter(enemy => !deadEnemies.has(enemy.id));
    for (const entity of world.entities) {
      if (removed.has(entity.id)) continue;
      entity.x += entity.vx * dt; entity.y += entity.vy * dt; if (entity.grace) entity.grace = Math.max(0, entity.grace - dt);
      for (const seat of players.length === 2 && entity.id % 2 ? [1, 0] : players.map((_player, index) => index)) {
        const player = players[seat]; if (!player.lives || !overlaps({ x: player.x, y: player.y, w: 42, h: 34 }, entity)) continue;
        if (entity.kind === 'snack') { if (!persistent && player.score >= spec.rules.goal) continue; removed.add(entity.id); player.score = Math.min(2147483647,player.score + 1); if (spec.arcade?.scoring) player.points = Math.min(2147483647, player.points + 10); break; }
        if (!entity.grace) advancedImpact(player, persistent);
      }
    }
    world.entities = world.entities.filter(entity => !removed.has(entity.id) && entity.y > -128 && entity.y < height + 60 && entity.x > -64 && entity.x < width + 64).concat(children);
    for (const enemy of world.advanced.enemies) for (const player of players) if (overlaps({ x: player.x, y: player.y, w: 42, h: 34 }, enemy)) advancedImpact(player, persistent);
    world.advanced.enemyBullets = world.advanced.enemyBullets.filter(bullet => {
      const dx = bullet.vx * dt, dy = bullet.vy * dt;
      let hit = false;
      for (const player of players) if (player.lives && sweptHit(bullet.x, bullet.y, dx, dy, { id: 0, kind: 'hazard', x: player.x, y: player.y, w: 42, h: 34, vx: 0, vy: 0 }) !== undefined) { advancedImpact(player, persistent); hit = true; break; }
      bullet.x += dx; bullet.y += dy; bullet.ttl -= dt;
      return !hit && bullet.ttl > 0 && bullet.x > -30 && bullet.x < width + 30 && bullet.y > -30 && bullet.y < height + 30;
    });
    if (players.every(player => !player.lives)) world.outcome = 'lost';
    else if (!persistent && players.every(player => player.score >= spec.rules.goal)) world.outcome = 'won';
    else if (!persistent && world.elapsed >= spec.rules.timeLimit) world.outcome = 'lost';
  }
  function drawAdvanced(ctx: CanvasRenderingContext2D, advanced: GameAdvancedWorld, paint?: ReturnType<typeof spritePainter>) {
    for (const enemy of advanced.enemies) {
      if (!paint?.(ctx, 'enemy', enemy.x, enemy.y, enemy.w, enemy.h)) {
      ctx.fillStyle = '#e36b63'; ctx.strokeStyle = '#4c183f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(enemy.x + 19, enemy.y + 28); ctx.lineTo(enemy.x, enemy.y + 2); ctx.lineTo(enemy.x + 19, enemy.y + 9); ctx.lineTo(enemy.x + 38, enemy.y + 2); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = '#28192c'; ctx.fillRect(enemy.x, enemy.y - 8, 38, 4); ctx.fillStyle = '#f6dd8d'; ctx.fillRect(enemy.x, enemy.y - 8, 38 * enemy.hp / enemy.maxHp, 4);
    }
    for (const bullet of advanced.enemyBullets) { ctx.strokeStyle = '#ff6868'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(bullet.x - bullet.vx / 60, bullet.y - bullet.vy / 60); ctx.lineTo(bullet.x, bullet.y); ctx.stroke(); }
  }
  function spawn(state: GameState, spec: ArcadeGameSpec, kind: 'snack' | 'hazard') {
    const arcade = spec.genre === 'dodge' && spec.arcade;
    // Reserve both future fragments while a large rock is alive, so splitting
    // always creates exactly two fragments without allowing entity explosions.
    if (arcade && state.entities.reduce((count, entity) => count + (entity.kind === 'hazard' && entity.asteroid !== 'small' ? 2 : 1), 0) + (kind === 'hazard' ? 2 : 1) > (spec.version === 5 ? 64 : 128)) return;
    const size = kind === 'snack' ? 22 : arcade && (arcade.shooting || arcade.rotation) ? 42 : 30;
    for (let attempt = 0; attempt < (spec.version !== 1 ? 40 : 1); attempt++) {
      let x = 35 + random(state) * (width - 70 - size), y = 35 + random(state) * (height - 130 - size), vx = 0, vy = 0;
      if (spec.genre === 'platformer') {
        const platform = state.platforms[1 + Math.floor(random(state) * (state.platforms.length - 1))];
        x = platform.x + 18 + random(state) * (platform.w - 60); y = platform.y - size;
        if (kind === 'hazard') { vx = (random(state) > 0.5 ? 1 : -1) * (20 + spec.rules.difficulty * 8); }
      } else if (spec.genre === 'dodge') {
        y = -size - random(state) * 50;
        vy = kind === 'snack' ? 75 + spec.rules.difficulty * 12 : 85 + spec.rules.difficulty * 28;
        if (kind === 'hazard' && arcade) ({ x, y, vx, vy } = edgeSpawn(state, size, vy));
      } else if (kind === 'hazard') {
        vx = (random(state) > 0.5 ? 1 : -1) * (25 + spec.rules.difficulty * 10);
        vy = (random(state) > 0.5 ? 1 : -1) * (15 + spec.rules.difficulty * 5);
      }
      // Keep the initial board playable without an unavoidable hit at spawn.
      if (spec.genre === 'collect' && Math.abs(x - state.player.x) < 95 && Math.abs(y - state.player.y) < 95) x = x < width / 2 ? width - 100 : 50;
      const entity: GameEntity = { id: state.nextId, kind, x, y, w: size, h: size, vx, vy, ...(arcade && kind === 'hazard' ? { asteroid: 'large' as const } : {}) };
      if (spec.version !== 1 && attempt < 39 && (overlaps({ ...state.player, x: state.player.x - 16, y: state.player.y - 16, w: state.player.w + 32, h: state.player.h + 32 }, entity) || state.entities.some(other => overlaps({ ...other, x: other.x - 8, y: other.y - 8, w: other.w + 16, h: other.h + 16 }, entity)))) continue;
      state.entities.push(entity); state.nextId++; return;
    }
  }
  function create(original: ArcadeGameSpec, selected: string | number = 0): GameState {
    const levels = getLevels(original);
    const index = endless(original) ? 0 : typeof selected === 'number' ? selected : levels.findIndex(level => level.id === selected);
    if (!Number.isInteger(index) || index < 0 || index >= levels.length) throw new Error('Choose a level in this game.');
    const spec = forLevel(original, index);
    const state: GameState = {
      player: { x: spec.genre === 'platformer' ? 48 : 460, y: spec.genre === 'platformer' ? 464 : spec.genre === 'dodge' ? 448 : 260, w: 42, h: 34, vy: 0, grounded: spec.genre === 'platformer' },
      entities: [], platforms: spec.genre === 'platformer' ? [{ x: 0, y: 500, w: 960, h: 40 }, { x: 40, y: 420, w: 270, h: 16 }, { x: 250, y: 340, w: 270, h: 16 }, { x: 460, y: 260, w: 270, h: 16 }, { x: 650, y: 180, w: 270, h: 16 }, { x: 430, y: 100, w: 270, h: 16 }] : [],
      score: 0, lives: spec.rules.lives, elapsed: 0, invulnerable: 1, nextSnack: 0.4, nextHazard: 0.7, seed: original.version !== 1 ? levels[index].seed : 17031, nextId: 1, previousJump: false, outcome: 'playing', levelIndex: index, levelId: levels[index].id,
      ...(spec.arcade?.rotation || spec.arcade?.shooting ? { angle: -Math.PI / 2 } : {}),
      ...(spec.arcade?.shooting ? { bullets: [], fireCooldown: 0 } : {}),
      ...(spec.arcade?.scoring ? { points: 0 } : {}),
      ...((spec.version === 5 || spec.version === 6) && spec.powerUps ? { powerUps: { pickups: [], nextSpawn: spec.powerUps.spawnInterval, effects: newEffects() } } : {}),
      ...(spec.version === 6 ? { advanced: advancedWorld(spec) } : {}),
    };
    if (original.version !== 1 && spec.genre === 'platformer') {
      // Each successive surface overlaps the last by at least 50px, so even the
      // slowest player can jump vertically in the overlap. A 75px rise is below
      // the minimum jump apex, including the engine's largest permitted step.
      state.platforms = [{ x: 0, y: 500, w: width, h: 40 }];
      const anchors = [40, 220, 400, 580, 400];
      for (let i = 0; i < anchors.length; i++) state.platforms.push({ x: Math.max(15, Math.min(645, anchors[i] + Math.floor(random(state) * 51) - 25)), y: 425 - i * 75, w: 300, h: 16 });
    }
    if (spec.genre !== 'dodge') {
      for (let i = 0; i < Math.min(7, spec.rules.goal); i++) spawn(state, spec, 'snack');
      for (let i = 0; i < spec.rules.difficulty + 1; i++) spawn(state, spec, 'hazard');
    }
    return state;
  }
  function step(state: GameState, original: ArcadeGameSpec, input: GameInput, elapsed: number): GameState {
    const spec = forLevel(original, state.levelIndex || 0);
    if (state.outcome !== 'playing' || !Number.isFinite(elapsed) || elapsed <= 0) return state;
    if (spec.version === 6) {
      const player: AdvancedPlayer = { ...state.player, score: state.score, lives: state.lives, invulnerable: state.invulnerable, angle: state.angle ?? -Math.PI / 2, previousJump: state.previousJump, fireCooldown: state.fireCooldown || 0, points: state.points || 0, effects: state.powerUps?.effects };
      stepAdvanced(state as AdvancedWorld, spec, [player], [input], elapsed);
      Object.assign(state.player, { x: player.x, y: player.y, vy: player.vy, grounded: player.grounded });
      state.score = player.score; state.lives = player.lives; state.invulnerable = player.invulnerable; state.angle = player.angle; state.fireCooldown = player.fireCooldown;
      if (spec.arcade?.scoring) state.points = player.points;
      return state;
    }
    const dt = Math.min(elapsed, 1 / 20), player = state.player;
    const arcade = spec.genre === 'dodge' ? spec.arcade : undefined;
    state.elapsed = Math.min(spec.rules.timeLimit, state.elapsed + dt);
    state.invulnerable = Math.max(0, state.invulnerable - dt);
    if (state.powerUps) tickEffects(state.powerUps.effects, dt);
    const speed = (110 + spec.player.speed * 32) * (state.powerUps?.effects.speedBoost ? 1.6 : 1);
    let dx = Number(Boolean(input.right)) - Number(Boolean(input.left));
    let dy = Number(Boolean(input.down)) - Number(Boolean(input.up));
    if (spec.genre === 'platformer') {
      const jump = Boolean(input.jump || input.up);
      if (jump && !state.previousJump && player.grounded) { player.vy = -(300 + spec.player.jump * 17); player.grounded = false; }
      state.previousJump = jump;
      const oldBottom = player.y + player.h;
      player.x = Math.max(0, Math.min(width - player.w, player.x + dx * speed * dt));
      player.vy += 900 * dt;
      player.y += player.vy * dt;
      player.grounded = false;
      if (player.vy >= 0) for (const platform of state.platforms) {
        if (oldBottom <= platform.y + 0.5 && player.y + player.h >= platform.y && player.x + player.w > platform.x && player.x < platform.x + platform.w) {
          player.y = platform.y - player.h; player.vy = 0; player.grounded = true; break;
        }
      }
      if (player.y > height + 60) { state.lives--; player.x = 48; player.y = 464; player.vy = 0; state.invulnerable = 1.5; }
    } else if (arcade?.rotation) {
      state.angle = (((state.angle ?? -Math.PI / 2) + dx * 2.8 * dt) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const thrust = Number(Boolean(input.up)) - Number(Boolean(input.down));
      player.x = Math.max(0, Math.min(width - player.w, player.x + Math.cos(state.angle) * thrust * speed * dt));
      player.y = Math.max(12, Math.min(height - player.h - 15, player.y + Math.sin(state.angle) * thrust * speed * dt));
    } else {
      if (dx && dy) { dx /= Math.SQRT2; dy /= Math.SQRT2; }
      player.x = Math.max(0, Math.min(width - player.w, player.x + dx * speed * dt));
      player.y = Math.max(12, Math.min(height - player.h - 15, player.y + dy * speed * dt));
    }
    if (spec.version === 5 && spec.powerUps && state.powerUps) advancePrizes(state, state.powerUps, spec.powerUps, dt, [{ x: player.x, y: player.y, effects: state.powerUps.effects, lives: state.lives }]);
    if (spec.genre === 'dodge') {
      state.nextSnack -= dt; state.nextHazard -= dt;
      if (state.nextSnack <= 0) { spawn(state, spec, 'snack'); state.nextSnack = Math.min(0.8, spec.rules.timeLimit / (spec.rules.goal * 1.7)); }
      if (state.nextHazard <= 0) { spawn(state, spec, 'hazard'); state.nextHazard = 1.15 - spec.rules.difficulty * 0.13; }
    }
    if (arcade?.shooting) {
      state.bullets ||= [];
      state.fireCooldown = Math.max(0, (state.fireCooldown || 0) - dt);
      const angles = state.powerUps?.effects.tripleShot ? [-0.18, 0, 0.18] : [0];
      if (input.fire && !state.fireCooldown && state.bullets.length + angles.length <= 32) {
        const forward = arcade.rotation ? (state.angle ?? -Math.PI / 2) : -Math.PI / 2;
        for (const offset of angles) { const angle = forward + offset; state.bullets.push({ id: state.nextId++, x: player.x + player.w / 2 + Math.cos(angle) * 25, y: player.y + player.h / 2 + Math.sin(angle) * 25, vx: Math.cos(angle) * 620, vy: Math.sin(angle) * 620, ttl: 1.6 }); }
        state.fireCooldown = state.powerUps?.effects.rapidFire ? 0.08 : 0.22;
      }
    }
    const collected = new Set<number>();
    const destroyed = new Set<number>(), fragments: GameEntity[] = [];
    if (arcade?.shooting && state.bullets) {
      state.bullets = state.bullets.filter(bullet => {
        const dx = bullet.vx * dt, dy = bullet.vy * dt;
        let nearest: GameEntity | undefined, first = Infinity;
        for (const entity of state.entities) {
          if (destroyed.has(entity.id) || collected.has(entity.id) || entity.kind === 'snack' && (state.score >= spec.rules.goal || !state.lives)) continue;
          const hit = sweptHit(bullet.x, bullet.y, dx - entity.vx * dt, dy - entity.vy * dt, entity);
          if (hit !== undefined && hit < first) { nearest = entity; first = hit; }
        }
        if (shotPrize(bullet, dt, state.powerUps, spec.powerUps, { lives: state.lives, effects: state.powerUps?.effects }, first)) return false;
        if (nearest) {
          if (nearest.kind === 'snack') { collected.add(nearest.id); state.score++; if (arcade.scoring) state.points = (state.points || 0) + 10; return false; }
          destroyed.add(nearest.id);
          if (arcade.scoring) state.points = (state.points || 0) + (nearest.asteroid === 'small' ? 50 : 20);
          if (arcade.splitAsteroids && nearest.asteroid !== 'small') {
            const jitter = (random(state) - 0.5) * 0.3;
            for (const side of [-1, 1]) {
              const angle = Math.atan2(nearest.vy || 100, nearest.vx) + side * 0.65 + jitter, speed = Math.max(100, Math.hypot(nearest.vx, nearest.vy) * 0.8);
              fragments.push({ id: state.nextId++, kind: 'hazard', asteroid: 'small', x: Math.max(0, Math.min(width - 20, nearest.x + nearest.w / 2 - 10 + side * 8 + nearest.vx * dt * first)), y: nearest.y + nearest.h / 2 - 10 + nearest.vy * dt * first, w: 20, h: 20, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, grace: 0.18 });
            }
          }
          return false;
        }
        bullet.x += dx; bullet.y += dy; bullet.ttl -= dt;
        return bullet.ttl > 0 && bullet.x > -30 && bullet.x < width + 30 && bullet.y > -30 && bullet.y < height + 30;
      });
    }
    for (const entity of state.entities) {
      if (destroyed.has(entity.id) || collected.has(entity.id)) continue;
      entity.x += entity.vx * dt; entity.y += entity.vy * dt;
      if (entity.grace) entity.grace = Math.max(0, entity.grace - dt);
      if (spec.genre === 'collect') {
        if (entity.x <= 12 || entity.x + entity.w >= width - 12) entity.vx *= -1;
        if (entity.y <= 12 || entity.y + entity.h >= height - 35) entity.vy *= -1;
        entity.x = Math.max(12, Math.min(width - entity.w - 12, entity.x)); entity.y = Math.max(12, Math.min(height - entity.h - 35, entity.y));
      } else if (spec.genre === 'platformer' && entity.kind === 'hazard') {
        const surface = state.platforms.find(platform => Math.abs(platform.y - entity.y - entity.h) < 1);
        if (surface && (entity.x <= surface.x + 5 || entity.x + entity.w >= surface.x + surface.w - 5)) entity.vx *= -1;
      }
      if (!overlaps(player, entity)) continue;
      if (entity.kind === 'snack') { collected.add(entity.id); if (arcade?.scoring && state.score < spec.rules.goal) state.points = (state.points || 0) + 10; state.score++; }
      else if (!state.invulnerable && !entity.grace) {
        if (state.powerUps?.effects.shield) state.powerUps.effects.shield = 0; else state.lives--; state.invulnerable = 1.5;
        if (spec.genre === 'platformer') { player.x = 48; player.y = 464; player.vy = 0; }
      }
    }
    state.entities = state.entities.filter(entity => !collected.has(entity.id) && !destroyed.has(entity.id) && entity.y > -128 && entity.y < height + 60 && (!arcade || entity.x > -60 && entity.x < width + 60)).concat(fragments);
    if (spec.genre !== 'dodge') for (let i = 0; i < collected.size && state.score < spec.rules.goal; i++) spawn(state, spec, 'snack');
    if (state.lives <= 0) { state.lives = 0; state.outcome = 'lost'; }
    else if (state.score >= spec.rules.goal) { state.score = spec.rules.goal; state.outcome = 'won'; }
    else if (state.elapsed >= spec.rules.timeLimit) state.outcome = 'lost';
    return state;
  }
  function nextLevel(state: GameState, spec: ArcadeGameSpec): GameState | undefined {
    if (endless(spec)) return undefined;
    if (state.outcome !== 'won' || state.levelIndex + 1 >= getLevels(spec).length) return undefined;
    return create(spec, state.levelIndex + 1);
  }
  return { spritePainter, edgeSpawn, shotPrize, collectPrize, create, step, nextLevel, getLevels, forLevel, overlaps, sweptHit, maxPoints, newEffects, tickEffects, advancePrizes, effectLabel, drawPrizes, endless, advancedWorld, difficulty, descendantBudget, advancedImpact, stepAdvanced, drawAdvanced, width, height };
}

/** Treat the opaque frame's results as untrusted messages, never as permissions. */
export function validateGameResult(value: unknown, spec: GameSpec, levelId?: string): GameResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  if (spec.version === 3) {
    if (Object.keys(result).length !== 4 || Object.keys(result).some(key => !['outcome', 'elapsed', 'score', 'reviewedLevelIds'].includes(key))) return;
    if (levelId && levelId !== 'level-1' || !['won', 'lost'].includes(result.outcome as string) || !Array.isArray(result.reviewedLevelIds) || result.reviewedLevelIds.length !== 1 || result.reviewedLevelIds[0] !== 'level-1') return;
    const max = spec.genre === 'crossword' ? spec.puzzle.entries.length : spec.genre === 'word-search' ? spec.puzzle.words.length : spec.puzzle.blanks.length;
    if (typeof result.elapsed !== 'number' || !Number.isFinite(result.elapsed) || result.elapsed < 0 || result.elapsed > 86400 || typeof result.score !== 'number' || !Number.isInteger(result.score) || result.score < 0 || result.score > max || result.outcome === 'won' && result.score !== max || spec.genre !== 'crossword' && result.outcome === 'lost') return;
    return { outcome: result.outcome as 'won' | 'lost', elapsed: result.elapsed, score: result.score, reviewedLevelIds: ['level-1'] };
  }

  if (!['level-complete', 'won', 'lost'].includes(result.outcome as string) || !Array.isArray(result.reviewedLevelIds) || !result.reviewedLevelIds.length || result.reviewedLevelIds.some(id => typeof id !== 'string') || new Set(result.reviewedLevelIds).size !== result.reviewedLevelIds.length) return;
  const ids = result.reviewedLevelIds as string[];
  const levels = createGameEngine().getLevels(spec);
  if (spec.version === 6 && spec.asteroids!.endless) {
    if (result.outcome !== 'lost' || ids.length !== 1 || ids[0] !== levels[0].id || levelId && levelId !== levels[0].id) return;
    if (typeof result.elapsed !== 'number' || !Number.isFinite(result.elapsed) || result.elapsed < 0 || result.elapsed > 2147483647 || typeof result.score !== 'number' || !Number.isInteger(result.score) || result.score < 0 || result.score > Math.min(2147483647,Math.ceil(result.elapsed*20)+40)) return;
    if (spec.arcade?.scoring ? typeof result.points !== 'number' || !Number.isSafeInteger(result.points) || result.points < 0 || result.points > createGameEngine().maxPoints(spec, ids, result.elapsed) : 'points' in result) return;
    return { outcome: 'lost', elapsed: result.elapsed, score: result.score, reviewedLevelIds: [levels[0].id], ...(spec.arcade?.scoring ? { points: result.points as number } : {}) };
  }
  const allowed = levelId ? levels.filter(level => level.id === levelId) : levels.slice(0, result.reviewedLevelIds.length);
  if (!allowed.length || allowed.length !== result.reviewedLevelIds.length || allowed.some((level, i) => level.id !== ids[i])) return;
  const maxTime = allowed.reduce((total, level) => total + level.rules.timeLimit, 0);
  const maxScore = allowed.reduce((total, level) => total + level.rules.goal, 0);
  if (typeof result.elapsed !== 'number' || !Number.isFinite(result.elapsed) || result.elapsed < 0 || result.elapsed > maxTime || typeof result.score !== 'number' || !Number.isInteger(result.score) || result.score < 0 || result.score > maxScore) return;
  if (result.outcome !== 'lost' && result.score !== maxScore) return;
  if (result.outcome === 'won' && (allowed.length !== levels.length || (Boolean(levelId) && levels.length > 1))) return;
  if (result.outcome === 'level-complete' && !levelId && allowed.length === levels.length) return;
  if (spec.arcade?.scoring ? typeof result.points !== 'number' || !Number.isSafeInteger(result.points) || result.points < 0 || result.points > createGameEngine().maxPoints(spec, ids, result.elapsed as number) : 'points' in result) return;
  return { outcome: result.outcome as GameResult['outcome'], elapsed: result.elapsed, score: result.score, reviewedLevelIds: [...result.reviewedLevelIds] as string[], ...(spec.arcade?.scoring ? { points: result.points as number } : {}) };
}

/** Fit the fixed bitmap into the iframe's remaining height; short screens scroll controls. */
export const gameCanvasViewportStyles = 'html,body{height:100%;min-height:0}main{height:100%;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden}main>:not(canvas){flex:0 0 auto}main>canvas{flex:1 1 0;width:100%;height:0;min-height:160px;object-fit:contain;object-position:center}';

/** Fixed iframe shortcut bridge; the parent alone controls display mode. */
export function installGameDisplayKeyboardBridge(nonce: string) {
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const key = event.key.toLowerCase();
    if (key === 'f' && (target?.isContentEditable || target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))) return;
    const action = key === 'escape' && !event.altKey ? 'exit' : (key === 'f' && !event.altKey || key === 'enter' && event.altKey) ? 'toggle' : undefined;
    if (!action) return;
    if (action === 'toggle') { event.preventDefault(); event.stopPropagation(); }
    parent.postMessage({ type: 'game-player-display', nonce, action }, '*');
  }, true);
}

export function startGameSandbox(engine: ReturnType<typeof createGameEngine>, validate: typeof validateArcadeGameSpec, nonce: string) {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const context = canvas.getContext('2d');
  const title = document.getElementById('title')!;
  const instruction = document.getElementById('instruction')!;
  const status = document.getElementById('status')!;
  const announce = document.getElementById('announce')!;
  const start = document.getElementById('start') as HTMLButtonElement;
  const pause = document.getElementById('pause') as HTMLButtonElement;
  const next = document.getElementById('next') as HTMLButtonElement;
  const restart = document.getElementById('restart') as HTMLButtonElement;
  const finishReview = document.getElementById('finish-review') as HTMLButtonElement | null;
  let paintSprite = engine.spritePainter();
  let gameSpec: ArcadeGameSpec | undefined, spec: ArcadeGameSpec | undefined, selectedLevel: string | undefined, state: GameState | undefined, running = false, paused = false, notified = false, playtest = false;
  let previous = 0, accumulator = 0;
  const reviews = new Map<string, { score: number; elapsed: number; points?: number }>();
  const keys = new Set<string>(), pressed = new Set<string>();
  const palette = { pond: ['#e4f2e8', '#b7d9c7', '#38796c', '#fffaf0'], space: ['#211d3e', '#3d355e', '#baaddb', '#f8edff'], garden: ['#f6f1cf', '#c9d8a5', '#6a8547', '#fffdf1'] };
  const input = () => ({ left: keys.has('arrowleft') || keys.has('a') || pressed.has('left'), right: keys.has('arrowright') || keys.has('d') || pressed.has('right'), up: keys.has('arrowup') || keys.has('w') || pressed.has('up'), down: keys.has('arrowdown') || keys.has('s') || pressed.has('down'), jump: keys.has(' ') || pressed.has('jump'), fire: keys.has(' ') || keys.has('z') || pressed.has('fire') });
  function controlHelp() {
    if (!spec) return '';
    const movement = spec.arcade?.rotation ? 'Left / Right or A / D turn the ship through 360°. Up / W thrusts forward; Down / S reverses.' : spec.genre === 'platformer' ? 'Arrow keys or WASD move. Space or Up jumps.' : 'Arrow keys or WASD move.';
    return `${movement}${spec.arcade?.shooting ? ` Space or Z fires.${spec.arcade.splitAsteroids ? spec.version === 6 && spec.asteroids!.sizes === 3 ? ' Large asteroids split into two medium rocks; each medium splits into two small pieces; shoot small pieces once to destroy them.' : ' Large asteroids split into two small pieces; shoot each small piece once to destroy it.' : ' One shot destroys an asteroid.'}` : ''}${spec.arcade?.scoring ? ` Collectibles: 10 points.${spec.arcade.shooting ? ` Large asteroids: 20 points.${spec.version === 6 && spec.asteroids!.sizes === 3 ? ' Medium rocks: 30 points.' : ''}${spec.arcade.splitAsteroids ? ' Small pieces: 50 points.' : ''}` : ''}` : ''}${spec.version === 6 && spec.asteroids!.enemies.enabled ? ` Enemy ships: ${spec.asteroids!.enemies.hitPoints} hits; ${spec.asteroids!.enemies.difficulty === 'easy' ? 'wander without pursuit' : spec.asteroids!.enemies.difficulty === 'medium' ? 'track your ship gradually' : 'pursue and fire aimed, dodgeable shots'}.` : ''}${spec.powerUps ? ` Shoot or collect prizes: 3 = triple shot, » = rapid fire, S = one-hit shield, ↑ = speed boost. ${engine.endless(spec) ? 'Prizes last until any damaging impact; shield absorbs one hit, which clears all prizes.' : 'Shoot or fly over a prize to collect it; timed prizes refresh without stacking.'}` : ''} P pauses. R restarts this level.`;
  }
  function levelInstructions(brief: string) {
    if (!gameSpec || !spec) return '';
    if (engine.endless(spec)) return `Survive as long as possible. Difficulty increases every ${spec.asteroids!.difficultyInterval} seconds of active play. All lives lost ends the run; treasures and the authored timer do not finish it.`;
    if (gameSpec.version === 1) return gameSpec.instructions;
    return `${brief} Objective: Collect ${spec.rules.goal} ${spec.objects.collectible}s in ${spec.rules.timeLimit} seconds. ${spec.rules.lives} ${spec.rules.lives === 1 ? 'life' : 'lives'}. Avoid ${spec.objects.hazard}s.`;
  }
  function begin(level: number | string, clear: boolean) {
    if (!gameSpec) return;
    if (clear) reviews.clear();
    state = engine.create(gameSpec, level); spec = engine.forLevel(gameSpec, state.levelIndex);
    reviews.delete(state.levelId);
    running = true; paused = false; notified = false; accumulator = 0; keys.clear(); pressed.clear();
    if (finishReview) finishReview.hidden = true;
    start.textContent = 'Restart level'; pause.textContent = 'Pause'; pause.disabled = false; next.hidden = true;
    restart.hidden = engine.endless(spec) || engine.getLevels(gameSpec).length === 1 || Boolean(selectedLevel);
    const levelInfo = engine.getLevels(gameSpec)[state.levelIndex];
    title.textContent = gameSpec.version === 1 ? spec.title : `${gameSpec.title} · Level ${state.levelIndex + 1}: ${levelInfo.title}`;
    instruction.textContent = levelInstructions(levelInfo.brief);
    document.getElementById('controls-help')!.textContent = controlHelp();
    canvas.setAttribute('aria-label', `${gameSpec.title}, level ${state.levelIndex + 1}: ${levelInfo.title}. ${engine.endless(spec) ? 'Survive until all lives are lost.' : `Collect ${spec.rules.goal} ${spec.objects.collectible}s and avoid ${spec.objects.hazard}s.`} ${controlHelp()}`);
    announce.textContent = `Level ${state.levelIndex + 1} started. ${instruction.textContent}`; canvas.focus();
  }
  function reset() { if (gameSpec) begin(state?.levelIndex || 0, false); }
  function restartGame() { if (gameSpec) begin(selectedLevel || 0, true); }
  function togglePause() {
    if (!state || !running || state.outcome !== 'playing') return;
    paused = !paused; keys.clear(); pressed.clear(); pause.textContent = paused ? 'Resume' : 'Pause';
    announce.textContent = paused ? 'Paused. Choose Resume to keep playing.' : 'Game resumed.';
    if (!paused) canvas.focus();
  }
  start.addEventListener('click', reset); pause.addEventListener('click', togglePause);
  restart.addEventListener('click', restartGame);
  finishReview?.addEventListener('click', () => {
    if (!playtest || !spec || !engine.endless(spec) || !state || !running || state.outcome !== 'playing' || state.elapsed < 5 || notified) return;
    running = false; paused = false; notified = true; keys.clear(); pressed.clear(); pause.disabled = true; next.hidden = true; finishReview.hidden = true;
    announce.textContent = 'Playtest stopped for review. This is not a completed game or a submitted score.';
    parent.postMessage({ type: 'axolotl-game-review', nonce, review: { elapsed: state.elapsed, reviewedLevelIds: [state.levelId] } }, '*');
  });
  next.addEventListener('click', () => { if (gameSpec && state?.outcome === 'won' && !selectedLevel && state.levelIndex + 1 < engine.getLevels(gameSpec).length) begin(state.levelIndex + 1, false); });
  document.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'a', 'd', 'w', 's', 'z', 'p', 'escape', 'r'].includes(key) && !([start, pause, next, restart, ...(finishReview ? [finishReview] : [])] as EventTarget[]).includes(event.target!)) {
      event.preventDefault();
      if ((key === 'p' || key === 'escape') && !event.repeat) togglePause();
      else if (key === 'r' && !event.repeat) reset();
      else keys.add(key);
    }
  });
  document.addEventListener('keyup', event => { keys.delete(event.key.toLowerCase()); });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-control]')) {
    const control = button.dataset.control!;
    button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); pressed.add(control); });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, () => { pressed.delete(control); });
    button.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); pressed.add(control); } });
    button.addEventListener('keyup', () => { pressed.delete(control); });
    button.addEventListener('blur', () => { pressed.delete(control); });
  }
  window.addEventListener('blur', () => { keys.clear(); pressed.clear(); if (running && !paused && state?.outcome === 'playing') togglePause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && running && !paused && state?.outcome === 'playing') togglePause(); });
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || event.data.type !== 'axolotl-game-load' || event.data.nonce !== nonce || gameSpec) return;
    try {
      gameSpec = validate(event.data.spec); paintSprite = engine.spritePainter(gameSpec.sprites);
      playtest = event.data.playtest === true;
      selectedLevel = typeof event.data.levelId === 'string' ? event.data.levelId : undefined;
      state = engine.create(gameSpec, selectedLevel || 0); spec = engine.forLevel(gameSpec, state.levelIndex);
      const levelInfo = engine.getLevels(gameSpec)[state.levelIndex];
      title.textContent = gameSpec.version === 1 ? spec.title : `${gameSpec.title} · Level ${state.levelIndex + 1}: ${levelInfo.title}`; instruction.textContent = levelInstructions(levelInfo.brief);
      restart.hidden = engine.endless(spec) || engine.getLevels(gameSpec).length === 1 || Boolean(selectedLevel);
      canvas.setAttribute('aria-label', `${spec.title}. ${controlHelp()} ${engine.endless(spec) ? 'Survive until all lives are lost.' : `Collect ${spec.rules.goal} ${spec.objects.collectible}s and avoid ${spec.objects.hazard}s.`}`);
      document.getElementById('controls-help')!.textContent = controlHelp();
      document.getElementById('legend')!.textContent = `Reward: ${spec.objects.collectible} · Obstacle: ${spec.objects.hazard}`;
      document.getElementById('jump')!.hidden = spec.genre !== 'platformer';
      document.getElementById('fire')!.hidden = !spec.arcade?.shooting;
      const labels: Record<string, string> = spec.arcade?.rotation ? { left: 'Turn left', right: 'Turn right', up: 'Thrust forward', down: 'Reverse thrust' } : { left: 'Move left', right: 'Move right', up: spec.genre === 'platformer' ? 'Move up or jump' : 'Move up', down: 'Move down' };
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-control]')) if (labels[button.dataset.control!]) button.setAttribute('aria-label', labels[button.dataset.control!]);
      start.disabled = false; announce.textContent = 'Ready. Choose Start game.';
      parent.postMessage({ type: 'axolotl-game-loaded', nonce }, '*');
    } catch { announce.textContent = 'This game could not be loaded safely.'; }
  });
  function draw() {
    if (!context || !spec || !state) return;
    const ctx = context, colors = palette[spec.theme];
    ctx.fillStyle = colors[0]; ctx.fillRect(0, 0, engine.width, engine.height);
    for (let i = 0; i < 25; i++) {
      ctx.beginPath(); ctx.arc((i * 139 + 31) % 960, (i * 83 + 57) % 520, spec.theme === 'space' ? 2 : 4 + i % 3, 0, Math.PI * 2);
      ctx.fillStyle = colors[1]; ctx.fill();
    }
    if (spec.theme !== 'space') {
      ctx.strokeStyle = colors[2]; ctx.lineWidth = 5; ctx.lineCap = 'round';
      for (let i = 0; i < 12; i++) { const x = i * 89 + 20; ctx.beginPath(); ctx.moveTo(x, 540); ctx.quadraticCurveTo(x - 18, 485, x + 4, 465 - (i % 3) * 15); ctx.stroke(); }
    }
    ctx.fillStyle = colors[2];
    for (const platform of state.platforms) { ctx.fillRect(platform.x, platform.y, platform.w, platform.h); ctx.fillStyle = colors[1]; ctx.fillRect(platform.x, platform.y, platform.w, 5); ctx.fillStyle = colors[2]; }
    for (const entity of state.entities) {
      const x = entity.x + entity.w / 2, y = entity.y + entity.h / 2;
      ctx.beginPath();
      if (paintSprite(ctx, entity.kind === 'snack' ? 'reward' : 'asteroid', entity.x, entity.y, entity.w, entity.h)) continue;
      if (entity.kind === 'snack') {
        ctx.fillStyle = '#ecc96b'; ctx.strokeStyle = '#9c702d'; ctx.lineWidth = 2;
        ctx.moveTo(x, y - 12); ctx.lineTo(x + 11, y); ctx.lineTo(x, y + 12); ctx.lineTo(x - 11, y); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff8cf'; ctx.beginPath(); ctx.arc(x - 2, y - 3, 3, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = spec.theme === 'space' ? '#9b82a7' : '#718a84'; ctx.strokeStyle = '#405b55'; ctx.lineWidth = 2;
        const scale = entity.asteroid ? entity.w / 30 : 1;
        ctx.moveTo(x - 14 * scale, y + 7 * scale); ctx.lineTo(x - 10 * scale, y - 9 * scale); ctx.lineTo(x + 2 * scale, y - 14 * scale); ctx.lineTo(x + 14 * scale, y - 4 * scale); ctx.lineTo(x + 11 * scale, y + 13 * scale); ctx.lineTo(x - 7 * scale, y + 14 * scale); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#c5cec3'; ctx.beginPath(); ctx.arc(x - 4 * scale, y - 4 * scale, 3 * scale, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (state.advanced) engine.drawAdvanced(ctx, state.advanced, paintSprite);
    if (state.powerUps) engine.drawPrizes(ctx, state.powerUps.pickups, paintSprite);
    if (spec.arcade?.shooting) for (const bullet of state.bullets || []) {
      const length = 11 / 620;
      ctx.strokeStyle = '#fff4a2'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(bullet.x - bullet.vx * length, bullet.y - bullet.vy * length); ctx.lineTo(bullet.x, bullet.y); ctx.stroke();
      ctx.strokeStyle = '#ec805b'; ctx.lineWidth = 2; ctx.stroke();
    }
    const p = state.player;
    if (state.powerUps?.effects.shield) { ctx.strokeStyle = '#36cad7'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(p.x + p.w / 2, p.y + p.h / 2, 34, 0, Math.PI * 2); ctx.stroke(); }
    if (!(state.invulnerable > 0 && Math.floor(state.elapsed * 9) % 2)) {
      const x = p.x + p.w / 2, y = p.y + p.h / 2;
      ctx.save(); ctx.translate(x, y);
      if (spec.arcade?.rotation || spec.arcade?.shooting) ctx.rotate((state.angle ?? -Math.PI / 2) + Math.PI / 2);
      if (!paintSprite(ctx, 'player', -23, -25, 46, 46)) {
        ctx.fillStyle = spec.player.color; ctx.strokeStyle = '#edf8ff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, -25); ctx.lineTo(23, 17); ctx.lineTo(0, 11); ctx.lineTo(-23, 17); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#a9d9e8'; ctx.beginPath(); ctx.ellipse(0, -1, 7, 10, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    if (!running || paused || state.outcome !== 'playing') {
      ctx.fillStyle = spec.theme === 'space' ? '#211d3ed9' : '#fffaf0df'; ctx.fillRect(0, 0, 960, 540);
      ctx.textAlign = 'center'; ctx.fillStyle = spec.theme === 'space' ? '#fffaf0' : '#254e45'; ctx.font = 'bold 42px system-ui';
      const another = gameSpec && !selectedLevel && state.levelIndex + 1 < engine.getLevels(gameSpec).length;
      ctx.fillText(!running ? 'A little game. A big adventure.' : paused ? 'Taking a little breather.' : state.outcome === 'won' ? another ? 'Level complete!' : 'You did it, little explorer!' : 'Another adventure awaits.', 480, 240);
      ctx.font = '23px system-ui'; ctx.fillText(!running ? notified ? 'Playtest reviewed. Choose Restart level to try again.' : 'Choose Start game below.' : paused ? 'Choose Resume to keep playing.' : state.outcome === 'won' && another ? 'Choose Next level to continue your adventure.' : engine.endless(spec) ? `Survived ${Math.floor(state.elapsed)} seconds. Choose Restart level to try again.` : `Collected ${state.score} of ${spec.rules.goal}. Choose Restart level to try again.`, 480, 285);
    }
  }
  function frame(now: number) {
    const dt = previous ? Math.min((now - previous) / 1000, 0.1) : 0; previous = now;
    if (running && !paused && state && spec && state.outcome === 'playing') {
      accumulator += dt;
      while (accumulator >= 1 / 60) { engine.step(state, gameSpec!, input(), 1 / 60); accumulator -= 1 / 60; }
    } else accumulator = 0;
    if (state && spec) {
      const seconds = Math.max(0, Math.ceil(spec.rules.timeLimit - state.elapsed));
      const levelLabel = gameSpec && engine.getLevels(gameSpec).length > 1 ? `Level ${state.levelIndex + 1} / ${engine.getLevels(gameSpec).length} · ` : '';
      const label = engine.endless(spec) ? `Survival ${Math.floor(state.elapsed / 60)}:${String(Math.floor(state.elapsed % 60)).padStart(2, '0')} · Difficulty ${state.advanced!.difficulty}${spec.arcade?.scoring ? ` · Points ${state.points || 0}` : ''} · Lives ${state.lives}${state.powerUps ? ` · ${engine.effectLabel(state.powerUps.effects,true)}` : ''}` : `${levelLabel}Snacks ${state.score} / ${spec.rules.goal}${spec.arcade?.scoring ? ` · Points ${state.points || 0}` : ''} · Lives ${state.lives} · Time ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}${state.powerUps ? ` · ${engine.effectLabel(state.powerUps.effects)}` : ''}`;
      if (finishReview) finishReview.hidden = !playtest || !engine.endless(spec) || !running || notified || state.outcome !== 'playing' || state.elapsed < 5;
      if (status.textContent !== label) status.textContent = label;
      const previousReviews = [...reviews.entries()].filter(([id]) => id !== state!.levelId).map(([, review]) => review);
      const totalScore = previousReviews.reduce((sum, review) => sum + review.score, state.score);
      const totalTime = previousReviews.reduce((sum, review) => sum + review.elapsed, state.elapsed);
      const totalPoints = previousReviews.reduce((sum, review) => sum + (review.points || 0), state.points || 0);
      document.getElementById('campaign')!.textContent = !engine.endless(spec) && gameSpec && engine.getLevels(gameSpec).length > 1 ? `Adventure total: ${totalScore} treasures${spec.arcade?.scoring ? ` · ${totalPoints} points` : ''} · ${Math.floor(totalTime / 60)}:${String(Math.floor(totalTime % 60)).padStart(2, '0')} played` : '';
      if (state.outcome !== 'playing' && !notified) {
        notified = true; pause.disabled = true;
        const levels = engine.getLevels(gameSpec!);
        reviews.set(state.levelId, { score: state.score, elapsed: state.elapsed, ...(spec.arcade?.scoring ? { points: state.points || 0 } : {}) });
        const reviewedLevelIds = levels.filter(level => reviews.has(level.id)).map(level => level.id);
        const totals = [...reviews.values()].reduce<{ score: number; elapsed: number; points: number }>((sum, review) => ({ score: sum.score + review.score, elapsed: sum.elapsed + review.elapsed, points: sum.points + (review.points || 0) }), { score: 0, elapsed: 0, points: 0 });
        const hasNext = !selectedLevel && state.levelIndex + 1 < levels.length;
        next.hidden = state.outcome !== 'won' || !hasNext;
        const outcome = state.outcome === 'lost' ? 'lost' : hasNext || (selectedLevel && levels.length > 1) ? 'level-complete' : 'won';
        announce.textContent = state.outcome === 'won' ? hasNext ? `Level ${state.levelIndex + 1} complete. Choose Next level.` : selectedLevel && levels.length > 1 ? 'Selected level complete. Return to the editor to review another level.' : `Adventure complete! Collected ${totals.score} treasures.` : `Level ${state.levelIndex + 1} ended. Choose Restart level to try again.`;
        parent.postMessage({ type: 'axolotl-game-result', nonce, result: { outcome, score: totals.score, elapsed: totals.elapsed, reviewedLevelIds, ...(spec.arcade?.scoring ? { points: totals.points } : {}) } }, '*');
      }
    }
    draw(); requestAnimationFrame(frame);
  }
  if (!context) announce.textContent = 'Your browser cannot display this game canvas.';
  parent.postMessage({ type: 'axolotl-game-ready', nonce }, '*');
  requestAnimationFrame(frame);
}

/** Fixed markup and engine only. User-authored strings arrive later through postMessage. */
export function gameSandboxDocument(nonce: string): string {
  if (!/^[a-zA-Z0-9_-]{16,100}$/u.test(nonce)) throw new Error('A safe random game nonce is required.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'"><style>
*{box-sizing:border-box}body{margin:0;background:#fffaf0;color:#254e45;font:15px/1.4 system-ui,sans-serif}main{padding:12px}h2{font-size:20px;margin:0 0 6px}p{margin:7px 0}canvas{display:block;width:100%;aspect-ratio:16/9;background:#e4f2e8;border-radius:10px;outline-offset:3px}canvas:focus-visible,button:focus-visible{outline:3px solid #a94c7b}#status{font-weight:700;font-variant-numeric:tabular-nums}.buttons,.touch{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:10px}button{font:inherit;min-height:44px;min-width:56px;padding:8px 15px;border:1px solid #497267;border-radius:8px;background:#fffaf0;color:#254e45;cursor:pointer;touch-action:none;user-select:none}button:active{background:#cce4d5}button:disabled{opacity:.5;cursor:default}#start{background:#254e45;color:#fffaf0}.touch button{font-size:20px;min-width:54px}[hidden]{display:none!important}#announce{min-height:22px;font-weight:600;text-align:center}#legend{font-size:13px;text-align:center}#instruction{font-size:14px} @media(max-width:500px){main{padding:6px}h2{font-size:18px}.touch{gap:5px}.touch button{padding:7px;min-width:44px}#instruction{font-size:12px}}
${gameCanvasViewportStyles}
</style></head><body><main><h2 id="title">Loading your game…</h2><div id="status" aria-label="Game score"></div><div id="campaign" aria-label="Adventure totals"></div><p id="instruction"></p><canvas id="game" width="960" height="540" tabindex="0">This game needs a browser with Canvas support. Keyboard and touch controls are provided.</canvas><p id="legend"></p><div class="buttons"><button id="start" disabled>Start game</button><button id="pause" disabled>Pause</button><button id="next" hidden>Next level</button><button id="restart" hidden>Restart game</button><button id="finish-review" hidden>Finish playtest</button></div><div class="touch" aria-label="Game movement controls"><button type="button" data-control="left" aria-label="Move left">←</button><button type="button" data-control="up" aria-label="Move up or jump">↑</button><button type="button" data-control="down" aria-label="Move down">↓</button><button type="button" data-control="right" aria-label="Move right">→</button><button type="button" data-control="jump" id="jump" aria-label="Jump">Jump</button><button type="button" data-control="fire" id="fire" aria-label="Fire" hidden>Fire ✦</button></div><p id="announce" role="status" aria-live="polite">Loading…</p><p id="controls-help" style="text-align:center;font-size:12px">Arrow keys or WASD · P to pause · R to restart</p></main><script nonce="${nonce}">const __name = (fn) => fn; (${installGameDisplayKeyboardBridge.toString()})("${nonce}"); (${startGameSandbox.toString()})((${createGameEngine.toString()})(),(${validateArcadeGameSpec.toString()}),"${nonce}");</script></body></html>`;
}
