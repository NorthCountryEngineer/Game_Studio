import type { Block } from './model';

export type ModelProvider = 'local' | 'bedrock' | 'rekognition';
export type AgentModel = { id: string; name: string; kind: 'local' | 'generative' | 'ml'; provider: ModelProvider; target: string; enabled: boolean; maxOutputTokens: number };
export type AgentDefinition = { id: string; name: string; description: string; instructions: string; modelId: string; enabled: boolean };
export type WorkflowInput = { name: string; label: string; type: 'string'; required: boolean; default?: string };
export type WorkflowNode = { id: string; skill: string; name: string; depends_on: string[]; inputs: Record<string, unknown>; agent_id: string };
export type WorkflowGraph = { version: 1; inputs: WorkflowInput[]; nodes: WorkflowNode[]; outputs: { name: string; node_id: string }[] };
export type AgentWorkflow = { id: string; name: string; description: string; enabled: boolean; graph: WorkflowGraph };
export type AgentMode = { id: string; name: string; description: string; welcome: string; agentId: string; workflowId: string; enabled: boolean; audience?: { allEditors: boolean; userIds: string[] } };
export type AgentConfig = { version: 1; revision: number; enabled: boolean; allowPaidExecution: boolean; limits: { maxTurns: number; maxSteps: number; maxInputChars: number; maxModelCalls: number }; models: AgentModel[]; agents: AgentDefinition[]; workflows: AgentWorkflow[]; modes: AgentMode[] };
export type SkillDefinition = { id: string; name: string; description: string; paid: boolean };
export type AgentSettings = { config: AgentConfig; paidModelsAllowed: boolean; skills: SkillDefinition[]; availableModeIds?: string[] };
export type AgentContext = { title: string; excerpt: string; category: string; document: string; mediaIds: string[] };
export type AgentSuggestion = { summary: string; title?: string; excerpt?: string; blocks?: Block[]; captions?: { blockId: string; caption: string; alt?: string }[] };
export type AgentStep = { nodeId: string; name: string; status: 'pending' | 'running' | 'waiting' | 'complete' | 'failed' | 'uncertain'; output?: unknown };
export type AgentSession = { id: string; postId: string; modeId: string; modeName: string; workflow?: { id: string; name: string; description: string; inputs: WorkflowInput[] }; revision: number; status: 'ready' | 'running' | 'waiting' | 'review' | 'complete' | 'uncertain' | 'failed'; contextFingerprint: string; messages: { id: string; role: 'user' | 'assistant'; text: string }[]; steps: AgentStep[]; suggestion?: AgentSuggestion; usage: { modelCalls: number; inputTokens: number; outputTokens: number }; error?: string; createdAt: string; updatedAt: string };
export type AgentTurn = { requestId: string; revision: number; action: 'message' | 'workflow' | 'advance'; message?: string; inputs?: Record<string, string> };
