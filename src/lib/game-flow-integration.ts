import { materialReferenceValid, parseFlowProgress, type FlowProgress, type MaterialRequest, type MaterialStep } from './game-flow-session';
import type { GameResult } from './game-types';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Context = { channel: string; gameId: string; publishedRevision: number };
type Base = Context & { source: 'nce-game-studio'; version: 3 };
export type MaterialEvent = Base & MaterialRequest & { type: 'material-request' };
export type FlowEvent = Base & { type: 'flow-progress'; progress: FlowProgress; result?: GameResult };
export type FlowStudioEvent = MaterialEvent | FlowEvent;
export type MaterialResponse = Context & { source: 'nce-game-host'; version: 3; type: 'material-result'; runId: string; requestId: string; nodeId: string; status: 'completed' | 'unavailable' };
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function context(value: Record<string, unknown>) { return typeof value.channel === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.channel) && typeof value.gameId === 'string' && uuid.test(value.gameId) && Number.isSafeInteger(value.publishedRevision) && Number(value.publishedRevision) >= 1; }
export function parseMaterialStep(value: unknown): MaterialStep | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const node = value as Record<string, unknown>;
  if (!keys(node, ['id', 'type', 'title', 'kind', 'reference', 'required']) || typeof node.id !== 'string' || !/^step-(?:[1-9]|1[0-9]|2[0-4])$/.test(node.id) || node.type !== 'material' || typeof node.title !== 'string' || !node.title.trim() || node.title !== node.title.trim() || node.title.length > 80 || /[<>\u0000-\u001f\u007f-\u009f]/u.test(node.title) || !['lesson', 'video', 'exercise'].includes(node.kind as string) || !materialReferenceValid(node.reference) || typeof node.required !== 'boolean') return;
  return structuredClone(node) as MaterialStep;
}
export function parseFlowStudioEvent(value: unknown): FlowStudioEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.source !== 'nce-game-studio' || row.version !== 3 || !context(row)) return;
  const base = ['source', 'version', 'channel', 'gameId', 'publishedRevision', 'type'];
  if (row.type === 'material-request') {
    if (!keys(row, [...base, 'runId', 'requestId', 'node']) || typeof row.runId !== 'string' || !uuid.test(row.runId) || typeof row.requestId !== 'string' || !uuid.test(row.requestId) || !parseMaterialStep(row.node)) return;
  } else if (row.type === 'flow-progress') {
    const progress = parseFlowProgress(row.progress);
    if (!keys(row, [...base, 'progress'], ['result']) || !progress) return;
    const terminal = progress.status === 'won' || progress.status === 'lost';
    if (terminal !== Object.hasOwn(row, 'result')) return;
    if (terminal) {
      if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result)) return;
      const result = row.result as Record<string, unknown>;
      if (!keys(result, ['outcome', 'elapsed', 'score', 'reviewedLevelIds'], ['points']) || result.outcome !== progress.status || result.elapsed !== progress.gameplayElapsed || result.score !== progress.score || result.points !== progress.points || !Array.isArray(result.reviewedLevelIds) || !result.reviewedLevelIds.length || result.reviewedLevelIds.length > 8 || result.reviewedLevelIds.some(id => typeof id !== 'string' || !/^level-[1-8]$/.test(id)) || new Set(result.reviewedLevelIds).size !== result.reviewedLevelIds.length) return;
      if (progress.status === 'won' && JSON.stringify(result.reviewedLevelIds) !== JSON.stringify(progress.completedLevelIds)) return;
    }
  } else return;
  return structuredClone(row) as FlowStudioEvent;
}
export function parseMaterialResponse(value: unknown): MaterialResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (!keys(row, ['source', 'version', 'channel', 'gameId', 'publishedRevision', 'type', 'runId', 'requestId', 'nodeId', 'status']) || !context(row) || row.source !== 'nce-game-host' || row.version !== 3 || row.type !== 'material-result' || typeof row.runId !== 'string' || !uuid.test(row.runId) || typeof row.requestId !== 'string' || !uuid.test(row.requestId) || typeof row.nodeId !== 'string' || !/^step-(?:[1-9]|1[0-9]|2[0-4])$/.test(row.nodeId) || !['completed', 'unavailable'].includes(row.status as string)) return;
  return structuredClone(row) as MaterialResponse;
}

/** Only the configured parent can release a pending material gate, once, for this run and edition. */
export function requestHostMaterial(target: Window, origin: string, binding: Context, request: MaterialRequest, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Material request cancelled.')); return; }
    const clean = () => { window.removeEventListener('message', receive); signal.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new Error('Material request cancelled.')); };
    const receive = (event: MessageEvent) => {
      if (event.source !== target || event.origin !== origin) return;
      const reply = parseMaterialResponse(event.data);
      if (!reply || reply.channel !== binding.channel || reply.gameId !== binding.gameId || reply.publishedRevision !== binding.publishedRevision || reply.runId !== request.runId || reply.requestId !== request.requestId || reply.nodeId !== request.node.id) return;
      clean(); if (reply.status === 'completed') resolve(); else reject(new Error('This material is unavailable in the connected application. Try again or contact its administrator.'));
    };
    window.addEventListener('message', receive); signal.addEventListener('abort', abort, { once: true });
    const event = parseFlowStudioEvent({ ...binding, ...request, source: 'nce-game-studio', version: 3, type: 'material-request' });
    if (!event) { clean(); reject(new Error('The material request is invalid.')); return; }
    try { target.postMessage(event, origin); } catch { clean(); reject(new Error('The connected application could not receive this material request.')); }
  });
}
