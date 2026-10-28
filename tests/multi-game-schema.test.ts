import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { designGame, validateGameSpec } from '../src/lib/game-design.ts';
import { defaultMultiGameSpec, validateMultiGameSpec } from '../src/lib/multi-game.ts';
import { gameReviewLevelIds } from '../src/lib/game-types.ts';
import type { ArcadeGameSpec, MultiGameSpec } from '../src/lib/game-types.ts';
import { LocalGameLibrary } from '../src/lib/game-local.ts';
import { createPlatformerSpec } from '../src/lib/game-flow.ts';

function journey(): MultiGameSpec {
  const spec = defaultMultiGameSpec();
  spec.steps.splice(1, 0, { id: 'step-4', type: 'material', title: 'A client object', kind: 'interactive', reference: 'client:objects/one', required: true });
  spec.steps.push({ id: 'step-7', type: 'game', spec: createPlatformerSpec() });
  spec.steps.push({ id: 'step-8', type: 'free-play', spec: designGame('Asteroids with endless survival.').spec as ArcadeGameSpec });
  return spec;
}

test('multi-game compositions copy bounded fixed-game snapshots and review every outer step', () => {
  const source = journey(), clean = validateGameSpec(source);
  assert.deepEqual(clean, source);
  assert.deepEqual(gameReviewLevelIds(clean), ['step-1', 'step-4', 'step-2', 'step-7', 'step-8']);
  assert.notEqual(clean, source); assert.notEqual((clean as MultiGameSpec).steps[0], source.steps[0]);
  source.steps[0].spec.title = 'A changed source';
  assert.notEqual((clean as MultiGameSpec).steps[0].spec.title, source.steps[0].spec.title);
  const updated = designGame('Title: New journey\nAdd a crossword and go to a word search.', clean).spec as MultiGameSpec;
  assert.equal(updated.title, 'New journey'); assert.equal(updated.version, 8);
  assert.deepEqual(updated.steps, (clean as MultiGameSpec).steps);
  assert.equal(designGame('Create a multi-game with a crossword and word search.').spec.version, 8);
  assert.equal(designGame('Title: Create a multi-game', createPlatformerSpec()).spec.version, 7);
  assert.deepEqual(validateMultiGameSpec(clean, value => validateGameSpec(value) as ArcadeGameSpec), clean);
});

function invalidCases(): unknown[] {
  const base = journey(), finite = defaultMultiGameSpec().steps[0];
  return [
    { ...base, extra: true }, { ...base, version: 8.1 }, { ...base, genre: 'education' },
    { ...base, title: '<script>' }, { ...base, title: ' title' }, { ...base, title: '\ud800' },
    { ...base, description: 'https://example.com' }, { ...base, steps: [] },
    { ...base, steps: [...base.steps, base.steps[0]] },
    { ...base, steps: base.steps.map(step => step.id === 'step-1' ? { ...step, id: 'step-13' } : step) },
    { ...base, steps: [{ ...finite, spec: base }] },
    { ...base, steps: [{ ...finite, type: [] }] },
    { ...base, steps: [{ ...finite, spec: { ...createPlatformerSpec(), title: '\ud800' } }] },
    { ...base, steps: [{ ...finite, gameId: 'mutable-reference' }] },
    { ...base, steps: [{ id: 'step-1', type: 'material', title: 'Only content', kind: 'content', reference: 'one', required: false }] },
    { ...base, steps: [base.steps.at(-1)] },
    { ...base, steps: [base.steps.at(-1), finite] },
    { ...base, steps: [{ ...base.steps.at(-1), type: 'game' }, finite] },
    { ...base, steps: [finite, { id: 'step-2', type: 'free-play', spec: createPlatformerSpec() }] },
    { ...base, steps: [{ ...finite, spec: designGame('Asteroids with multiplayer.').spec }] },
    { ...base, steps: Array.from({ length: 9 }, (_, index) => ({ ...finite, id: `step-${index + 1}` })) },
    { ...base, steps: Array.from({ length: 13 }, (_, index) => index === 0 ? finite : { id: `step-${index + 1}`, type: 'material', title: 'Object', kind: 'content', reference: 'one', required: false }) },
    ...['https://example.com', '//example.com', '../object', 'objects/../one', 'one?token=private', 'one#ref', 'x'.repeat(129)].map(reference => ({ ...base, steps: base.steps.map(step => step.type === 'material' ? { ...step, reference } : step) })),
    ...[{ kind: 'lesson' }, { required: 1 }, { title: 'https://example.com' }, { token: 'private' }, { type: 'html' }].map(patch => ({ ...base, steps: base.steps.map(step => step.type === 'material' ? { ...step, ...patch } : step) })),
  ];
}

test('schema rejects recursion, cooperation, live references, unsafe material and unreachable free play', () => {
  for (const value of invalidCases()) assert.throws(() => validateMultiGameSpec(value));
  const huge = defaultMultiGameSpec(), arcade = designGame('Asteroids with 1 level.').spec as ArcadeGameSpec;
  arcade.version = 6;
  arcade.asteroids = { endless: false, difficultyInterval: 30, sizes: 2, enemies: { enabled: false, difficulty: 'easy', hitPoints: 1, spawnInterval: 15, maxShips: 2 } };
  const sprite = { width: 64, height: 64, pixels: Buffer.alloc(64 * 64 * 4, 255).toString('base64') };
  arcade.sprites = { player: sprite, asteroid: sprite, reward: sprite, enemy: sprite };
  huge.steps = Array.from({ length: 3 }, (_, index) => ({ id: `step-${index + 1}`, type: 'game', spec: arcade }));
  assert.throws(() => validateMultiGameSpec(huge), /240,000 bytes/);
});

test('TypeScript and Python accept identical multi-game schemas and deterministic designers', () => {
  const cases = [defaultMultiGameSpec(), journey(), ...invalidCases()];
  const script = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('multi_games',Path.cwd()/'backend/nce_api/games.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nc=json.load(sys.stdin)\nr=[]\nfor v in c['cases']:\n try:r.append({'valid':True,'value':m.validate_spec(v)})\n except m.GameError:r.append({'valid':False})\nprint(json.dumps({'cases':r,'default':m.default_multi_game(),'new':m.design_game('Create a multi-game with a crossword and word search.'),'edit':m.design_game('Title: New journey',c['spec'])},ensure_ascii=True))`;
  const python = JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify({ cases, spec: journey() }), encoding: 'utf8' }));
  cases.forEach((value, index) => { let expected; try { expected = { valid: true, value: validateGameSpec(value) }; } catch { expected = { valid: false }; } assert.deepEqual(python.cases[index], expected, String(index)); });
  assert.deepEqual(python.default, defaultMultiGameSpec());
  assert.deepEqual(python.new, designGame('Create a multi-game with a crossword and word search.'));
  assert.deepEqual(python.edit, designGame('Title: New journey', journey()));
});

test('local publication requires every journey step and preserves copied public child games', () => {
  const values = new Map<string, string>(), id = '11111111-1111-4111-8111-111111111111';
  const library = new LocalGameLibrary({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  const created = library.create(id, 'Create a multi-game.'), saved = library.save(id, created.revision, journey());
  assert.throws(() => library.test(id, saved.revision, ['step-1', 'step-2']), /every level/);
  const tested = library.test(id, saved.revision, gameReviewLevelIds(saved.spec));
  const published = library.publish(id, tested.revision), changed = journey();
  (changed.steps[0] as { spec: { title: string } }).spec.title = 'Private draft copy';
  library.save(id, published.revision, changed);
  assert.deepEqual(library.get(id, true).spec, journey());
  assert.notDeepEqual(library.get(id).spec, journey());
});
