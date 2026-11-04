import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { defaultGameSpec, planGameLevels, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { createCooperativeEngine, validateCooperativeState, type CooperativeState } from '../src/lib/game-cooperative.ts';
import { validateVersusMatch, type VersusMatch } from '../src/lib/game-versus.ts';
import type { ArcadeGameSpec } from '../src/lib/game-types.ts';

const match: VersusMatch = { mode: 'versus', lives: 3, timeLimit: 120 };
const python = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('versus_parity',Path.cwd()/'backend/nce_api/multiplayer.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nresults=[]\nfor c in json.load(sys.stdin):\n try:\n  if c['kind']=='match':m.validate_match(c['value'])\n  else:m.validate_state(c['state'],c['spec'],c.get('match'))\n  results.append(True)\n except m.MultiplayerError:results.append(False)\nprint(json.dumps(results))`;

function game(version: 1 | 2 | 4 | 5 | 6): ArcadeGameSpec {
  const base = { ...defaultGameSpec(), genre: 'dodge' as const, arcade: { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true } };
  if (version === 1) return validateArcadeGameSpec(base);
  const planned = planGameLevels(base, 2, 'Versus schema parity');
  return validateArcadeGameSpec({ ...planned, version,
    ...(version === 4 ? { multiplayer: { mode: 'cooperative', maxPlayers: 2 } } : {}),
    ...(version === 5 ? { powerUps: { spawnInterval: 10, duration: 15, types: ['shield', 'triple-shot'] } } : {}),
    ...(version === 6 ? { asteroids: { endless: true, difficultyInterval: 30, sizes: 3, enemies: { enabled: false, difficulty: 'easy', hitPoints: 1, spawnInterval: 15, maxShips: 2 } } } : {}),
  });
}

test('room match settings have identical strict browser and relay validation', () => {
  const values = [match, { mode: 'versus', lives: 1, timeLimit: 30 }, { mode: 'versus', lives: 5, timeLimit: 180 },
    null, [], {}, { ...match, mode: 'cooperative' }, { ...match, lives: false }, { ...match, lives: 0 }, { ...match, lives: 6 },
    { ...match, lives: 2.5 }, { ...match, timeLimit: 29 }, { ...match, timeLimit: 181 }, { ...match, timeLimit: 120.5 },
    { ...match, timeLimit: true }, { ...match, timeLimit: null }, { ...match, unknown: 'ignored?' }];
  const cases = values.map(value => ({ kind: 'match', value }));
  const browser = values.map(value => Boolean(validateVersusMatch(value)));
  assert.deepEqual(browser, values.map((_, index) => index < 3));
  const relay = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify(cases), encoding: 'utf8' }));
  assert.deepEqual(relay, browser);
});

test('all supported Asteroids formats share relay/browser versus state and terminal-result fences', () => {
  const cases: { kind: 'state'; spec: ArcadeGameSpec; match?: VersusMatch; state: unknown; valid: boolean }[] = [];
  const engine = createCooperativeEngine();
  for (const version of [1, 2, 4, 5, 6] as const) {
    const spec = game(version), initial = engine.create(spec, 0, match);
    const add = (state: unknown, valid: boolean, roomMatch: VersusMatch | undefined = match) => cases.push({ kind: 'state', spec, match: roomMatch, state, valid });
    add(initial, true);
    for (const [lives, elapsed, winner, reason] of [
      [[3, 0], 10, 0, 'elimination'], [[0, 1], 40, 1, 'elimination'], [[0, 0], 120, 'draw', 'elimination'],
      [[3, 2], 120, 0, 'time'], [[1, 2], 120, 1, 'time'], [[2, 2], 120, 'draw', 'time'],
    ] as const) {
      const state: CooperativeState = structuredClone(initial);
      state.elapsed = elapsed; state.players[0].lives = lives[0]; state.players[1].lives = lives[1];
      state.running = false; state.paused = false; state.outcome = 'finished'; state.versus = { winner, reason };
      add(state, true);
      add({ ...state, running: true }, false); add({ ...state, paused: true }, false);
      add({ ...state, versus: { winner: winner === 0 ? 1 : 0, reason } }, false);
      add({ ...state, versus: { winner, reason: reason === 'time' ? 'elimination' : 'time' } }, false);
    }
    for (const patch of [{ outcome: 'won' }, { outcome: 'lost' }, { levelIndex: 1 }, { elapsed: 120 }, { elapsed: 121 },
      { versus: { winner: false, reason: null } }, { versus: { winner: null, reason: [] } },
      { versus: { winner: null, reason: null, extra: true } }, { match }, { versus: undefined }]) add({ ...initial, ...patch }, false);
    const overLives = structuredClone(initial); overLives.players[0].lives = 4; add(overLives, false);
    const boolLives = structuredClone(initial) as any; boolLives.players[0].lives = true; add(boolLives, false);
    const eliminated = structuredClone(initial); eliminated.players[0].lives = 0; add(eliminated, false);
    const early = structuredClone(initial); early.elapsed = 119; early.outcome = 'finished'; early.paused = false; early.versus = { winner: 'draw', reason: 'time' }; add(early, false);
    // Match configuration is immutable room context, not accepted from a host snapshot.
    cases.push({ kind: 'state', spec, state: initial, valid: false });
  }
  const arena = game(2), state = engine.create(arena, 0, match);
  const noShooting = validateArcadeGameSpec({ ...arena, arcade: { ...arena.arcade!, shooting: false, splitAsteroids: false } });
  const flow = validateArcadeGameSpec({ ...arena, flow: { version: 1, nodes: arena.levels!.map((level, index) => ({ id: `step-${index + 1}`, type: 'level', levelId: level.id })) } });
  for (const spec of [defaultGameSpec(), noShooting, flow]) cases.push({ kind: 'state', spec, match, state, valid: false });
  const browser = cases.map(c => Boolean(validateCooperativeState(c.state, c.spec, c.match)));
  assert.deepEqual(browser, cases.map(c => c.valid));
  const relay = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify(cases), encoding: 'utf8' }));
  assert.deepEqual(relay, browser);
});
