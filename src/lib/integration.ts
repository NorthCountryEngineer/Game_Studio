/** Versioned host interface. Tokens, role claims and private drafts never cross postMessage. */
export const INTEGRATION_VERSION = 1 as const;
export { validateScoringPolicy, gameObjectiveUnits, calculateProvisionalPoints, selectScoringAttempt, createPublicationBinding, scorePublishedGame } from './game-scoring';
export type { ScoringPolicy, ProvisionalPoints, PublicationBinding, ScoringAttempt } from './game-scoring';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hostId = /^[a-z][a-z0-9_-]{0,63}$/;
const channelId = /^[a-zA-Z0-9_-]{1,80}$/;
export function integrationOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Use an exact HTTPS origin, or localhost for development.');
  return url.origin;
}
function id(value: string) { if (!uuid.test(value)) throw new Error('A valid published game ID is required.'); return value; }
function host(value?: string) { if (value !== undefined && !hostId.test(value)) throw new Error('Invalid configured host identifier.'); return value; }
export function createEmbedURL(studioOrigin: string, gameId: string, options: { hostId?: string; channel?: string } = {}): string {
  const url = new URL(`/embed/games/${id(gameId)}`, integrationOrigin(studioOrigin));
  if (host(options.hostId)) url.searchParams.set('host', options.hostId!);
  if (options.channel !== undefined) { if (!channelId.test(options.channel)) throw new Error('Invalid integration channel.'); url.searchParams.set('channel', options.channel); }
  return url.href;
}
export function createCreatorURL(studioOrigin: string, options: { hostId?: string; gameId?: string; autoLogin?: boolean } = {}): string {
  const url = new URL('/game-studio', integrationOrigin(studioOrigin));
  if (host(options.hostId)) url.searchParams.set('host', options.hostId!);
  if (options.gameId) url.searchParams.set('game', id(options.gameId));
  if (options.autoLogin !== undefined && typeof options.autoLogin !== 'boolean') throw new Error('Automatic sign-in must be a boolean.');
  if (options.autoLogin) {
    if (!options.hostId) throw new Error('Automatic sign-in requires a configured host identifier.');
    url.searchParams.set('login', 'auto');
  }
  return url.href;
}
export function createHostSelectionURL(hostOrigin: string, returnPath: string, studioOrigin: string, gameId: string, publishedRevision: number): string {
  if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(returnPath) || returnPath.split('/').some(part=>part==='.'||part==='..')) throw new Error('Use a configured same-origin return path.');
  if (!Number.isSafeInteger(publishedRevision) || publishedRevision < 1) throw new Error('Choose a published game edition.');
  const url=new URL(returnPath,integrationOrigin(hostOrigin));
  url.searchParams.set('gameStudioOrigin',integrationOrigin(studioOrigin));
  url.searchParams.set('gameStudioGameId',id(gameId));
  url.searchParams.set('gameStudioRevision',String(publishedRevision));
  return url.href;
}
/** Selection is public navigation data. The host must validate the current publication before saving it. */
export function readGameSelection(locationURL: string, expectedStudioOrigin: string): {gameId:string;publishedRevision:number} | undefined {
  const query=new URL(locationURL).searchParams;
  if(query.getAll('gameStudioOrigin').length!==1 || query.getAll('gameStudioGameId').length!==1 || query.getAll('gameStudioRevision').length!==1 || query.get('gameStudioOrigin')!==integrationOrigin(expectedStudioOrigin)) return;
  const gameId=query.get('gameStudioGameId')||'', revision=query.get('gameStudioRevision')||'';
  if(!uuid.test(gameId)||!/^[1-9][0-9]{0,9}$/.test(revision)||!Number.isSafeInteger(Number(revision)))return;
  return {gameId,publishedRevision:Number(revision)};
}
export type CompletionResult = { outcome: 'won' | 'lost'; elapsed: number; score: number; points?: number; reviewedLevelIds: string[] };
export type GameStudioEvent = { version: 1; source: 'nce-game-studio'; channel: string; type: 'ready' | 'completed'; gameId: string; publishedRevision?: number; result?: CompletionResult };
export function parseGameStudioEvent(value: unknown): GameStudioEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['version', 'source', 'channel', 'type', 'gameId', 'publishedRevision', 'result'].includes(k)) || v.version !== 1 || v.source !== 'nce-game-studio' || typeof v.channel !== 'string' || !channelId.test(v.channel) || typeof v.gameId !== 'string' || !uuid.test(v.gameId) || !['ready', 'completed'].includes(String(v.type))) return;
  if (v.type === 'ready' && (v.result !== undefined || v.publishedRevision !== undefined)) return;
  if (v.type === 'completed') {
    if (!Number.isSafeInteger(v.publishedRevision) || Number(v.publishedRevision) < 1 || !v.result || typeof v.result !== 'object' || Array.isArray(v.result)) return;
    const r = v.result as Record<string, unknown>;
    if (Object.keys(r).some(k => !['outcome', 'elapsed', 'score', 'points', 'reviewedLevelIds'].includes(k)) || !['won', 'lost'].includes(String(r.outcome)) || typeof r.elapsed !== 'number' || !Number.isFinite(r.elapsed) || r.elapsed < 0 || r.elapsed > 86400 || !Number.isSafeInteger(r.score) || Number(r.score) < 0 || Number(r.score) > 320 || (r.points !== undefined && (!Number.isSafeInteger(r.points) || Number(r.points) < 0 || Number(r.points) > 1000000)) || !Array.isArray(r.reviewedLevelIds) || r.reviewedLevelIds.length > 8 || r.reviewedLevelIds.some(x => typeof x !== 'string' || !/^level-[1-8]$/.test(x)) || new Set(r.reviewedLevelIds).size !== r.reviewedLevelIds.length) return;
  }
  return JSON.parse(JSON.stringify(v)) as GameStudioEvent;
}
/** Browser gameplay reports are advisory; never use them as proof of learning or a grade. */
export function mountGame(container: HTMLElement, options: { studioOrigin: string; gameId: string; hostId: string; title?: string; onEvent?: (event: GameStudioEvent) => void }) {
  const origin = integrationOrigin(options.studioOrigin), channel = crypto.randomUUID();
  const frame = document.createElement('iframe');
  frame.src = createEmbedURL(origin, options.gameId, { hostId: options.hostId, channel });
  frame.title = options.title || 'Game Studio game';
  frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox');
  frame.referrerPolicy = 'strict-origin';
  frame.style.cssText = 'width:100%;min-height:760px;border:0;border-radius:16px';
  const receive = (event: MessageEvent) => {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    const data = parseGameStudioEvent(event.data);
    if (data?.channel === channel && data.gameId === options.gameId) options.onEvent?.(data);
  };
  window.addEventListener('message', receive); container.append(frame);
  return { iframe: frame, destroy() { window.removeEventListener('message', receive); frame.remove(); } };
}
/** Public catalog only. Private authoring uses Game Studio's own Core service audience. */
export async function listPublishedGames(apiOrigin: string, options: { signal?: AbortSignal } = {}): Promise<unknown[]> {
  const origin = integrationOrigin(apiOrigin), result: unknown[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const url = new URL('/games/published', origin);
    // Explicit opt-in keeps older arcade-only hosts on their supported schema.
    url.searchParams.set('specVersion', 'all');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: options.signal });
    if (!response.ok) throw new Error('The Game Studio catalog could not be opened.');
    const page = await response.json(); if (!page || !Array.isArray(page.games) || (page.cursor !== undefined && typeof page.cursor !== 'string')) throw new Error('Invalid game catalog response.');
    result.push(...page.games); cursor = page.cursor;
    if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('The game catalog exceeded its pagination limit.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}
