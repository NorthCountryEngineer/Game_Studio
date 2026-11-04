import catalog from '../../config/party-games.json';
import { coreConfig, isCore } from './core';
import { MAFIA_AVATARS, type MafiaAvatar, validateMafiaName } from './mafia';
import { normalizeRoomPassphrase } from './room-passphrases';

export type PartyKind = 'starship-suspects' | 'sketch-guess' | 'trivia' | 'hand-duel' | 'drop-four';
export type PartyCatalogEntry = { id: string; title: string; category: string; minPlayers: number; maxPlayers: number; symbol: string; description: string };
export const PARTY_GAMES: readonly PartyCatalogEntry[] = catalog.games;
export const partyGame = (kind: string) => PARTY_GAMES.find(game => game.id === kind);
export const isPartyKind = (kind: unknown): kind is PartyKind => typeof kind === 'string' && kind !== 'mafia' && PARTY_GAMES.some(game => game.id === kind);
export type PartyPlayer = { id: string; name: string; avatar: MafiaAvatar; score: number; alive?: boolean; left?: boolean; room?: string; role?: string; isAI?: boolean };
export type PartyMessage = { id: string; playerId?: string; text: string; at: number };
export type PartyRoom = {
  passphraseEnabled?: boolean;
  version: 1; roomId: string; kind: PartyKind; hostId: string; status: string; phase: string; phaseId: number; round: number; createdAt: number; deadlineAt: number | null;
  settings: Record<string, number>; players: PartyPlayer[]; winner: string | null; events: PartyMessage[]; chat: PartyMessage[];
  self: { id: string; isHost: boolean; actionSequence: number; left?: boolean; [key: string]: any };
  game: Record<string, any>;
};
export type PartySession = { roomId: string; playerId: string; token: string; inviteToken?: string };
export type PartyEnvelope = { room: PartyRoom; session?: PartySession };
export type PartyAction = { type: string; [key: string]: unknown };
export type PartyAdmission = { path: string; startedAt?: number; body: { requestId: string; name: string; avatar: MafiaAvatar; playerToken: string; inviteToken?: string; passphrase?: string; kind?: PartyKind; settings?: Record<string, number> } };
export type PartyPendingAction = PartyAction & { requestId: string; phaseId: number; sequence: number };
export type PartyRecognitionAck = { version: 1; roomId: string; phaseId: number; drawingEpoch: number; inkSha256: string; status: 'ready' | 'cached' | 'busy' | 'stale' | 'idle' | 'unavailable'; retryAfterMs: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const avatars = new Set<string>(MAFIA_AVATARS.map(([id]) => id));
const invalid = (): never => { throw new Error('The party room returned an unsupported response. Refresh and try again.'); };
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : invalid();
const integer = (v: unknown, low = 0, high = 2147483647): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= low && v <= high;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000000000;

/** Retain bounded JSON data only. Room projections already come from the server's fixed game engine. */
function data(value: unknown, depth = 0, count = { n: 0 }): any {
  if (++count.n > 40000 || depth > 9) invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > 100000000000) invalid(); return value; }
  if (typeof value === 'string') { if (!text(value, 2000)) invalid(); return value; }
  if (Array.isArray(value)) { if (value.length > 150) invalid(); return value.map(v => data(v, depth + 1, count)); }
  const o = object(value), entries = Object.entries(o);
  if (entries.length > 80) invalid();
  return Object.fromEntries(entries.map(([key, v]) => { if (!text(key, 100) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid(); return [key, data(v, depth + 1, count)]; }));
}
function messages(value: unknown): PartyMessage[] {
  if (!Array.isArray(value) || value.length > 150) invalid();
  return (value as unknown[]).map(item => { const m = object(item); if (!text(m.id, 100) || !m.id || !text(m.text, 1500) || !timestamp(m.at) || !(m.playerId === undefined || uuid(m.playerId))) invalid(); return { id: m.id, text: m.text, at: m.at, ...(m.playerId ? { playerId: m.playerId } : {}) }; });
}
function gameData(value: unknown, kind: PartyKind): Record<string, any> {
  const game = object(value);
  if (kind !== 'sketch-guess' || game.strokes === undefined) return data(game);
  const { strokes, ...other } = game;
  if (!Array.isArray(strokes) || strokes.length > 384) invalid();
  let points = 0;
  const ids = new Set<string>();
  const clean = strokes.map((value: unknown) => {
    const stroke = object(value);
    if (Object.keys(stroke).some(key => !['id', 'playerId', 'color', 'width', 'points'].includes(key)) ||
        !(uuid(stroke.id) || typeof stroke.id === 'string' && /^s\d{1,12}$/.test(stroke.id)) || ids.has(stroke.id) || !uuid(stroke.playerId) ||
        typeof stroke.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(stroke.color) || typeof stroke.width !== 'number' || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 12 ||
        !Array.isArray(stroke.points) || stroke.points.length < 1 || stroke.points.length > 120) invalid();
    ids.add(stroke.id);
    points += stroke.points.length;
    if (points > 8000) invalid();
    const geometry = stroke.points.map((point: unknown) => {
      if (!Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) invalid();
      const coordinates = point as [number, number];
      return [coordinates[0], coordinates[1]];
    });
    return { id: stroke.id, playerId: stroke.playerId, color: stroke.color, width: stroke.width, points: geometry };
  });
  if (!(game.drawingEpoch === undefined || integer(game.drawingEpoch)) ||
      !(game.drawingAckIds === undefined || Array.isArray(game.drawingAckIds) && game.drawingAckIds.length <= 128 && game.drawingAckIds.every(uuid) && new Set(game.drawingAckIds).size === game.drawingAckIds.length)) invalid();
  return { ...data(other), strokes: clean };
}
export function parsePartyRoom(value: unknown): PartyRoom {
  const r = object(value), self = object(r.self);
  if (!(r.passphraseEnabled === undefined || typeof r.passphraseEnabled === 'boolean')) invalid();
  if (r.version !== 1 || !uuid(r.roomId) || !isPartyKind(r.kind) || !uuid(r.hostId) || !['lobby', 'playing', 'finished', 'closed'].includes(r.status) || !text(r.phase, 40) || !r.phase || !integer(r.phaseId) || !integer(r.round) || !timestamp(r.createdAt) || !(r.deadlineAt === null || timestamp(r.deadlineAt)) || !(r.winner === null || text(r.winner, 100))) invalid();
  if (!Array.isArray(r.players) || r.players.length < 1 || r.players.length > 24) invalid();
  const players: PartyPlayer[] = r.players.map((value: unknown) => { const p = object(value); if (!uuid(p.id) || !text(p.name, 64) || validateMafiaName(p.name) !== p.name || !avatars.has(p.avatar) || !integer(p.score, -1000000, 1000000) || !(p.alive === undefined || typeof p.alive === 'boolean') || !(p.room === undefined || text(p.room, 40)) || !(p.role === undefined || text(p.role, 40)) || !(p.isAI === undefined || typeof p.isAI === 'boolean')) invalid(); return { id: p.id, name: p.name, avatar: p.avatar, score: p.score, ...(p.alive === undefined ? {} : { alive: p.alive }), ...(p.left === true ? { left: true } : {}), ...(p.room === undefined ? {} : { room: p.room }), ...(p.role === undefined ? {} : { role: p.role }), ...(p.isAI === undefined ? {} : { isAI: p.isAI }) }; });
  const ids = new Set(players.map(p => p.id));
  if (ids.size !== players.length || !ids.has(r.hostId) || !uuid(self.id) || !ids.has(self.id) || typeof self.isHost !== 'boolean' || !integer(self.actionSequence)) invalid();
  if (players.some(player => player.isAI && (player.id === r.hostId || player.id === self.id))) invalid();
  const settings = object(r.settings); if (Object.entries(settings).some(([key, value]) => !text(key, 40) || !integer(value, 0, 1000))) invalid();
  return { version: 1, roomId: r.roomId, kind: r.kind, hostId: r.hostId, status: r.status, phase: r.phase, phaseId: r.phaseId, round: r.round, createdAt: r.createdAt, deadlineAt: r.deadlineAt, settings: { ...settings }, players, winner: r.winner, events: messages(r.events), chat: messages(r.chat), self: data(self), game: gameData(r.game, r.kind), ...(r.passphraseEnabled === undefined ? {} : { passphraseEnabled: r.passphraseEnabled }) };
}
export function parsePartySession(value: unknown): PartySession {
  const s = object(value); if (!uuid(s.roomId) || !uuid(s.playerId) || typeof s.token !== 'string' || !CAPABILITY.test(s.token) || !(s.inviteToken === undefined || typeof s.inviteToken === 'string' && CAPABILITY.test(s.inviteToken))) invalid();
  return { roomId: s.roomId, playerId: s.playerId, token: s.token, ...(s.inviteToken ? { inviteToken: s.inviteToken } : {}) };
}
export function parsePartyEnvelope(value: unknown, sessionRequired = false): PartyEnvelope {
  const e = object(value), room = parsePartyRoom(e.room), session = e.session === undefined ? undefined : parsePartySession(e.session);
  if (sessionRequired && !session || session && (session.roomId !== room.roomId || session.playerId !== room.self.id)) invalid();
  return { room, ...(session ? { session } : {}) };
}
export function parsePartyRecognitionAck(value: unknown, expected: Pick<PartyRecognitionAck, 'roomId' | 'phaseId' | 'drawingEpoch' | 'inkSha256'>): PartyRecognitionAck {
  const ack = object(value), keys = ['version', 'roomId', 'phaseId', 'drawingEpoch', 'inkSha256', 'status', 'retryAfterMs'];
  if (Object.keys(ack).length !== keys.length || !keys.every(key => Object.hasOwn(ack, key)) || ack.version !== 1 || !uuid(ack.roomId) || !integer(ack.phaseId) || !integer(ack.drawingEpoch) || typeof ack.inkSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ack.inkSha256) || !['ready', 'cached', 'busy', 'stale', 'idle', 'unavailable'].includes(ack.status) || !(ack.retryAfterMs === 3000 || ack.status === 'unavailable' && ack.retryAfterMs === 10000) || ack.roomId !== expected.roomId || ack.phaseId !== expected.phaseId || ack.drawingEpoch !== expected.drawingEpoch || ack.inkSha256 !== expected.inkSha256) invalid();
  return { version: 1, roomId: ack.roomId, phaseId: ack.phaseId, drawingEpoch: ack.drawingEpoch, inkSha256: ack.inkSha256, status: ack.status, retryAfterMs: ack.retryAfterMs };
}
export function createPartySecret(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export function readPartySession(roomId: string, storage: Pick<Storage, 'getItem'> = localStorage): PartySession | undefined { if (!UUID.test(roomId)) return; try { const raw = storage.getItem(`game-studio-party-seat-v1:${roomId}`); if (!raw || raw.length > 1500) return; const s = parsePartySession(JSON.parse(raw)); return s.roomId === roomId ? s : undefined; } catch { return; } }
export function savePartySession(session: PartySession, storage: Pick<Storage, 'setItem'> = localStorage) { const s = parsePartySession(session); storage.setItem(`game-studio-party-seat-v1:${s.roomId}`, JSON.stringify(s)); }
export function forgetPartySession(roomId: string, storage: Pick<Storage, 'removeItem'> = localStorage) { if (UUID.test(roomId)) storage.removeItem(`game-studio-party-seat-v1:${roomId}`); }
export function partyInvitation(origin: string, session: PartySession): string { const s = parsePartySession(session), url = new URL(origin); if (!s.inviteToken || url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('This seat cannot create an invitation.'); return `${origin}/party/rooms/${s.roomId}#join=${s.inviteToken}`; }
export function parsePartyInvitation(value: string, origin: string): { roomId: string; inviteToken: string } | undefined { try { const url = new URL(value, origin), path = /^\/party\/rooms\/([0-9a-f-]{36})$/.exec(url.pathname), entries = [...new URLSearchParams(url.hash.slice(1))]; if (url.origin !== origin || url.search || !path || !UUID.test(path[1]) || entries.length !== 1 || entries[0][0] !== 'join' || !CAPABILITY.test(entries[0][1])) return; return { roomId: path[1], inviteToken: entries[0][1] }; } catch { return; } }
export function parsePartyAdmission(value: unknown): PartyAdmission {
  const a = object(value), b = object(a.body); if (typeof a.path !== 'string' || !/^\/party(?:\/join-by-passphrase|\/rooms(?:\/[0-9a-f-]{36}\/join)?)$/.test(a.path) || !uuid(b.requestId) || typeof b.name !== 'string' || validateMafiaName(b.name) !== b.name || !avatars.has(b.avatar) || typeof b.playerToken !== 'string' || !CAPABILITY.test(b.playerToken)) invalid();
  const create = a.path === '/party/rooms', phraseJoin = a.path === '/party/join-by-passphrase'; if ((create || phraseJoin) && !isPartyKind(b.kind)) invalid();
  if (phraseJoin ? b.inviteToken !== undefined || typeof b.passphrase !== 'string' : typeof b.inviteToken !== 'string' || !CAPABILITY.test(b.inviteToken)) invalid();
  if (b.passphrase !== undefined && (!create && !phraseJoin || typeof b.passphrase !== 'string' || normalizeRoomPassphrase(b.passphrase) !== b.passphrase)) invalid();
  let settings: Record<string, number> | undefined; if (create && b.settings !== undefined) { settings = object(b.settings); if (Object.entries(settings).some(([key, value]) => !text(key, 40) || !integer(value, 0, 1000))) invalid(); }
  return { path: a.path, body: { requestId: b.requestId, name: b.name, avatar: b.avatar, playerToken: b.playerToken, ...(!phraseJoin ? { inviteToken: b.inviteToken } : {}), ...(b.passphrase === undefined ? {} : { passphrase: b.passphrase }), ...(create || phraseJoin ? { kind: b.kind } : {}), ...(settings ? { settings: { ...settings } } : {}) } };
}
const admissionKey = (key: string) => isPartyKind(key) || UUID.test(key) ? `game-studio-party-admission-v1:${key}` : invalid();
export function readPartyAdmission(key: string, storage: Pick<Storage, 'getItem'> = localStorage): PartyAdmission | undefined { try { const raw = storage.getItem(admissionKey(key)); if (!raw || raw.length > 3000) return; const a = parsePartyAdmission(JSON.parse(raw)); if (a.body.passphrase === undefined && a.path === (isPartyKind(key) ? '/party/rooms' : `/party/rooms/${key}/join`) && (!isPartyKind(key) || a.body.kind === key)) return a; } catch { return; } }
export function savePartyAdmission(key: string, value: PartyAdmission, storage: Pick<Storage, 'setItem'> = localStorage) { const a = parsePartyAdmission(value); if (a.body.passphrase !== undefined) throw new Error('Passphrase requests stay in this tab until your seat is confirmed.'); if (a.path !== (isPartyKind(key) ? '/party/rooms' : `/party/rooms/${key}/join`) || isPartyKind(key) && a.body.kind !== key) invalid(); storage.setItem(admissionKey(key), JSON.stringify(a)); }
export function clearPartyAdmission(key: string, storage: Pick<Storage, 'removeItem'> = localStorage) { storage.removeItem(admissionKey(key)); }
export function partyAPIBase(): string { if (!isCore) return '/party-api'; if (!coreConfig) throw new Error('The live game service is not configured.'); const url = new URL(coreConfig.api_url); if (url.protocol !== 'https:' || url.origin !== coreConfig.api_url) throw new Error('The live game service is not configured.'); return url.origin; }
export class PartyAPIError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function partyRequest(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, token?: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^\/party(?:\/config|\/join-by-passphrase|\/rooms(?:\/[0-9a-f-]{36}(?:\/join|\/actions|\/recognition)?)?)$/.test(path)) throw new Error('Choose a valid party-game request.'); if (token !== undefined && !CAPABILITY.test(token)) throw new Error('This room seat is invalid. Open its invitation again.');
  if (path.endsWith('/recognition') && (method !== 'POST' || token === undefined)) throw new Error('Choose a valid party-game recognition request.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
  try { const response = await fetch(partyAPIBase() + path, { method, ...(path.endsWith('/recognition') ? { priority: 'low' as const } : {}), credentials: 'omit', redirect: 'error', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal }); let value: unknown; try { value = await response.json(); } catch { throw new PartyAPIError('The game service could not be reached. Try again shortly.', response.status); } if (!response.ok) { const error = value && typeof value === 'object' && 'error' in value ? (value as { error: unknown }).error : undefined; throw new PartyAPIError(typeof error === 'string' && error.length < 500 ? error : 'The room request could not be completed. Try again shortly.', response.status); } return value; }
  catch (error) { if (controller.signal.aborted && !signal?.aborted) throw new PartyAPIError('The room is taking longer than usual. Your seat is saved; try again.', 408); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
