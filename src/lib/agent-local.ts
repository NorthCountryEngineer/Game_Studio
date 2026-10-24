import { AGENT_SKILLS, canonicalJSON, contextFingerprint, defaultAgentSettings, modeAvailable, validateAgentConfig } from './agent-defaults';
import type { AgentConfig, AgentContext, AgentDefinition, AgentSession, AgentSettings, AgentSuggestion, AgentTurn, WorkflowGraph } from './agent-types';
import { parseDocument } from './model';

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LocalRecord = { session: AgentSession; context: AgentContext; snapshot: AgentConfig; requests: { id: string; fingerprint: string }[]; inputs: Record<string, string>; started: boolean; stepCount?: number };
const configKey = 'game-studio-assistant-config-v1', sessionKey = (id: string) => `game-studio-assistant-session-v1:${id}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const now = () => new Date().toISOString();
export const LOCAL_ASSISTANT_SUBJECT = '11111111-1111-4111-8111-111111111110';
function ensureId(id: string) { if (!uuid.test(id)) throw new Error('Invalid conversation or request identifier.'); }
function items(context: AgentContext) {
  const selected = new Set(context.mediaIds);
  return parseDocument(context.document).blocks.filter(block => selected.has(block.id)).map(block => ({ blockId: block.id, type: block.type, name: block.name || '', mime: block.mime || '', caption: block.caption || '', alt: block.alt || '' }));
}
export function localMediaInventory(context: AgentContext) {
  const selected = items(context);
  return { items: selected.map(item => ({ ...item, checks: [...(!item.caption.trim() ? ['Add a caption.'] : []), ...(item.type === 'image' && !item.alt.trim() ? ['Add an image description for screen readers.'] : [])] })), summary: selected.length ? `${selected.length} selected file${selected.length === 1 ? '' : 's'}. This local check reads file details and existing captions; it does not recognize image or video contents.` : 'No media selected. Add a picture or video to your draft, then start a new conversation to discuss it.' };
}
function explicitSuggestion(context: AgentContext, message: string): AgentSuggestion | undefined {
  const caption = /(?:^|\n)[ \t]*caption[ \t]*:[ \t]*([^\n]+)/i.exec(message)?.[1]?.trim(), title = /(?:^|\n)[ \t]*title[ \t]*:[ \t]*([^\n]+)/i.exec(message)?.[1]?.trim(), alt = /(?:^|\n)[ \t]*alt[ \t]*:[ \t]*([^\n]+)/i.exec(message)?.[1]?.trim();
  const first = items(context)[0];
  if ((!caption || !first) && (!alt || first?.type !== 'image') && !title) return;
  return { summary: 'Your supplied wording is ready to review. This local coach has not checked what is visible in the media.', ...(title ? { title: title.slice(0, 120) } : {}), ...(first && (caption || alt && first.type === 'image') ? { captions: [{ blockId: first.blockId, caption: caption ? caption.slice(0, 1000) : first.caption, ...(alt && first.type === 'image' ? { alt: alt.slice(0, 300) } : {}) }] } : {}) };
}
function localResponse(context: AgentContext, message: string, agent: AgentDefinition) {
  const inventory = localMediaInventory(context), suggestion = explicitSuggestion(context, message);
  const guidance = suggestion ? 'I prepared your wording for review below. Check it against your media, then choose Apply to draft when you are ready.' : 'Describe what is happening in your picture or video, and what you want readers to notice. To propose your exact wording, send “Caption: your words” or “Title: your words”.';
  return { text: `${agent.name} · local guidance (no AI inference)\n\n${inventory.summary}\n\n${guidance}`, ...(suggestion ? { suggestion } : {}) };
}
function binding(value: unknown, graph: WorkflowGraph, record: LocalRecord): unknown {
  if (Array.isArray(value)) return value.map(item => binding(item, graph, record));
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if ('$input' in item) return record.inputs[String(item.$input)];
  if ('$context' in item) {
    if (item.$context === 'post') { const { mediaIds: _media, ...post } = record.context; return post; }
    if (item.$context === 'media') return items(record.context);
    if (item.$context === 'message') return [...record.session.messages].reverse().find(message => message.role === 'user')?.text || '';
  }
  if ('$node' in item) {
    let result = record.session.steps.find(step => step.nodeId === item.$node)?.output;
    for (const key of typeof item.path === 'string' ? item.path.split('.') : []) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !result || typeof result !== 'object' || !Object.hasOwn(result, key)) throw new Error('The workflow output binding could not be resolved.');
      result = (result as Record<string, unknown>)[key];
    }
    return result;
  }
  return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, binding(nested, graph, record)]));
}

/** Browser-only rehearsal. There is deliberately no model transport in this runtime. */
export class LocalAgentRuntime {
  constructor(private storage: StoragePort, private subject = LOCAL_ASSISTANT_SUBJECT) {}
  settings(): AgentSettings {
    const stored = this.storage.getItem(configKey), config = stored ? validateAgentConfig(JSON.parse(stored)) : defaultAgentSettings().config;
    return { config, paidModelsAllowed: false, skills: structuredClone(AGENT_SKILLS), availableModeIds: config.modes.filter(mode => mode.enabled && modeAvailable(mode, this.subject)).map(mode => mode.id) };
  }
  save(config: AgentConfig, expectedRevision: number): AgentSettings {
    const current = this.settings().config;
    if (current.revision !== expectedRevision) throw new Error('Configuration changed. Reload the settings before saving again.');
    const clean = validateAgentConfig(config); clean.revision = current.revision + 1;
    this.storage.setItem(configKey, JSON.stringify(clean)); return this.settings();
  }
  private read(id: string): LocalRecord {
    ensureId(id); const raw = this.storage.getItem(sessionKey(id));
    if (!raw) throw new Error('This conversation is no longer available.');
    return JSON.parse(raw) as LocalRecord;
  }
  private write(record: LocalRecord): AgentSession {
    const value = JSON.stringify(record);
    if (new TextEncoder().encode(value).length > 330000) throw new Error('This conversation is full. Start a new conversation with a smaller draft.');
    this.storage.setItem(sessionKey(record.session.id), value); return structuredClone(record.session);
  }
  get(id: string): AgentSession { return structuredClone(this.read(id).session); }
  delete(id: string) { ensureId(id); this.storage.removeItem(sessionKey(id)); }
  async create(id: string, postId: string, modeId: string, context: AgentContext): Promise<AgentSession> {
    ensureId(id); ensureId(postId); const snapshot = this.settings().config, fingerprint = await contextFingerprint(context);
    if (!snapshot.enabled) throw new Error('The newsroom assistant is disabled.');
    const mode = snapshot.modes.find(item => item.id === modeId && item.enabled && modeAvailable(item, this.subject));
    if (!mode) throw new Error('This assistant mode is unavailable for your account.');
    const existing = this.storage.getItem(sessionKey(id));
    if (existing) { const record = JSON.parse(existing) as LocalRecord; if (record.session.postId !== postId || record.session.modeId !== modeId || record.session.contextFingerprint !== fingerprint) throw new Error('This conversation identifier is already in use.'); return record.session; }
    const doc = parseDocument(context.document), selected = new Set(context.mediaIds);
    if (context.document.length > 80000 || new TextEncoder().encode(canonicalJSON(context)).length > 110000) throw new Error('Use a smaller draft for an assistant conversation.');
    if (selected.size > 8 || selected.size !== context.mediaIds.length || [...selected].some(mediaId => !doc.blocks.some(block => block.id === mediaId && ['image', 'video'].includes(block.type)))) throw new Error('Select up to eight images and videos in this draft.');
    const createdAt = now(), workflow = snapshot.workflows.find(item => item.id === mode.workflowId)!;
    return this.write({ context: structuredClone(context), snapshot, requests: [], inputs: {}, started: false, session: { id, postId, modeId, modeName: mode.name, workflow: { id: workflow.id, name: workflow.name, description: workflow.description, inputs: structuredClone(workflow.graph.inputs) }, revision: 0, status: 'ready', contextFingerprint: fingerprint, messages: [{ id: crypto.randomUUID(), role: 'assistant', text: `${mode.welcome}\n\nLocal preview: this conversation stays in this browser. No AI or ML service is contacted.` }], steps: [], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 }, createdAt, updatedAt: createdAt } });
  }
  turn(id: string, turn: AgentTurn): AgentSession {
    ensureId(turn.requestId); const record = this.read(id), session = record.session;
    const current = this.settings().config, mode = record.snapshot.modes.find(item => item.id === session.modeId)!, currentMode = current.modes.find(item => item.id === mode.id);
    if (!current.enabled || !currentMode?.enabled || !modeAvailable(currentMode, this.subject)) throw new Error('This assistant mode has been disabled or is unavailable for your account.');
    if (currentMode.agentId !== mode.agentId || currentMode.workflowId !== mode.workflowId) throw new Error('This mode now uses a different agent or workflow. Start a new conversation.');
    const previousWorkflow = record.snapshot.workflows.find(item => item.id === mode.workflowId), currentWorkflow = current.workflows.find(item => item.id === mode.workflowId);
    if (!previousWorkflow || !currentWorkflow?.enabled) throw new Error('This workflow has been disabled.');
    const bindings = (graph: WorkflowGraph) => graph.nodes.map(node => [node.id, node.skill, node.agent_id]);
    if (canonicalJSON(bindings(previousWorkflow.graph)) !== canonicalJSON(bindings(currentWorkflow.graph))) throw new Error('This workflow uses different steps or agents. Start a new conversation.');
    const requestFingerprint = canonicalJSON({ ...turn, revision: undefined }), receipt = record.requests.find(request => request.id === turn.requestId);
    if (receipt) { if (receipt.fingerprint !== requestFingerprint) throw new Error('Request identifiers cannot be reused for different actions.'); return structuredClone(session); }
    if (session.revision !== turn.revision) throw new Error('The conversation changed. Reload it before continuing.');
    if (['running', 'uncertain', 'failed'].includes(session.status)) throw new Error('This conversation cannot run another step. Start a new conversation.');
    const availableAgent = (agentId: string) => {
      const agent = record.snapshot.agents.find(item => item.id === agentId && item.enabled);
      if (!agent || !current.agents.some(item => item.id === agentId && item.enabled && item.modelId === agent.modelId)) throw new Error('This agent has been disabled or changed. Start a new conversation.');
      const model = record.snapshot.models.find(item => item.id === agent.modelId && item.enabled);
      if (!model || !current.models.some(item => item.id === model.id && item.enabled && item.provider === model.provider && item.target === model.target)) throw new Error('This model has been disabled or changed. Start a new conversation.');
      if (model.provider !== 'local') throw new Error('Paid AI and media analysis do not run in local preview. Configure and explicitly enable the server-side provider after deployment.');
      return agent;
    };
    if (turn.action === 'message') {
      if (record.started && session.steps.some(step => step.status !== 'complete')) throw new Error('Finish the current workflow before sending another message.');
      const maxInput = Math.min(current.limits.maxInputChars, record.snapshot.limits.maxInputChars);
      if (typeof turn.message !== 'string' || !turn.message.trim() || turn.message.length > maxInput) throw new Error(`Enter a message under ${maxInput + 1} characters.`);
      if (session.messages.filter(message => message.role === 'user').length >= Math.min(current.limits.maxTurns, record.snapshot.limits.maxTurns)) throw new Error('This conversation reached its turn limit. Start a new conversation.');
      const agent = availableAgent(mode.agentId), response = localResponse(record.context, turn.message, agent);
      session.messages.push({ id: crypto.randomUUID(), role: 'user', text: turn.message }, { id: crypto.randomUUID(), role: 'assistant', text: response.text });
      session.suggestion = response.suggestion; session.status = response.suggestion ? 'review' : 'ready';
    } else {
      const workflow = record.snapshot.workflows.find(item => item.id === mode.workflowId && item.enabled);
      if (!workflow || !current.workflows.some(item => item.id === workflow.id && item.enabled)) throw new Error('This workflow is unavailable or has been disabled.');
      if (turn.action === 'workflow') {
        if (record.started) throw new Error('This conversation already has a workflow. Start a new conversation to run it again.');
        const inputs = turn.inputs || {};
        if (Object.keys(inputs).some(name => !workflow.graph.inputs.some(input => input.name === name))) throw new Error('Unknown workflow input.');
        for (const input of workflow.graph.inputs) {
          const value = inputs[input.name] ?? input.default ?? '';
          if (typeof value !== 'string' || value.length > Math.min(2000, current.limits.maxInputChars, record.snapshot.limits.maxInputChars) || (input.required && !value.trim())) throw new Error(`Enter a value for ${input.label} within the input limit.`);
          record.inputs[input.name] = value;
        }
        if (workflow.graph.nodes.length > Math.min(current.limits.maxSteps, record.snapshot.limits.maxSteps)) throw new Error('This workflow exceeds the step limit.');
        session.steps = workflow.graph.nodes.map(node => ({ nodeId: node.id, name: node.name, status: 'pending' })); record.started = true; session.suggestion = undefined; session.status = 'ready';
      } else if (turn.action === 'advance') {
        if (!record.started) throw new Error('Start the workflow first.');
        if ((record.stepCount || 0) >= Math.min(current.limits.maxSteps, record.snapshot.limits.maxSteps)) throw new Error('This conversation reached its step limit.');
        const node = workflow.graph.nodes.find(item => session.steps.find(step => step.nodeId === item.id)?.status === 'pending' && item.depends_on.every(id => session.steps.find(step => step.nodeId === id)?.status === 'complete'));
        if (!node) throw new Error('There are no pending workflow steps.');
        const step = session.steps.find(item => item.nodeId === node.id)!, inputs = binding(node.inputs, workflow.graph, record) as Record<string, unknown>;
        if (node.skill === 'media.inventory') step.output = localMediaInventory(record.context);
        else if (node.skill === 'agent.respond') {
          const response = localResponse(record.context, String(inputs.message ?? [...session.messages].reverse().find(item => item.role === 'user')?.text ?? ''), availableAgent(node.agent_id));
          step.output = response; session.messages.push({ id: crypto.randomUUID(), role: 'assistant', text: response.text });
        } else if (node.skill === 'review.draft') {
          const response = inputs.response as { suggestion?: AgentSuggestion } | undefined;
          session.suggestion = response?.suggestion || explicitSuggestion(record.context, [...session.messages].reverse().find(item => item.role === 'user')?.text || '') || { summary: 'Review your selected files. Describe what happens, add captions in your own words, and include image descriptions. This local workflow has not inspected media contents.' };
          step.output = session.suggestion;
        } else throw new Error('Media recognition requires an explicitly enabled server-side ML provider. Local preview never calls paid services.');
        record.stepCount = (record.stepCount || 0) + 1; step.status = 'complete'; session.status = session.steps.every(item => item.status === 'complete') ? session.suggestion ? 'review' : 'complete' : 'ready';
      } else throw new Error('Unknown conversation action.');
    }
    record.requests.push({ id: turn.requestId, fingerprint: requestFingerprint }); session.revision++; session.updatedAt = now(); return this.write(record);
  }
}
