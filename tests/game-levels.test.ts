import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalGameLibrary } from '../src/lib/game-local.ts';
import { defaultGameSpec, getGameLevels } from '../src/lib/game-design.ts';

const id = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222', request = '33333333-3333-4333-8333-333333333333';
function library() {
  const values = new Map<string, string>();
  return { games: new LocalGameLibrary({ getItem: name => values.get(name) || null, setItem: (name, value) => { values.set(name, value); } }), values };
}
const ids = (game: ReturnType<LocalGameLibrary['get']>) => getGameLevels(game.spec).map(level => level.id);

test('new drafts contain a level plan and must acknowledge every level before publication', () => {
  const { games } = library(), draft = games.create(id, 'A gentle pond adventure with 4 levels.');
  assert.equal(draft.spec.version, 2); assert.equal(draft.spec.levels?.length, 4);
  for (const invalid of [undefined, [], ids(draft).slice(1), [...ids(draft), 'level-8'], ids(draft).map(() => 'level-1')]) {
    assert.throws(() => games.test(id, draft.revision, invalid), /every level/);
    assert.equal(games.get(id).revision, draft.revision);
    assert.equal(games.get(id).testedRevision, undefined);
  }
  const tested = games.test(id, draft.revision, ids(draft).reverse());
  assert.equal(tested.testedRevision, tested.revision);
  assert.equal(games.publish(id, tested.revision).status, 'Published');
});

test('layout variations are private and invalidate review without changing the published level seeds', () => {
  const { games } = library(), draft = games.create(id, 'A pond game with 3 levels.');
  const live = games.publish(id, games.test(id, draft.revision, ids(draft)).revision), original = games.get(id, true);
  const changed = structuredClone(live.spec);
  changed.levels![1].seed = changed.levels![1].seed % 2147483647 + 1;
  const saved = games.save(id, live.revision, changed);
  assert.equal(saved.testedRevision, undefined); assert.equal(saved.status, 'Draft');
  assert.notEqual(saved.spec.levels![1].seed, original.spec.levels![1].seed);
  assert.deepEqual(games.get(id, true), original);
  assert.throws(() => games.publish(id, saved.revision), /playtest/);
  const copy = games.duplicate(id, saved.revision, second);
  assert.deepEqual(copy.spec.levels, saved.spec.levels); assert.equal(copy.testedRevision, undefined);
});

test('conversation replans invalidate the saved review and require the updated level set', () => {
  const { games } = library(), draft = games.create(id, 'A pond game with 2 levels.'), reviewed = games.test(id, draft.revision, ids(draft));
  const changed = games.message(id, reviewed.revision, request, 'Make 4 levels.');
  assert.equal(changed.spec.levels?.length, 4); assert.equal(changed.testedRevision, undefined);
  assert.throws(() => games.test(id, changed.revision, ids(draft)), /every level/);
  assert.throws(() => games.test(id, reviewed.revision, ids(changed)), /another window/);
  const tested = games.test(id, changed.revision, ids(changed)); assert.equal(tested.testedRevision, tested.revision);
});

test('deployed legacy single-level drafts retain the original acknowledgment and can upgrade explicitly', () => {
  const { games } = library(), draft = games.create(id, 'A pond game.');
  const legacy = games.save(id, draft.revision, defaultGameSpec());
  assert.equal(legacy.spec.version, 1);
  const tested = games.test(id, legacy.revision); assert.equal(tested.testedRevision, tested.revision);
  const upgraded = games.message(id, tested.revision, request, 'Add 3 levels.');
  assert.equal(upgraded.spec.version, 2); assert.equal(upgraded.spec.levels?.length, 3);
  assert.throws(() => games.test(id, upgraded.revision), /every level/);
});

test('reordered levels require the exact unique level IDs, regardless of campaign order', () => {
  const { games } = library(), draft = games.create(id, 'A garden platformer with 3 levels.');
  const reordered = games.save(id, draft.revision, { ...draft.spec, levels: [...draft.spec.levels!].reverse() });
  assert.deepEqual(ids(reordered), [...ids(draft)].reverse());
  const tested = games.test(id, reordered.revision, ids(draft));
  assert.equal(games.publish(id, tested.revision).status, 'Published');
  assert.deepEqual(ids(games.get(id, true)), ids(reordered));
});
