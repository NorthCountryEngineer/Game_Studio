import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordSearchGenerationRequest } from '../src/lib/word-search-generation-request';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../src/lib/multi-game';
import type { Game, WordSearchSpec } from '../src/lib/game-types';

function game(): Game { return { id: '11111111-1111-4111-8111-111111111111', spec: defaultWordGameSpec('word-search', 'space'), revision: 4, status: 'Draft', createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-28T12:00:00Z' }; }

test('lost word-search replies retain original request ID and revision through metadata-only recovery', () => {
  const requests = new WordSearchGenerationRequest(), original = game(), first = requests.get(original, []);
  const recovered = { ...original, revision: original.revision + 2, operationState: 'uncertain' as const, updatedAt: '2026-10-28T12:01:00Z' };
  const retry = requests.get(recovered, []);
  assert.deepEqual(retry, first); assert.equal(retry.game.revision, original.revision);
  retry.game.spec.title = 'Mutated transport copy'; retry.path.push('step-1');
  assert.deepEqual(requests.get(recovered, []), first);
  requests.clear();
  const fresh = requests.get(recovered, []);
  assert.notEqual(fresh.requestId, first.requestId); assert.equal(fresh.game.revision, recovered.revision);
});

test('changed words, grid size, direction, seed, topic, game and child target cannot reuse a pending request', () => {
  const original = game();
  for (const change of [
    (draft: Game) => { draft.spec.description = 'A changed topic.'; },
    (draft: Game) => { draft.spec.title = 'Changed title'; },
    (draft: Game) => { (draft.spec as WordSearchSpec).puzzle.seed += 1; },
    (draft: Game) => { (draft.spec as WordSearchSpec).puzzle.size += 1; },
    (draft: Game) => { (draft.spec as WordSearchSpec).puzzle.allowBackwards = true; },
    (draft: Game) => { (draft.spec as WordSearchSpec).puzzle.words = ['RAIN', 'TREE', 'EARTH']; },
    (draft: Game) => { draft.id = '22222222-2222-4222-8222-222222222222'; },
  ]) {
    const requests = new WordSearchGenerationRequest(), first = requests.get(original, []), changed = structuredClone(original); change(changed);
    assert.notEqual(requests.get(changed, []).requestId, first.requestId);
  }
  const requests = new WordSearchGenerationRequest(), composed = game(); composed.spec = defaultMultiGameSpec();
  const nested = requests.get(composed, ['step-2']); assert.deepEqual(nested.path, ['step-2']);
  const changedSibling = structuredClone(composed);
  if (changedSibling.spec.version === 8 && changedSibling.spec.steps[0].type === 'game') changedSibling.spec.steps[0].spec.title = 'Changed sibling';
  assert.notEqual(requests.get(changedSibling, ['step-2']).requestId, nested.requestId);
  if (composed.spec.version === 8) composed.spec.steps[0] = { id: 'step-1', type: 'game', spec: defaultWordGameSpec('word-search', 'nature') };
  const firstChild = requests.get(composed, ['step-1']), secondChild = requests.get(composed, ['step-2']);
  assert.notEqual(firstChild.requestId, secondChild.requestId);
  assert.throws(() => requests.get(composed, []), /word search/);
});

test('unsupported crossword or deeper nested targets fail without discarding an existing request', () => {
  const requests = new WordSearchGenerationRequest(), original = game(), first = requests.get(original, []);
  const wrong = { ...original, spec: defaultWordGameSpec('crossword') };
  assert.throws(() => requests.get(wrong, []), /word search/);
  assert.throws(() => requests.get(original, ['step-1', 'step-2']), /word search/);
  assert.deepEqual(requests.get(original, []), first);
});
