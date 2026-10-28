import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalGameLibrary, validateGameConfig } from '../src/lib/game-local';
import type { GameConfig } from '../src/lib/game-types';

test('old settings and separate crossword/word search selectors round trip without implied enablement', () => {
  const old: GameConfig = { version: 1, revision: 0, creationEnabled: true, assistantModeId: '' };
  assert.deepEqual(validateGameConfig(old), old);
  for (const extra of [{ wordSearchAssistantModeId: '' }, { wordSearchAssistantModeId: 'word-search-word-options' }, { crosswordAssistantModeId: 'crossword-word-options', wordSearchAssistantModeId: 'word-search-word-options' }]) {
    const config = { ...old, ...extra };
    assert.deepEqual(validateGameConfig(config), config);
  }
});

test('word search selector rejects malformed, missing and extra configuration fields', () => {
  const base: GameConfig = { version: 1, revision: 0, creationEnabled: true, assistantModeId: '' };
  for (const value of [null, undefined, true, 'https://example.invalid', 'bad mode', 'a'.repeat(65)]) assert.throws(() => validateGameConfig({ ...base, wordSearchAssistantModeId: value } as GameConfig));
  assert.throws(() => validateGameConfig({ ...base, extra: true } as unknown as GameConfig));
  const missing = { ...base }; delete (missing as Partial<GameConfig>).assistantModeId;
  assert.throws(() => validateGameConfig(missing));
});

test('local saved selectors remain unavailable and never invoke a model', () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const library = new LocalGameLibrary(storage), original = library.settings();
  assert.equal(original.wordSearchGenerator?.available, false);
  const saved = library.saveSettings({ ...original.config, wordSearchAssistantModeId: 'word-search-word-options', crosswordAssistantModeId: 'crossword-word-options' }, 0);
  assert.equal(saved.config.wordSearchAssistantModeId, 'word-search-word-options');
  assert.equal(saved.config.crosswordAssistantModeId, 'crossword-word-options');
  assert.equal(saved.wordSearchGenerator?.available, false);
  assert.match(saved.wordSearchGenerator?.reason ?? '', /no model calls/);
  assert.deepEqual(new LocalGameLibrary(storage).settings(), saved);
});
