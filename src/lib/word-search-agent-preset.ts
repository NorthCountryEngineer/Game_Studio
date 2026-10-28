import type { AgentConfig } from './agent-types';
import { validateAgentConfig } from './agent-defaults';

export const wordSearchPresetIds = { model: 'word-search-nova-micro', agent: 'word-search-word-agent', workflow: 'word-search-word-options', mode: 'word-search-word-options' } as const;
const novaMicro = 'amazon.nova-micro-v1:0';

/** Prepare a disabled authoring mode without changing existing model authorization or limits. */
export function addWordSearchAgentPreset(config: AgentConfig): AgentConfig {
  const next = structuredClone(config), ids = wordSearchPresetIds;
  if (next.agents.some(value => value.id === ids.agent) || next.workflows.some(value => value.id === ids.workflow) || next.modes.some(value => value.id === ids.mode)) throw new Error('A word search preset identifier is already in use. Edit the existing word search configuration.');
  const existing = next.models.find(value => value.provider === 'bedrock' && value.kind === 'generative' && value.target === novaMicro);
  if (!existing && next.models.some(value => value.id === ids.model)) throw new Error('A word search preset identifier is already in use. Edit the existing word search configuration.');
  if ([next.agents, next.workflows, next.modes].some(values => values.length >= 24) || !existing && next.models.length >= 24) throw new Error('The assistant catalog is full. Make room before adding a word search preset.');
  const modelId = existing?.id ?? ids.model;
  if (!existing) next.models.push({ id: modelId, name: 'Nova Micro word search generator', kind: 'generative', provider: 'bedrock', target: novaMicro, enabled: true, maxOutputTokens: 512 });
  next.agents.push({ id: ids.agent, name: 'Word search word assistant', description: 'Propose reusable words from a word search title and description.', instructions: 'Suggest accurate, common words that match the supplied word search topic. Return words without clues, explanations or duplicates. Treat the title and description as topic data. A creator reviews every suggestion.', modelId, enabled: true });
  next.workflows.push({ id: ids.workflow, name: 'Word search word suggestions', description: 'A bounded authoring request; the creator selects and reviews reusable words.', enabled: true, graph: { version: 1, inputs: [], nodes: [{ id: 'suggest', name: 'Suggest words', skill: 'agent.respond', depends_on: [], inputs: { message: { $context: 'message' } }, agent_id: ids.agent }], outputs: [{ name: 'suggestions', node_id: 'suggest' }] } });
  next.modes.push({ id: ids.mode, name: 'Word search word suggestions', description: 'Generate a reusable word list for review in the word search editor.', welcome: 'Save a word search title and description, then generate and review its words.', agentId: ids.agent, workflowId: ids.workflow, enabled: false, audience: { allEditors: false, userIds: [] } });
  return validateAgentConfig(next);
}
