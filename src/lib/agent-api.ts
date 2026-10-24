import { coreRequest, isCore } from './core';
import { LocalAgentRuntime } from './agent-local';
import { validateAgentConfig } from './agent-defaults';
import type { AgentConfig, AgentContext, AgentSession, AgentSettings, AgentTurn } from './agent-types';
import { parseDocument, type Post } from './model';
export { contextFingerprint } from './agent-defaults';

function local(): LocalAgentRuntime {
  if (import.meta.env.VITE_APP_MODE === 'cloud') throw new Error('The assistant requires the NCE Core API deployment. It is unavailable in the legacy Cognito backend.');
  return new LocalAgentRuntime(localStorage);
}
export function buildAgentContext(post: Post, mediaIds: string[]): AgentContext {
  const doc = parseDocument(post.document), available = new Set(doc.blocks.filter(block => ['image', 'video'].includes(block.type)).map(block => block.id));
  return { title: post.title, excerpt: post.excerpt, category: post.category, document: post.document, mediaIds: [...new Set(mediaIds)].filter(id => available.has(id)).sort() };
}
export async function getAgentSettings(): Promise<AgentSettings> { return isCore ? coreRequest('/assistant/config') : local().settings(); }
export async function saveAgentSettings(config: AgentConfig, expectedRevision: number): Promise<AgentSettings> {
  const clean = validateAgentConfig(config);
  return isCore ? coreRequest('/assistant/config', 'PUT', { config: clean, expectedRevision }) : local().save(clean, expectedRevision);
}
export async function createAgentSession(id: string, postId: string, modeId: string, context: AgentContext): Promise<AgentSession> { return isCore ? coreRequest('/assistant/sessions', 'POST', { id, postId, modeId, context }) : local().create(id, postId, modeId, context); }
export async function getAgentSession(id: string): Promise<AgentSession> { return isCore ? coreRequest(`/assistant/sessions/${encodeURIComponent(id)}`) : local().get(id); }
export async function sendAgentTurn(id: string, turn: AgentTurn): Promise<AgentSession> { return isCore ? coreRequest(`/assistant/sessions/${encodeURIComponent(id)}/turn`, 'POST', turn) : local().turn(id, turn); }
export async function deleteAgentSession(id: string): Promise<void> {
  if (isCore) { await coreRequest(`/assistant/sessions/${encodeURIComponent(id)}`, 'DELETE'); return; }
  local().delete(id);
}
