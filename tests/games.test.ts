import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalGameLibrary, validateGameConfig } from '../src/lib/game-local.ts';
import { defaultGameSpec, getGameLevels } from '../src/lib/game-design.ts';

function review(games: LocalGameLibrary, id: string, revision: number) { return games.test(id, revision, getGameLevels(games.get(id).spec).map(level => level.id)); }

const id = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333';
function library() {
  const values = new Map<string, string>();
  return { games: new LocalGameLibrary({ getItem: name => values.get(name) || null, setItem: (name, value) => { values.set(name, value); } }), values };
}

test('games remain private until a completed-test receipt is saved and publication requested', () => {
  const { games } = library(), draft = games.create(id, 'An axolotl collecting stars in a pond.');
  assert.equal(draft.revision, 0); assert.equal(draft.status, 'Draft'); assert.equal(games.list(true).length, 0);
  assert.throws(() => games.get(id, true), /not published/);
  assert.throws(() => games.publish(id, 0), /playtest/);
  const tested = review(games, id, 0); assert.equal(tested.testedRevision, tested.revision);
  const live = games.publish(id, tested.revision);
  assert.equal(live.status, 'Published'); assert.equal(live.publishedRevision, live.revision);
  const publicGame = games.get(id, true); assert.equal(publicGame.spec.title, draft.spec.title);
  assert.equal(publicGame.messages, undefined); assert.equal(publicGame.testedRevision, undefined);
  assert.deepEqual(Object.keys(publicGame).sort(), ['id', 'spec', 'revision', 'status', 'createdAt', 'updatedAt', 'publishedAt', 'publishedRevision'].sort());
});

test('editing a published game invalidates the test and leaves its live snapshot unchanged', () => {
  const { games } = library(), draft = games.create(id, 'Collect stars in a pond.');
  const live = games.publish(id, review(games, id, draft.revision).revision), original = games.get(id, true);
  const saved = games.save(id, live.revision, { ...live.spec, title: 'A new private title' });
  assert.equal(saved.status, 'Draft'); assert.equal(saved.testedRevision, undefined);
  assert.equal(games.get(id, true).spec.title, original.spec.title);
  assert.throws(() => games.publish(id, saved.revision), /playtest/);
  const tested = review(games, id, saved.revision); games.publish(id, tested.revision);
  assert.equal(games.get(id, true).spec.title, 'A new private title');
});

test('the creation switch stops writes and publishing while retaining play and cleanup', () => {
  const { games } = library(), first = games.create(id, 'A space dodging game.'), tested = review(games, id, first.revision), live = games.publish(id, tested.revision);
  const before = games.settings(); games.saveSettings({ ...before.config, creationEnabled: false }, before.config.revision);
  assert.throws(() => games.create(second, 'New game'), /paused/);
  assert.throws(() => games.save(id, live.revision, live.spec), /paused/);
  assert.throws(() => games.message(id, live.revision, requestId, 'Make it harder'), /paused/);
  assert.throws(() => games.duplicate(id, live.revision, second), /paused/);
  assert.throws(() => games.publish(id, live.revision), /paused/);
  assert.equal(games.get(id, true).id, id); assert.equal(games.list(true).length, 1);
  const retested = review(games, id, live.revision), removed = games.unpublish(id, retested.revision);
  assert.equal(games.list(true).length, 0); games.delete(id, removed.revision); assert.equal(games.list().length, 0);
});

test('messages are idempotent, revisions reject stale windows, and duplicates start private', () => {
  const { games } = library(), first = games.create(id, 'Collect stars in a pond.');
  assert.equal(games.create(id, 'Collect stars in a pond.').revision, first.revision);
  assert.throws(() => games.create(id, 'A different idea'), /another idea/);
  const changed = games.message(id, first.revision, requestId, 'Make it a garden game.');
  const retry = games.message(id, first.revision, requestId, 'Make it a garden game.');
  assert.deepEqual(retry, changed); assert.equal(changed.messages?.length, 4);
  assert.equal(changed.spec.theme, 'garden');
  assert.throws(() => games.message(id, changed.revision, requestId, 'A changed request'), /different message/);
  assert.throws(() => games.save(id, first.revision, first.spec), /another window/);
  assert.throws(() => review(games, id, first.revision), /another window/);
  assert.throws(() => games.delete(id, first.revision), /another window/);
  const tested = review(games, id, changed.revision), published = games.publish(id, tested.revision), duplicate = games.duplicate(id, published.revision, second);
  assert.equal(duplicate.id, second); assert.equal(duplicate.status, 'Draft'); assert.equal(duplicate.revision, 0);
  assert.equal(duplicate.testedRevision, undefined); assert.equal(duplicate.publishedRevision, undefined); assert.equal(duplicate.messages?.length, 0);
  duplicate.spec.title = 'Changed outside storage'; assert.notEqual(games.get(second).spec.title, duplicate.spec.title);
});

test('deletion removes draft and public copy and a stale create cannot resurrect a deleted identifier', () => {
  const { games } = library(), first = games.create(id, 'A pond collector.'), live = games.publish(id, review(games, id, first.revision).revision);
  games.delete(id, live.revision); assert.equal(games.list().length, 0); assert.equal(games.list(true).length, 0);
  assert.throws(() => games.get(id), /could not be found/); assert.throws(() => games.create(id, 'A pond collector.'), /deleted/);
  const secondGame = games.create(second, 'Another pond');
  assert.throws(() => games.duplicate(second, secondGame.revision, id), /already exists/);
});

test('game settings use optimistic concurrency and reject malformed or unexpected controls', () => {
  const { games } = library(), config = games.settings().config;
  games.saveSettings({ ...config, creationEnabled: false }, 0);
  assert.throws(() => games.saveSettings(config, 0), /changed/);
  assert.throws(() => games.saveSettings({ ...config, revision: 8 }, 1), /changed/);
  assert.throws(() => games.saveSettings({ ...config, revision: 1 }, Number.NaN), /changed/);
  assert.throws(() => validateGameConfig({ ...config, surprise: true } as typeof config), /valid game creation settings/);
  assert.throws(() => validateGameConfig({ ...config, assistantModeId: 'https://example.com/' }), /valid game creation settings/);
});

test('invalid storage and unsafe game specs fail without clobbering other newsroom data', () => {
  const { games, values } = library(); values.set('unrelated-posts', 'keep me');
  const first = games.create(id, 'Collect stars');
  assert.throws(() => games.save(id, first.revision, { ...defaultGameSpec(), scripts: 'alert(1)' } as ReturnType<typeof defaultGameSpec>), /unexpected|only|fields|supported/i);
  assert.throws(() => games.create(second, 'x'.repeat(2001)), /2,000/);
  values.set('game-studio-games:v1', '{'); assert.throws(() => games.list(), /could not be read/);
  assert.equal(values.get('unrelated-posts'), 'keep me'); assert.equal(values.get('game-studio-games:v1'), '{');
});
