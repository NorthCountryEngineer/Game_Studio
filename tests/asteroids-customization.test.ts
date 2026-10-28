import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { designArcadeGame, updateAsteroidSettings, validateArcadeGameSpec } from '../src/lib/game-design';
import { createGameEngine, type GameBullet } from '../src/lib/game-runtime';
import { createCooperativeEngine, validateCooperativeState } from '../src/lib/game-cooperative';
import { LocalGameLibrary } from '../src/lib/game-local';
import { AsteroidSpriteEditor } from '../src/components/AsteroidSpriteEditor';
import { formatCreationPrompt, gameFormatStarters } from '../src/components/WordGameEditor';
import type { ArcadeGameSpec, CooperativeGameSpec, GameSprite, GameSprites } from '../src/lib/game-types';

const sprite: GameSprite = { width: 2, height: 1, pixels: btoa(String.fromCharCode(255, 0, 0, 255, 0, 255, 0, 255)) };
function game(cooperative = false, advanced = true) {
  const spec = designArcadeGame('Asteroids with rewards and prizes. One level, goal 3.').spec;
  const next = advanced ? updateAsteroidSettings(spec, { endless: true }) : spec;
  return { ...next, ...(cooperative ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 }, version: advanced ? 6 : 5 } : {}) } as ArcadeGameSpec;
}

test('Asteroids replaces the arcade starter and exposes four raster upload slots', () => {
  assert.equal(gameFormatStarters[0].label, 'Asteroids');
  const designed = designArcadeGame(formatCreationPrompt('arcade', 'Three levels, blue ship.')).spec;
  assert.equal(designed.genre, 'dodge'); assert.equal(designed.theme, 'space');
  assert.equal(designed.title, 'Asteroids'); assert.equal(designed.player.name, 'Pilot');
  assert.doesNotMatch(JSON.stringify(designed), /axolotl/i);
  const markup = renderToStaticMarkup(createElement(AsteroidSpriteEditor, { onChange() {}, onBusyChange() {}, disabled: false }));
  assert.equal((markup.match(/type="file"/g) || []).length, 4);
  for (const text of ['Player ship', 'Asteroids', 'Rewards', 'Enemy ships', 'image/png,image/jpeg,image/webp']) assert.ok(markup.includes(text));
});

test('sprite schema is pixel-only, bounded and matches Python validation', () => {
  const original = { ...game(), sprites: { player: sprite, asteroid: sprite, reward: sprite, enemy: sprite } };
  assert.deepEqual(validateArcadeGameSpec(original), original);
  const variants = [original, ...[
    {}, { logo: sprite }, { player: { ...sprite, width: 65 } }, { player: { ...sprite, height: 0 } },
    { player: { ...sprite, pixels: 'https://example.test/a.png' } }, { player: { ...sprite, pixels: 'data:image/svg+xml,<svg>' } },
    { player: { ...sprite, pixels: sprite.pixels.slice(0, -1) + 'B' } }, { player: { ...sprite, script: 'alert(1)' } },
    { player: { ...sprite, width: true } }, { player: { ...sprite, width: 1.5 } },
  ].map(sprites => ({ ...original, sprites }))];
  const accepted = variants.map(value => { try { validateArcadeGameSpec(value); return true; } catch { return false; } });
  assert.deepEqual(accepted, [true, ...Array(10).fill(false)]);
  const python = `import sys,json,importlib.util\ns=importlib.util.spec_from_file_location('games','backend/nce_api/games.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nresult=[]\nfor value in json.load(sys.stdin):\n try: m.validate_spec(value);result.append(True)\n except m.GameError: result.append(False)\nprint(json.dumps(result))`;
  assert.deepEqual(JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify(variants), encoding: 'utf8' })), accepted);
  assert.throws(() => validateArcadeGameSpec({ ...original, version: 2, asteroids: undefined }));
  const max = { width: 64, height: 64, pixels: btoa('\xff'.repeat(64 * 64 * 4)) };
  assert.ok(JSON.stringify(validateArcadeGameSpec({ ...original, sprites: { player: max, asteroid: max, enemy: max, reward: max } })).length < 100000);
});

test('sprites survive saving, reload, guided edits, duplication and publication snapshots', () => {
  const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const library = new LocalGameLibrary(storage), id = '11111111-1111-4111-8111-111111111111';
  let saved = library.create(id, 'Asteroids with endless survival.');
  saved = library.save(id, saved.revision, { ...game(), sprites: { player: sprite } });
  assert.deepEqual((new LocalGameLibrary(storage).get(id).spec as ArcadeGameSpec).sprites, { player: sprite });
  saved = library.message(id, saved.revision, '22222222-2222-4222-8222-222222222222', 'Title: Comet Patrol');
  assert.deepEqual((saved.spec as ArcadeGameSpec).sprites, { player: sprite });
  const copy = library.duplicate(id, saved.revision, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual((copy.spec as ArcadeGameSpec).sprites, { player: sprite });
  saved = library.test(id, saved.revision, ['level-1']);
  const published = library.publish(id, saved.revision);
  const changed = { ...saved.spec, sprites: { asteroid: sprite } } as ArcadeGameSpec;
  library.save(id, published.revision, changed);
  assert.deepEqual((library.get(id, true).spec as ArcadeGameSpec).sprites, (published.spec as ArcadeGameSpec).sprites);
  assert.equal(designArcadeGame('Shooting off.', changed).spec.sprites, undefined);
});

test('Asteroids enter from all four edges with inward velocity in solo and cooperative formats', () => {
  const engine = createGameEngine();
  for (const advanced of [false, true]) for (const cooperative of [false, true]) {
    const spec = game(cooperative, advanced), edges = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      spec.levels![0].seed = seed * 104729;
      if (cooperative) {
        const coop = createCooperativeEngine(), state = coop.create(spec as CooperativeGameSpec); state.running = true; state.paused = false;
        state.nextSnack = .5; state.nextHazard = 0; coop.step(state, spec as CooperativeGameSpec, [0, 0], .01);
        const rock = state.entities.find(entity => entity.kind === 'hazard')!;
        assert.ok(rock);
        if (rock.x < 0) { edges.add('left'); assert.ok(rock.vx > 0); }
        if (rock.x > 950) { edges.add('right'); assert.ok(rock.vx < 0); }
        if (rock.y < 0) { edges.add('top'); assert.ok(rock.vy > 0); }
        if (rock.y > 530) { edges.add('bottom'); assert.ok(rock.vy < 0); }
        assert.ok(validateCooperativeState(coop.snapshot(state), spec as CooperativeGameSpec));
      } else {
        const state = engine.create(spec); state.nextSnack = .5; state.nextHazard = 0; engine.step(state, spec, {}, .01);
        const rock = state.entities.find(entity => entity.kind === 'hazard')!;
        if (rock.x < 0) { edges.add('left'); assert.ok(rock.vx > 0); }
        if (rock.x > 950) { edges.add('right'); assert.ok(rock.vx < 0); }
        if (rock.y < 0) { edges.add('top'); assert.ok(rock.vy > 0); }
        if (rock.y > 530) { edges.add('bottom'); assert.ok(rock.vy < 0); }
      }
    }
    assert.deepEqual([...edges].sort(), ['bottom', 'left', 'right', 'top'], `${advanced}/${cooperative}`);
  }
});

const bullet = (id: number, owner = 0): GameBullet => ({ id, owner: owner as 0 | 1, x: 110, y: 230, vx: 0, vy: -620, ttl: 1 });
test('shots collect energy and prizes once, credit the firing ship, and respect blocking rocks', () => {
  for (const advanced of [false, true]) for (const cooperative of [false, true]) {
    const spec = game(cooperative, advanced), engine = createGameEngine(), coop = createCooperativeEngine();
    const state = cooperative ? coop.create(spec as CooperativeGameSpec) : engine.create(spec);
    if ('running' in state) { state.running = true; state.paused = false; }
    state.nextSnack = state.nextHazard = 100; state.nextId = 20;
    state.entities = [{ id: 10, kind: 'snack', x: 100, y: 200, w: 22, h: 22, vx: 0, vy: 0 }];
    state.bullets = [bullet(11, cooperative ? 1 : 0), bullet(12, cooperative ? 1 : 0)] as any;
    const tick = () => cooperative ? coop.step(state as any, spec as CooperativeGameSpec, [0, 0], .05) : engine.step(state as any, spec, {}, .05);
    tick();
    const player = cooperative ? (state as any).players[1] : state;
    assert.equal(player.score, 1); assert.equal(player.points, 10); assert.equal(state.entities.length, 0);
    if (cooperative) assert.equal((state as any).players[0].score, 0);
    state.powerUps!.pickups = [{ id: 13, type: 'shield', x: 100, y: 200, ttl: 5 }];
    state.bullets = [bullet(14, cooperative ? 1 : 0), bullet(15, cooperative ? 1 : 0)] as any;
    tick(); assert.equal(state.powerUps!.pickups.length, 0);
    assert.equal(cooperative ? player.effects.shield : (state as any).powerUps.effects.shield, 1);
    assert.equal(player.points, 10);
    state.entities = [{ id: 16, kind: 'hazard', asteroid: 'small', x: 100, y: 218, w: advanced ? 18 : 20, h: advanced ? 18 : 20, vx: 0, vy: 0 }];
    state.powerUps!.pickups = [{ id: 17, type: 'rapid-fire', x: 100, y: 170, ttl: 5 }];
    state.bullets = [{ ...bullet(18, cooperative ? 1 : 0), y: 245 }] as any;
    tick(); assert.equal(state.powerUps!.pickups.length, 1, 'a shot cannot collect a prize through a closer rock');
  }
});
