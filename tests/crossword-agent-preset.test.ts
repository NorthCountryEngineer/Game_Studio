import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultAgentSettings, validateAgentConfig } from '../src/lib/agent-defaults';
import { addCrosswordAgentPreset, crosswordPresetIds } from '../src/lib/crossword-agent-preset';

test('crossword preset is valid and adds no paid authorization, audience or budget grants', () => {
  const original = defaultAgentSettings().config, snapshot = structuredClone(original), next = addCrosswordAgentPreset(original);
  assert.deepEqual(original, snapshot);
  assert.equal(next.allowPaidExecution, false);
  assert.deepEqual(next.limits, original.limits);
  const mode = next.modes.find(value => value.id === crosswordPresetIds.mode)!;
  assert.equal(mode.enabled, false);
  assert.deepEqual(mode.audience, { allEditors: false, userIds: [] });
  const model = next.models.find(value => value.id === crosswordPresetIds.model)!;
  assert.equal(model.target, 'amazon.nova-micro-v1:0');
  assert.equal(model.maxOutputTokens, 1200);
  assert.deepEqual(validateAgentConfig(next), next);
  for (const key of ['models', 'agents', 'workflows', 'modes'] as const) assert.deepEqual(next[key].slice(0, -1), original[key]);
});

test('crossword preset refuses collisions instead of overwriting administrator definitions', () => {
  const config = addCrosswordAgentPreset(defaultAgentSettings().config), snapshot = structuredClone(config);
  config.models.at(-1)!.target = 'operator-selected-model';
  assert.throws(() => addCrosswordAgentPreset(config), /already in use/);
  assert.equal(config.models.at(-1)!.target, 'operator-selected-model');
  assert.deepEqual(config.agents, snapshot.agents);
});
