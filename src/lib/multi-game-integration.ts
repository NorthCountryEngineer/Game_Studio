import { multiMaterialPathValid, parseMultiGameProgress, parseMultiMaterialStep, type MultiGameProgress, type MultiMaterialRequest } from './multi-game-session';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Context = { channel: string; gameId: string; publishedRevision: number };
type Base = Context & { source: 'nce-game-studio'; version: 4 };
export type MultiMaterialEvent = Base & MultiMaterialRequest & { type: 'material-request' };
export type MultiProgressEvent = Base & { type: 'multi-progress'; progress: MultiGameProgress };
export type MultiStudioEvent = MultiMaterialEvent | MultiProgressEvent;
export type MultiMaterialResponse = Context & { source: 'nce-game-host'; version: 4; type: 'material-result'; runId: string; requestId: string; path: string[]; status: 'completed' | 'unavailable' };
const keys = (value: Record<string, unknown>, required: string[]) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key));
function context(value: Record<string, unknown>) { return typeof value.channel === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.channel) && typeof value.gameId === 'string' && uuid.test(value.gameId) && Number.isSafeInteger(value.publishedRevision) && Number(value.publishedRevision) >= 1 && Number(value.publishedRevision) <= 1_000_000_000; }
export function parseMultiStudioEvent(value: unknown): MultiStudioEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>, base = ['source', 'version', 'channel', 'gameId', 'publishedRevision', 'type'];
  if (row.source !== 'nce-game-studio' || row.version !== 4 || !context(row)) return;
  if (row.type === 'material-request') {
    const node = parseMultiMaterialStep(row.node);
    if (!keys(row, [...base, 'runId', 'requestId', 'path', 'node']) || typeof row.runId !== 'string' || !uuid.test(row.runId) || typeof row.requestId !== 'string' || !uuid.test(row.requestId) || !multiMaterialPathValid(row.path) || !node || row.path.at(-1) !== node.id || row.path.length === 1 && !['content', 'video', 'interactive'].includes(node.kind) || row.path.length === 2 && !['lesson', 'video', 'exercise'].includes(node.kind)) return;
  } else if (row.type === 'multi-progress') {
    if (!keys(row, [...base, 'progress']) || !parseMultiGameProgress(row.progress)) return;
  } else return;
  return structuredClone(row) as MultiStudioEvent;
}
export function parseMultiMaterialResponse(value: unknown): MultiMaterialResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (!keys(row, ['source', 'version', 'channel', 'gameId', 'publishedRevision', 'type', 'runId', 'requestId', 'path', 'status']) || !context(row) || row.source !== 'nce-game-host' || row.version !== 4 || row.type !== 'material-result' || typeof row.runId !== 'string' || !uuid.test(row.runId) || typeof row.requestId !== 'string' || !uuid.test(row.requestId) || !multiMaterialPathValid(row.path) || !['completed', 'unavailable'].includes(row.status as string)) return;
  return structuredClone(row) as MultiMaterialResponse;
}

/** A nested step path prevents two children with step-1 from releasing each other. */
export function requestMultiHostMaterial(target: Window, origin: string, binding: Context, request: MultiMaterialRequest, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Material request cancelled.')); return; }
    const pending = parseMultiStudioEvent({ ...binding, ...request, source: 'nce-game-studio', version: 4, type: 'material-request' });
    if (!pending || pending.type !== 'material-request') { reject(new Error('The material request is invalid.')); return; }
    try {
      const url = new URL(origin);
      if (url.origin !== origin || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error();
    } catch { reject(new Error('An exact connected application origin is required.')); return; }
    const clean = () => { window.removeEventListener('message', receive); signal.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new Error('Material request cancelled.')); };
    const receive = (event: MessageEvent) => {
      if (event.source !== target || event.origin !== origin) return;
      const reply = parseMultiMaterialResponse(event.data);
      if (!reply || reply.channel !== pending.channel || reply.gameId !== pending.gameId || reply.publishedRevision !== pending.publishedRevision || reply.runId !== pending.runId || reply.requestId !== pending.requestId || JSON.stringify(reply.path) !== JSON.stringify(pending.path)) return;
      clean(); if (reply.status === 'completed') resolve(); else reject(new Error('This object is unavailable in the connected application. Try again or contact its administrator.'));
    };
    window.addEventListener('message', receive); signal.addEventListener('abort', abort, { once: true });
    try { target.postMessage(pending, origin); } catch { clean(); reject(new Error('The connected application could not receive this material request.')); }
  });
}
