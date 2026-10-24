import defaults from '../../config/agent-framework.json';
import type { AgentConfig, AgentContext, AgentMode, AgentSettings, SkillDefinition, WorkflowGraph } from './agent-types';

export const AGENT_SKILLS: SkillDefinition[] = [
  { id: 'media.inventory', name: 'Review selected media', description: 'List selected files and missing captions or image descriptions. Does not inspect pixels or audio.', paid: false },
  { id: 'agent.respond', name: 'Ask an agent', description: 'Use the configured local coach or generative model.', paid: false },
  { id: 'ml.image_labels', name: 'Analyze images', description: 'Recognize labels in selected JPEG and PNG images with an enabled ML model.', paid: true },
  { id: 'ml.video_labels', name: 'Analyze video', description: 'Start or check an asynchronous ML analysis of a selected MP4 video.', paid: true },
  { id: 'review.draft', name: 'Prepare draft suggestions', description: 'Prepare suggestions for the author to review. Never publishes or edits a draft automatically.', paid: false },
];
const identifier = /^[a-z][a-z0-9_-]{0,63}$/;
const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const skillIds = new Set(AGENT_SKILLS.map(skill => skill.id));
const contexts = new Set(['post', 'media', 'message']);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, label: string): asserts value is Record<string, unknown> { check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`); }
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []) { check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Unexpected or missing configuration fields.'); }
function bounded(value: unknown, minimum: number, maximum: number, label: string) { check(typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum, `${label} must be ${minimum}–${maximum}.`); }
function text(value: unknown, maximum: number, label: string, required = false): asserts value is string { check(typeof value === 'string' && value.length <= maximum && (!required || value.trim().length > 0), `${label} must be ${required ? 'nonempty and ' : ''}under ${maximum + 1} characters.`); }
function rows(value: unknown, label: string): asserts value is Record<string, unknown>[] {
  check(Array.isArray(value) && value.length <= 24, `${label} must contain at most 24 items.`);
  const ids = new Set<string>();
  for (const row of value) { object(row, label); text(row.id, 64, `${label} ID`, true); check(identifier.test(row.id) && !ids.has(row.id), `${label} IDs must be unique letters, numbers, hyphens, or underscores, starting with a letter.`); ids.add(row.id); text(row.name, 100, `${label} name`, true); check(typeof row.enabled === 'boolean', `${label} enabled must be true or false.`); }
}

export function validateWorkflow(value: unknown, agentIds: Set<string>): WorkflowGraph {
  object(value, 'Workflow'); fields(value, ['version', 'inputs', 'nodes', 'outputs']); check(value.version === 1, 'Unsupported workflow version.');
  check(Array.isArray(value.inputs) && value.inputs.length <= 12, 'Workflow needs an inputs array.');
  check(Array.isArray(value.nodes) && value.nodes.length > 0 && value.nodes.length <= 12, 'A workflow needs 1–12 steps.');
  check(Array.isArray(value.outputs) && value.outputs.length <= 12, 'Workflow needs an outputs array.');
  const inputs = new Set<string>();
  for (const input of value.inputs) { object(input, 'Workflow input'); fields(input, ['name', 'label', 'type', 'required'], ['default']); text(input.name, 64, 'Input name', true); check(identifier.test(input.name) && !inputs.has(input.name), 'Input names must be valid and unique.'); inputs.add(input.name); text(input.label, 100, 'Input label'); check(input.type === 'string' && typeof input.required === 'boolean', 'Workflow inputs currently support string values.'); if (input.default !== undefined) text(input.default, 2000, 'Input default'); }
  const ids = new Set<string>();
  for (const node of value.nodes) {
    object(node, 'Step'); fields(node, ['id', 'skill', 'name', 'depends_on', 'inputs', 'agent_id']); text(node.id, 64, 'Step ID', true); check(identifier.test(node.id) && !ids.has(node.id), 'Step IDs must be valid and unique.'); ids.add(node.id);
    text(node.name, 100, 'Step name', true); check(typeof node.skill === 'string' && skillIds.has(node.skill), 'Choose a registered step skill.');
    check(Array.isArray(node.depends_on) && node.depends_on.length <= 12 && node.depends_on.every(id => typeof id === 'string') && new Set(node.depends_on).size === node.depends_on.length, 'Step dependencies must be a list of unique step IDs.');
    object(node.inputs, 'Step inputs'); check(canonicalJSON(node.inputs).length <= 4000, 'Step inputs must be under 4 KB.'); text(node.agent_id, 64, 'Step agent');
    check(agentIds.has(node.agent_id), 'A step references an unknown agent.');
    check(!['agent.respond', 'ml.image_labels', 'ml.video_labels'].includes(node.skill) || agentIds.has(node.agent_id), 'Agent and ML steps need an agent profile.');
  }
  const ancestors = new Map<string, Set<string>>();
  const pending = [...value.nodes] as Record<string, unknown>[];
  const inspect = (binding: unknown, dependencies: Set<string>, depth = 0) => {
    check(depth <= 8, 'Workflow inputs are nested too deeply.');
    if (Array.isArray(binding)) { check(binding.length <= 40, 'Too many workflow input values.'); binding.forEach(item => inspect(item, dependencies, depth + 1)); return; }
    if (!binding || typeof binding !== 'object') { check(binding === null || typeof binding === 'string' || typeof binding === 'boolean' || typeof binding === 'number' && Number.isSafeInteger(binding), 'Workflow inputs must contain JSON strings, booleans, integers, arrays, or objects.'); return; }
    const item = binding as Record<string, unknown>, operators = Object.keys(item).filter(key => key.startsWith('$'));
    if (operators.length) {
      check(operators.length === 1 && ['$input', '$node', '$context'].includes(operators[0]), 'Unknown or mixed binding operator.');
      const operator = operators[0], name = item[operator];
      check(typeof name === 'string' && Object.keys(item).every(key => key === operator || key === 'path'), 'Invalid input binding.');
      if (operator === '$input') check(inputs.has(name), 'Binding references an undeclared input.');
      if (operator === '$context') check(contexts.has(name), 'Unavailable context binding.');
      if (operator === '$node') check(dependencies.has(name), 'Output bindings must reference a dependency of this step.');
      if ('path' in item) check(operator === '$node' && typeof item.path === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,7}$/.test(item.path) && !item.path.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key)), 'Invalid output binding path.');
    } else { check(Object.keys(item).every(key => key.length <= 80 && !key.startsWith('__')), 'Invalid workflow input key.'); Object.values(item).forEach(nested => inspect(nested, dependencies, depth + 1)); }
  };
  while (pending.length) {
    const index = pending.findIndex(node => (node.depends_on as string[]).every(id => ancestors.has(id)));
    check(index >= 0, 'Workflow dependencies contain a cycle or an unknown step.');
    const [node] = pending.splice(index, 1), dependencies = new Set<string>();
    for (const id of node.depends_on as string[]) { dependencies.add(id); ancestors.get(id)!.forEach(ancestor => dependencies.add(ancestor)); }
    inspect(node.inputs, dependencies); ancestors.set(node.id as string, dependencies);
  }
  const outputs = new Set<string>();
  for (const output of value.outputs) { object(output, 'Workflow output'); fields(output, ['name', 'node_id']); text(output.name, 64, 'Output name', true); check(identifier.test(output.name) && !outputs.has(output.name), 'Output names must be valid and unique.'); outputs.add(output.name); check(typeof output.node_id === 'string' && ids.has(output.node_id), 'Output references an unknown step.'); }
  check(JSON.stringify(value).length <= 100000, 'Workflow exceeds 100 KB.');
  return structuredClone(value) as unknown as WorkflowGraph;
}

export function validateAgentConfig(value: unknown): AgentConfig {
  object(value, 'Assistant configuration'); fields(value, ['version', 'revision', 'enabled', 'allowPaidExecution', 'limits', 'models', 'agents', 'workflows', 'modes']); check(value.version === 1, 'Unsupported assistant configuration version.'); bounded(value.revision, 0, 1000000000, 'Configuration revision');
  check(typeof value.enabled === 'boolean' && typeof value.allowPaidExecution === 'boolean', 'Assistant switches must be true or false.');
  object(value.limits, 'Limits'); fields(value.limits, ['maxTurns', 'maxSteps', 'maxInputChars', 'maxModelCalls']); bounded(value.limits.maxTurns, 1, 40, 'Maximum turns'); bounded(value.limits.maxSteps, 1, 40, 'Maximum steps'); bounded(value.limits.maxInputChars, 100, 12000, 'Input characters'); bounded(value.limits.maxModelCalls, 0, 12, 'Maximum model calls');
  rows(value.models, 'Models'); rows(value.agents, 'Agents'); rows(value.workflows, 'Workflows'); rows(value.modes, 'Modes');
  for (const model of value.models) {
    fields(model, ['id', 'name', 'kind', 'provider', 'target', 'enabled', 'maxOutputTokens']);
    check(['local', 'generative', 'ml'].includes(String(model.kind)), 'Unknown model kind.');
    check((model.kind === 'local' && model.provider === 'local') || (model.kind === 'generative' && model.provider === 'bedrock') || (model.kind === 'ml' && model.provider === 'rekognition'), 'Model kind and provider do not match.');
    text(model.target, 500, 'Model target'); bounded(model.maxOutputTokens, 64, 2048, 'Output tokens');
    if (model.provider === 'local') check(model.target === 'media-coach-v1', 'Unknown local model target.');
    if (model.provider === 'bedrock') check((!model.enabled && model.target === '') || /^[A-Za-z0-9.:/_-]+$/.test(model.target), 'Enter an exact Bedrock model or inference profile ID/ARN.');
    if (model.provider === 'rekognition') check(['detect-labels', 'video-labels'].includes(model.target), 'Choose detect-labels or video-labels for Rekognition.');
  }
  const modelIds = new Set(value.models.map(model => model.id)), agentIds = new Set(value.agents.map(agent => String(agent.id))), workflowIds = new Set(value.workflows.map(workflow => workflow.id));
  for (const agent of value.agents) { fields(agent, ['id', 'name', 'description', 'instructions', 'modelId', 'enabled']); text(agent.description, 500, 'Agent description'); text(agent.instructions, 4000, 'Agent instructions'); check(modelIds.has(agent.modelId), 'An agent references an unknown model.'); }
  for (const workflow of value.workflows) { fields(workflow, ['id', 'name', 'description', 'enabled', 'graph']); text(workflow.description, 500, 'Workflow description'); validateWorkflow(workflow.graph, agentIds); }
  for (const mode of value.modes) {
    fields(mode, ['id', 'name', 'description', 'welcome', 'agentId', 'workflowId', 'enabled'], ['audience']); text(mode.description, 500, 'Mode description'); text(mode.welcome, 1000, 'Welcome message'); check(typeof mode.agentId === 'string' && agentIds.has(mode.agentId), 'A mode references an unknown agent.'); check(typeof mode.workflowId === 'string' && workflowIds.has(mode.workflowId), 'A mode references an unknown workflow.');
    if (mode.audience !== undefined) { object(mode.audience, 'Mode audience'); fields(mode.audience, ['allEditors', 'userIds']); check(typeof mode.audience.allEditors === 'boolean', 'Mode audience must choose all editors or selected accounts.'); const ids = mode.audience.userIds; check(Array.isArray(ids) && ids.length <= 100 && ids.every(id => typeof id === 'string' && subjectId.test(id)) && new Set(ids).size === ids.length, 'Select at most 100 unique Core account identifiers.'); }
  }
  check(new TextEncoder().encode(JSON.stringify(value)).length <= 48000, 'Keep the assistant configuration under 48 KB.');
  return structuredClone(value) as unknown as AgentConfig;
}

export function defaultAgentSettings(): AgentSettings { return { config: validateAgentConfig(defaults), paidModelsAllowed: false, skills: structuredClone(AGENT_SKILLS) }; }
export function modeAvailable(mode: AgentMode, subject: string): boolean { return !mode.audience || mode.audience.allEditors || mode.audience.userIds.includes(subject); }
export function canonicalJSON(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, nested]) => [key, ordered(nested)])) : item;
  return JSON.stringify(ordered(value));
}
export async function contextFingerprint(context: AgentContext): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(context)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
