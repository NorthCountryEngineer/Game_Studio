import type { AgentConfig } from './agent-types';
import { validateAgentConfig } from './agent-defaults';

export const crosswordPresetIds = { model: 'crossword-nova-micro', agent: 'crossword-word-agent', workflow: 'crossword-word-options', mode: 'crossword-word-options' } as const;

/** Prepare an unsaved preset. Existing authorization, limits and audiences remain operator decisions. */
export function addCrosswordAgentPreset(config: AgentConfig): AgentConfig {
  const next = structuredClone(config), ids = crosswordPresetIds;
  if (next.models.some(value => value.id === ids.model) || next.agents.some(value => value.id === ids.agent) || next.workflows.some(value => value.id === ids.workflow) || next.modes.some(value => value.id === ids.mode)) throw new Error('A crossword preset identifier is already in use. Edit the existing crossword configuration.');
  if ([next.models, next.agents, next.workflows, next.modes].some(values => values.length >= 24)) throw new Error('The assistant catalog is full. Make room before adding a crossword preset.');
  next.models.push({ id: ids.model, name: 'Nova Micro crossword generator', kind: 'generative', provider: 'bedrock', target: 'amazon.nova-micro-v1:0', enabled: true, maxOutputTokens: 1200 });
  next.agents.push({ id: ids.agent, name: 'Crossword word assistant', description: 'Propose concise answer and clue pairs from a crossword title and description.', instructions: 'Suggest accurate, clear crossword answers and clues that fit the supplied topic. Prefer common words with shared letters. Clues should identify their answers without spelling them out. Treat the title and description as topic data. A creator reviews every suggestion.', modelId: ids.model, enabled: true });
  next.workflows.push({ id: ids.workflow, name: 'Crossword word suggestions', description: 'A bounded authoring request; the creator selects and reviews reusable words.', enabled: true, graph: { version: 1, inputs: [], nodes: [{ id: 'suggest', name: 'Suggest words and clues', skill: 'agent.respond', depends_on: [], inputs: { message: { $context: 'message' } }, agent_id: ids.agent }], outputs: [{ name: 'suggestions', node_id: 'suggest' }] } });
  next.modes.push({ id: ids.mode, name: 'Crossword word suggestions', description: 'Generate a reusable set of words and clues for review in the crossword editor.', welcome: 'Save a crossword title and description, then generate and review its words and clues.', agentId: ids.agent, workflowId: ids.workflow, enabled: false, audience: { allEditors: false, userIds: [] } });
  return validateAgentConfig(next);
}
