import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRoomPassphrase } from '../src/lib/room-passphrases';

test('room passphrases have predictable spoken matching and reject invisible or ambiguous input', () => {
  assert.equal(normalizeRoomPassphrase('  Purple   Comet-42  '), 'purple comet-42');
  assert.equal(normalizeRoomPassphrase('a'.repeat(48)), 'a'.repeat(48));
  for (const value of ['', 'short', '------', 'a'.repeat(49), ' '.repeat(97), 'purple\tcomet', 'purple\ncomet', 'purple\u00a0comet', 'purplé comet', 'purple/comet', '<comet>', 'purple\u202ecomet']) assert.throws(() => normalizeRoomPassphrase(value), /6–48 characters/);
});
