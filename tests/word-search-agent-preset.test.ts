import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultAgentSettings, validateAgentConfig } from '../src/lib/agent-defaults';
import { addCrosswordAgentPreset, crosswordPresetIds } from '../src/lib/crossword-agent-preset';
import { addWordSearchAgentPreset, wordSearchPresetIds } from '../src/lib/word-search-agent-preset';

test('word search preset remains disabled and preserves paid authorization, audiences and budgets', () => {
  const original = defaultAgentSettings().config, snapshot = structuredClone(original), next = addWordSearchAgentPreset(original);
  assert.deepEqual(original, snapshot);
  assert.equal(next.allowPaidExecution, false);
  assert.deepEqual(next.limits, original.limits);
  const mode = next.modes.find(value => value.id === wordSearchPresetIds.mode)!;
  assert.equal(mode.enabled, false);
  assert.deepEqual(mode.audience, { allEditors: false, userIds: [] });
  const model = next.models.find(value => value.id === wordSearchPresetIds.model)!;
  assert.equal(model.target, 'amazon.nova-micro-v1:0');
  assert.equal(model.maxOutputTokens, 512);
  assert.deepEqual(validateAgentConfig(next), next);
  for (const key of ['models', 'agents', 'workflows', 'modes'] as const) assert.deepEqual(next[key].slice(0, -1), original[key]);
});

test('word search preset reuses the existing Nova Micro without changing its settings or crossword mode', () => {
  const original = addCrosswordAgentPreset(defaultAgentSettings().config), snapshot = structuredClone(original);
  original.models.find(value => value.id === crosswordPresetIds.model)!.enabled = false;
  snapshot.models.find(value => value.id === crosswordPresetIds.model)!.enabled = false;
  const next = addWordSearchAgentPreset(original);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(next.models, original.models);
  assert.equal(next.agents.find(value => value.id === wordSearchPresetIds.agent)!.modelId, crosswordPresetIds.model);
  assert.deepEqual(next.modes.slice(0, -1), original.modes);
  assert.equal(next.modes.at(-1)!.enabled, false);
});

test('word search preset refuses collisions without overwriting administrator definitions', () => {
  const config = addWordSearchAgentPreset(defaultAgentSettings().config), snapshot = structuredClone(config);
  config.models.at(-1)!.target = 'operator-selected-model';
  assert.throws(() => addWordSearchAgentPreset(config), /already in use/);
  assert.equal(config.models.at(-1)!.target, 'operator-selected-model');
  assert.deepEqual(config.agents, snapshot.agents);
});
