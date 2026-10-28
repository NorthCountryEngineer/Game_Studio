import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createPlatformerSpec, defaultGameFlow, reconcileGameFlow, validateGameFlow } from '../src/lib/game-flow.ts';
import { defaultGameSpec, designGame, planGameLevels, updateAsteroidSettings, validateArcadeGameSpec } from '../src/lib/game-design.ts';
import { LocalGameLibrary } from '../src/lib/game-local.ts';
import type { ArcadeGameSpec, GameFlow } from '../src/lib/game-types.ts';

function campaign(): ArcadeGameSpec {
  const spec = createPlatformerSpec();
  spec.flow = { version: 1, nodes: [
    { id: 'step-4', type: 'menu', title: 'Choose your adventure' },
    { id: 'step-2', type: 'level', levelId: 'level-2' },
    { id: 'step-5', type: 'material', title: 'Fractions practice', kind: 'lesson', reference: 'ncacademy:lessons/fractions-1', required: true },
    { id: 'step-1', type: 'level', levelId: 'level-1' },
    { id: 'step-6', type: 'material', title: 'Watch a recap', kind: 'video', reference: 'videos/recap-1', required: false },
    { id: 'step-3', type: 'level', levelId: 'level-3' },
  ] };
  return spec;
}
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

test('pixel platformer category preserves legacy games and has self-contained flow validation', () => {
  const spec = campaign();
  assert.equal(spec.version, 7); assert.equal(spec.genre, 'platformer');
  assert.deepEqual(validateArcadeGameSpec(spec), spec);
  assert.equal(designGame('A pond platformer').spec.version, 2);
  const isolated = vm.runInNewContext(`const __name = fn => fn; (${validateArcadeGameSpec.toString()})(${JSON.stringify(spec)})`);
  assert.deepEqual(plain(isolated), spec);
  const flowValidator = vm.runInNewContext(`const __name = fn => fn; (${validateGameFlow.toString()})(${JSON.stringify(spec.flow)}, ${JSON.stringify(spec.levels)})`);
  assert.deepEqual(plain(flowValidator), spec.flow);
  const without = { ...spec }; delete without.flow;
  assert.equal(defaultGameFlow(without).nodes.length, 3);
});

test('flow validation rejects executable input, ambiguous order, invalid references and missing levels', () => {
  const spec = campaign(), valid = spec.flow!;
  const invalid: unknown[] = [
    { ...valid, version: 2 }, { ...valid, extra: true }, { ...valid, nodes: [] },
    { ...valid, nodes: [...valid.nodes, valid.nodes[0]] },
    { ...valid, nodes: valid.nodes.slice(0, -1) },
    { ...valid, nodes: [valid.nodes[1], valid.nodes[0], ...valid.nodes.slice(2)] },
    { ...valid, nodes: valid.nodes.map(node => node.id === 'step-2' ? { ...node, levelId: 'level-9' } : node) },
    { ...valid, nodes: valid.nodes.map(node => node.id === 'step-2' ? { ...node, levelId: 'level-1' } : node) },
    ...['https://example.com', '//example.com', '../lesson', 'course/../lesson', 'lesson?token=secret', 'lesson#x', 'x'.repeat(129)].map(reference => ({ ...valid, nodes: valid.nodes.map(node => node.type === 'material' ? { ...node, reference } : node) })),
    ...[true, '<script>', 'https://example.com', ' x', 'x'.repeat(81)].map(title => ({ ...valid, nodes: valid.nodes.map(node => node.type === 'material' ? { ...node, title } : node) })),
    { ...valid, nodes: valid.nodes.map(node => node.type === 'material' ? { ...node, required: 'true' } : node) },
    { ...valid, nodes: valid.nodes.map(node => node.type === 'material' ? { ...node, kind: 'html' } : node) },
  ];
  for (const flow of invalid) {
    assert.throws(() => validateGameFlow(flow, spec.levels!), JSON.stringify(flow));
    assert.throws(() => validateArcadeGameSpec({ ...spec, flow }), JSON.stringify(flow));
  }
  for (const candidate of [
    { ...spec, genre: 'collect' }, { ...spec, arcade: { rotation: false, shooting: false, splitAsteroids: false, scoring: false, highScores: false } },
    { ...spec, multiplayer: { mode: 'cooperative', maxPlayers: 2 } }, { ...spec, powerUps: { spawnInterval: 10, duration: 5, types: ['shield'] } },
    { ...defaultGameSpec(), flow: valid },
  ]) assert.throws(() => validateArcadeGameSpec(candidate));
  const asteroid = designGame('Asteroids with 3 levels and endless survival.').spec;
  assert.throws(() => validateArcadeGameSpec({ ...asteroid, flow: valid }));
});

test('guided edits and level count changes retain creator materials, IDs and gates', () => {
  const spec = campaign(), original = structuredClone(spec);
  for (const message of ['Title: A new title', 'Make level 2 harder.', 'Shuffle layouts.', 'Collect 15.']) {
    const result = designGame(message, spec).spec as ArcadeGameSpec;
    assert.equal(result.version, 7); assert.deepEqual(result.flow, spec.flow);
  }
  const grown = planGameLevels(spec, 4, 'synthetic plan');
  assert.deepEqual(grown.flow!.nodes.slice(0, -1), spec.flow!.nodes);
  assert.equal(grown.flow!.nodes.at(-1)!.type, 'level');
  const reduced = planGameLevels(spec, 2, 'synthetic plan');
  assert.deepEqual(reduced.flow!.nodes, spec.flow!.nodes.filter(node => node.type !== 'level' || node.levelId !== 'level-3'));
  assert.deepEqual(spec, original);
  assert.throws(() => designGame('Add multiplayer.', spec), /solo/);
  const asteroid = designGame('Asteroids with 3 levels.').spec as ArcadeGameSpec;
  asteroid.flow = defaultGameFlow(asteroid);
  assert.throws(() => updateAsteroidSettings(asteroid, { endless: true }), /Remove the level flow/);
  const full: GameFlow = { version: 1, nodes: [
    { id: 'step-1', type: 'level', levelId: 'level-1' },
    ...Array.from({ length: 23 }, (_, index) => ({ id: `step-${index + 2}`, type: 'material' as const, title: 'Practice', kind: 'exercise' as const, reference: `exercise-${index + 1}`, required: true })),
  ] };
  assert.throws(() => reconcileGameFlow(full, [{ id: 'level-1' }, { id: 'level-2' }]), /flow is full/);
});

test('browser and Python validators and designers agree for flows and pixel platformers', () => {
  const spec = campaign();
  const cases: unknown[] = [spec, createPlatformerSpec(), { ...spec, version: 2 },
    ...['https://x.example', 'course/../lesson', 'ncacademy:lesson/one', 'videos/one'].map(reference => ({ ...spec, flow: { ...spec.flow, nodes: spec.flow!.nodes.map(node => node.type === 'material' ? { ...node, reference } : node) } })),
    { ...spec, flow: { ...spec.flow, nodes: spec.flow!.nodes.slice(1) } },
    { ...spec, flow: { ...spec.flow, nodes: spec.flow!.nodes.slice(0, -1) } },
  ];
  const script = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('flow_games',Path.cwd()/'backend/nce_api/games.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=[]\nfor value in json.load(sys.stdin):\n try: r.append({'valid':True,'value':m.validate_spec(value)})\n except m.GameError: r.append({'valid':False})\nprint(json.dumps(r,ensure_ascii=False))`;
  const python = JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify(cases), encoding: 'utf8' }));
  cases.forEach((value, index) => { let expected; try { expected = { valid: true, value: validateArcadeGameSpec(value) }; } catch { expected = { valid: false }; } assert.deepEqual(python[index], expected); });
  const edits = ['Title: New journey', 'Make level 2 harder.', '4 levels', '2 levels', 'Shuffle layouts.', 'Collect 15.'];
  const planScript = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('flow_games',Path.cwd()/'backend/nce_api/games.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nc=json.load(sys.stdin)\nprint(json.dumps({'starter':m.create_platformer_spec(),'edits':[m.design_game(message,c['spec']) for message in c['edits']]},ensure_ascii=False))`;
  const plans = JSON.parse(execFileSync('python3', ['-c', planScript], { input: JSON.stringify({ spec, edits }), encoding: 'utf8' }));
  assert.deepEqual(plans.starter, createPlatformerSpec());
  edits.forEach((message, index) => assert.deepEqual(plans.edits[index], designGame(message, spec)));
});

test('local publication requires all saved levels and isolates the material flow snapshot', () => {
  const values = new Map<string, string>(), id = '11111111-1111-4111-8111-111111111111';
  const library = new LocalGameLibrary({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  const draft = library.create(id, 'A three level platformer'), saved = library.save(id, draft.revision, campaign());
  assert.throws(() => library.test(id, saved.revision, ['level-1']), /every level/);
  const reviewed = library.test(id, saved.revision, ['level-2', 'level-1', 'level-3']);
  const published = library.publish(id, reviewed.revision), changed = campaign();
  changed.flow!.nodes.find(node => node.type === 'material')!.title = 'New private lesson';
  library.save(id, published.revision, changed);
  assert.deepEqual(library.get(id, true).spec.flow, campaign().flow);
  assert.notDeepEqual(library.get(id).spec.flow, campaign().flow);
});
