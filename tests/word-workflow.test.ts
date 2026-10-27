import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalGameLibrary } from '../src/lib/game-local.ts';
import type { WordGenre } from '../src/lib/game-types.ts';
import { validateGameSpec } from '../src/lib/game-design.ts';

function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  return { values, games: new LocalGameLibrary(storage) };
}
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

for (const genre of ['crossword', 'word-search', 'mad-libs'] as WordGenre[]) test(`${genre}: saved review, private edits and public snapshots retain their boundaries`, () => {
  const { games } = fixture();
  const prompt = `Create a ${genre.replaceAll('-', ' ')} game about nature.`;
  const created = games.create(first, prompt);
  assert.equal(created.spec.version, 3); assert.equal(created.spec.genre, genre);
  assert.deepEqual(games.create(first, prompt), created);
  assert.throws(() => games.test(first, created.revision), /review|level/i);
  assert.throws(() => games.test(first, created.revision, ['level-2']), /review|level/i);
  assert.throws(() => games.test(first, created.revision, ['level-1', 'level-1']), /review|level/i);
  assert.throws(() => games.publish(first, created.revision), /playtest/i);
  const reviewed = games.test(first, created.revision, ['level-1']);
  const published = games.publish(first, reviewed.revision);
  const snapshot = games.get(first, true);
  assert.equal(snapshot.spec.genre, genre); assert.equal(snapshot.messages, undefined); assert.equal(snapshot.testedRevision, undefined);
  const edited = games.save(first, published.revision, { ...published.spec, title: 'Private revised title' });
  assert.equal(edited.testedRevision, undefined);
  assert.deepEqual(games.get(first, true), snapshot);
  assert.throws(() => games.publish(first, edited.revision), /playtest/i);
  assert.throws(() => games.test(first, reviewed.revision, ['level-1']), /another window/i);
  const copy = games.duplicate(first, edited.revision, second);
  assert.equal(copy.spec.genre, genre); assert.equal(copy.status, 'Draft'); assert.equal(copy.testedRevision, undefined); assert.equal(copy.publishedRevision, undefined);
  assert.throws(() => games.get(second, true), /not published/i);
  const tested = games.test(first, edited.revision, ['level-1']);
  const republished = games.publish(first, tested.revision);
  assert.equal(games.get(first, true).spec.title, 'Private revised title');
  assert.ok(republished.publishedRevision! > snapshot.publishedRevision!);
});

test('pausing creation leaves published word games playable and preserves existing arcade drafts', () => {
  const { games, values } = fixture();
  values.set('unrelated-content', 'preserve');
  const arcade = games.create(second, 'A pond collection game with three levels.');
  const puzzle = games.create(first, 'A crossword about nature.');
  const reviewed = games.test(first, puzzle.revision, ['level-1']);
  games.publish(first, reviewed.revision);
  const snapshot = games.get(first, true);
  const settings = games.settings().config;
  games.saveSettings({ ...settings, creationEnabled: false }, settings.revision);
  assert.deepEqual(games.get(first, true), snapshot);
  assert.deepEqual(games.get(second), arcade);
  assert.equal(values.get('unrelated-content'), 'preserve');
  assert.throws(() => games.message(first, snapshot.revision, '33333333-3333-4333-8333-333333333333', 'Title: changed'), /paused/i);
});

test('duplicated puzzle titles preserve whole Unicode characters and trim a cut-off space', () => {
  for (const title of ['🦎'.repeat(40), `${'A'.repeat(71)} end`]) {
    const { games } = fixture();
    const created = games.create(first, 'Mad Libs about nature.');
    const saved = games.save(first, created.revision, { ...created.spec, title });
    const copied = games.duplicate(first, saved.revision, second);
    assert.deepEqual(validateGameSpec(copied.spec), copied.spec);
    assert.ok(copied.spec.title.startsWith('Copy of '));
    assert.ok(copied.spec.title.length <= 80);
    assert.equal(copied.spec.title, copied.spec.title.trim());
  }
});
