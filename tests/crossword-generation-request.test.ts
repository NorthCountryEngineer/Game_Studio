import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrosswordGenerationRequest } from '../src/lib/crossword-generation-request';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../src/lib/multi-game';
import type { Game } from '../src/lib/game-types';

function game(): Game { return { id: '11111111-1111-4111-8111-111111111111', spec: defaultWordGameSpec('crossword', 'space'), revision: 4, status: 'Draft', createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-28T12:00:00Z' }; }

test('a lost completed reply retains original billable request ID and revision after metadata recovery', () => {
  const requests = new CrosswordGenerationRequest(), original = game(), first = requests.get(original, []);
  const recovered = { ...original, revision: original.revision + 2, updatedAt: '2026-10-28T12:01:00Z' };
  const retry = requests.get(recovered, []);
  assert.equal(retry.requestId, first.requestId);
  assert.equal(retry.game.revision, original.revision);
  assert.deepEqual(retry, first);
  retry.game.spec.title = 'Mutated transport copy';
  assert.equal(requests.get(recovered, []).game.spec.title, original.spec.title);
  requests.clear();
  const fresh = requests.get(recovered, []);
  assert.notEqual(fresh.requestId, first.requestId);
  assert.equal(fresh.game.revision, recovered.revision);
});

test('different puzzle content, game or child target cannot reuse a previous request', () => {
  const requests = new CrosswordGenerationRequest(), original = game(), first = requests.get(original, []);
  const changed = structuredClone(original); changed.spec.description = 'A different topic.';
  assert.notEqual(requests.get(changed, []).requestId, first.requestId);
  const another = { ...original, id: '22222222-2222-4222-8222-222222222222' };
  const second = requests.get(another, []);
  assert.notEqual(second.requestId, first.requestId);
  const composed = game(); composed.spec = defaultMultiGameSpec();
  const nested = requests.get(composed, ['step-1']);
  assert.deepEqual(nested.path, ['step-1']);
  assert.notEqual(nested.requestId, second.requestId);
  assert.throws(() => requests.get(composed, ['step-2']), /crossword/);
});
