import { coreConfig, isCore } from './core';

export const MAFIA_AVATARS = [
  ['fox', '🦊', 'Fox'], ['bear', '🐻', 'Bear'], ['cat', '🐱', 'Cat'], ['dog', '🐶', 'Dog'],
  ['rabbit', '🐰', 'Rabbit'], ['panda', '🐼', 'Panda'], ['tiger', '🐯', 'Tiger'], ['lion', '🦁', 'Lion'],
  ['frog', '🐸', 'Frog'], ['owl', '🦉', 'Owl'], ['koala', '🐨', 'Koala'], ['unicorn', '🦄', 'Unicorn'],
  ['dragon', '🐲', 'Dragon'], ['robot', '🤖', 'Robot'], ['alien', '👽', 'Alien'], ['ghost', '👻', 'Ghost'],
  ['octopus', '🐙', 'Octopus'], ['penguin', '🐧', 'Penguin'], ['monkey', '🐵', 'Monkey'], ['butterfly', '🦋', 'Butterfly'],
] as const;
export type MafiaAvatar = typeof MAFIA_AVATARS[number][0];
export type MafiaRole = 'mafia' | 'detective' | 'doctor' | 'civilian';
export type MafiaPhase = 'lobby' | 'night' | 'discussion' | 'voting' | 'finished' | 'closed';
export type MafiaSettings = { maxPlayers: number; nightSeconds: number; discussionSeconds: number; votingSeconds: number };
export type MafiaPlayer = { id: string; name: string; avatar: MafiaAvatar; alive: boolean; left?: boolean; isNarrator: boolean; role?: MafiaRole };
export type MafiaEvent = { id: string; kind: string; text: string; at: number; day: number };
export type MafiaChat = { id: string; playerId: string; text: string; at: number; day: number };
export type MafiaRoom = {
  version: 1; roomId: string; phase: MafiaPhase; phaseId: number; day: number; ownerId: string; narratorId: string | null; narratorMode: 'human' | 'ai';
  settings: MafiaSettings; createdAt: number; deadlineAt: number | null; winner: 'town' | 'mafia' | null; players: MafiaPlayer[];
  self: { id: string; actionSequence: number; role: MafiaRole | null; alive: boolean; left?: boolean; isOwner: boolean; isNarrator: boolean; nightTargetId: string | null; voteTargetId: string | null; hasVoted: boolean; ready: boolean; checks: { day: number; targetId: string; isMafia: boolean }[]; allies: string[] };
  events: MafiaEvent[]; chat: MafiaChat[]; mafiaChat: MafiaChat[];
  narratorInfo?: { roles: { playerId: string; role: MafiaRole }[]; nightActions: Record<string, string>; readyToAdvance: boolean; submitted: number; required: number };
};
export type MafiaSession = { roomId: string; playerId: string; token: string; inviteToken?: string };
export type MafiaEnvelope = { room: MafiaRoom; session?: MafiaSession };
export type MafiaConfig = { aiAvailable: boolean; aiLabel?: string; minPlayers: number; maxPlayers: number };
export type MafiaAction = { type: string; targetId?: string; text?: string; channel?: 'public' | 'mafia'; force?: boolean; settings?: Partial<MafiaSettings>; narratorMode?: 'human' | 'ai' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{24,256}$/;
const roles = ['mafia', 'detective', 'doctor', 'civilian'];
const phases = ['lobby', 'night', 'discussion', 'voting', 'finished', 'closed'];
const avatars = new Set<string>(MAFIA_AVATARS.map(([id]) => id));
const invalid = () => { throw new Error('The live room returned an unsupported response. Refresh the room and try again.'); };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : invalid();
const integer = (value: unknown, low = 0, high = 2147483647): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000000000;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const role = (value: unknown): value is MafiaRole => typeof value === 'string' && roles.includes(value);
const target = (value: unknown, skip = false): value is string | null => value === null || uuid(value) || skip && value === 'skip';

export function validateMafiaName(value: string): string {
  const name = value.normalize('NFC').trim();
  if ([...name].length < 1 || [...name].length > 16 || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value) || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(name)) throw new Error('Choose a name with 1–16 visible characters.');
  return name;
}
export function avatarFor(value: string): typeof MAFIA_AVATARS[number] { return MAFIA_AVATARS.find(([id]) => id === value) ?? MAFIA_AVATARS[0]; }
export function parseMafiaSettings(value: unknown): MafiaSettings {
  const s = object(value);
  if (!integer(s.maxPlayers, 5, 24) || !integer(s.nightSeconds, 30, 300) || !integer(s.discussionSeconds, 30, 300) || !integer(s.votingSeconds, 30, 300)) invalid();
  return { maxPlayers: s.maxPlayers, nightSeconds: s.nightSeconds, discussionSeconds: s.discussionSeconds, votingSeconds: s.votingSeconds };
}
export function parseMafiaRoom(value: unknown): MafiaRoom {
  const r = object(value), self = object(r.self);
  if (r.version !== 1 || !uuid(r.roomId) || !phases.includes(r.phase) || !integer(r.phaseId) || !integer(r.day, 0, 2147483647) || !uuid(r.ownerId) || !target(r.narratorId) || !['human', 'ai'].includes(r.narratorMode) || !timestamp(r.createdAt) || !(r.deadlineAt === null || timestamp(r.deadlineAt)) || ![null, 'town', 'mafia'].includes(r.winner)) invalid();
  if (!Array.isArray(r.players) || r.players.length > 25 || r.players.length < 1) invalid();
  const players: MafiaPlayer[] = r.players.map((value: unknown) => {
    const p = object(value);
    if (!uuid(p.id) || !text(p.name, 64) || [...p.name].length < 1 || [...p.name].length > 16 || !avatars.has(p.avatar) || typeof p.alive !== 'boolean' || typeof p.isNarrator !== 'boolean' || !(p.role === undefined || role(p.role))) invalid();
    return { id: p.id, name: p.name, avatar: p.avatar, alive: p.alive, ...(p.left === true ? { left: true } : {}), isNarrator: p.isNarrator, ...(p.role === undefined ? {} : { role: p.role }) };
  });
  const ids = new Set(players.map(p => p.id));
  if (ids.size !== players.length || !ids.has(r.ownerId) || r.narratorId !== null && !ids.has(r.narratorId) || !uuid(self.id) || !ids.has(self.id) || !integer(self.actionSequence) || !(self.role === null || role(self.role)) || [self.alive, self.isOwner, self.isNarrator, self.hasVoted, self.ready].some(v => typeof v !== 'boolean') || !target(self.nightTargetId) || !target(self.voteTargetId, true)) invalid();
  if (!Array.isArray(self.checks) || self.checks.length > 100 || !Array.isArray(self.allies) || self.allies.length > 24 || self.allies.some((id: unknown) => !uuid(id) || !ids.has(id))) invalid();
  const checks = self.checks.map((value: unknown) => { const c = object(value); if (!integer(c.day, 0, 2147483647) || !uuid(c.targetId) || !ids.has(c.targetId) || typeof c.isMafia !== 'boolean') invalid(); return { day: c.day, targetId: c.targetId, isMafia: c.isMafia }; });
  function messages(values: unknown, narration: boolean): (MafiaEvent | MafiaChat)[] {
    if (!Array.isArray(values) || values.length > 150) invalid();
    return (values as unknown[]).map(value => {
      const m = object(value);
      if (!text(m.id, 100) || !m.id || !text(m.text, 1500) || !timestamp(m.at) || !integer(m.day, 0, 2147483647)) invalid();
      if (narration) { if (!text(m.kind, 80)) invalid(); return { id: m.id, kind: m.kind, text: m.text, at: m.at, day: m.day }; }
      // Lobby removals can leave a valid historical author outside the current cast.
      if (!uuid(m.playerId)) invalid();
      return { id: m.id, playerId: m.playerId, text: m.text, at: m.at, day: m.day };
    });
  }
  let narratorInfo: MafiaRoom['narratorInfo'];
  if (r.narratorInfo !== undefined) {
    const n = object(r.narratorInfo), actions = object(n.nightActions);
    if (!self.isNarrator || !Array.isArray(n.roles) || n.roles.length > 24 || typeof n.readyToAdvance !== 'boolean' || !integer(n.submitted, 0, 24) || !integer(n.required, 0, 24) || Object.entries(actions).some(([id, targetId]) => !ids.has(id) || !uuid(targetId) || !ids.has(targetId))) invalid();
    narratorInfo = { roles: n.roles.map((value: unknown) => { const item = object(value); if (!uuid(item.playerId) || !ids.has(item.playerId) || !role(item.role)) invalid(); return { playerId: item.playerId, role: item.role }; }), nightActions: { ...actions }, readyToAdvance: n.readyToAdvance, submitted: n.submitted, required: n.required };
  }
  return { version: 1, roomId: r.roomId, phase: r.phase, phaseId: r.phaseId, day: r.day, ownerId: r.ownerId, narratorId: r.narratorId, narratorMode: r.narratorMode, settings: parseMafiaSettings(r.settings), createdAt: r.createdAt, deadlineAt: r.deadlineAt, winner: r.winner, players,
    self: { id: self.id, actionSequence: self.actionSequence, role: self.role, alive: self.alive, ...(self.left === true ? { left: true } : {}), isOwner: self.isOwner, isNarrator: self.isNarrator, nightTargetId: self.nightTargetId, voteTargetId: self.voteTargetId, hasVoted: self.hasVoted, ready: self.ready, checks, allies: [...self.allies] },
    events: messages(r.events, true) as MafiaEvent[], chat: messages(r.chat, false) as MafiaChat[], mafiaChat: messages(r.mafiaChat, false) as MafiaChat[], ...(narratorInfo ? { narratorInfo } : {}) };
}
export function parseMafiaSession(value: unknown): MafiaSession {
  const s = object(value);
  if (!uuid(s.roomId) || !uuid(s.playerId) || typeof s.token !== 'string' || !CAPABILITY.test(s.token) || !(s.inviteToken === undefined || typeof s.inviteToken === 'string' && CAPABILITY.test(s.inviteToken))) invalid();
  return { roomId: s.roomId, playerId: s.playerId, token: s.token, ...(s.inviteToken ? { inviteToken: s.inviteToken } : {}) };
}
export function parseMafiaEnvelope(value: unknown, sessionRequired = false): MafiaEnvelope {
  const envelope = object(value), room = parseMafiaRoom(envelope.room);
  const session = envelope.session === undefined ? undefined : parseMafiaSession(envelope.session);
  if (sessionRequired && !session || session && (session.roomId !== room.roomId || session.playerId !== room.self.id)) invalid();
  return { room, ...(session ? { session } : {}) };
}
export function parseMafiaConfig(value: unknown): MafiaConfig {
  const c = object(value);
  if (typeof c.aiAvailable !== 'boolean' || c.aiLabel !== undefined && !text(c.aiLabel, 100)) invalid();
  return { aiAvailable: c.aiAvailable, ...(c.aiLabel ? { aiLabel: c.aiLabel } : {}), minPlayers: integer(c.minPlayers, 5, 5) ? c.minPlayers : 5, maxPlayers: integer(c.maxPlayers, 5, 24) ? c.maxPlayers : 24 };
}
export function readMafiaSession(roomId: string, storage: Pick<Storage, 'getItem'> = localStorage): MafiaSession | undefined {
  if (!UUID.test(roomId)) return;
  try { const value = storage.getItem(`game-studio-mafia-seat-v1:${roomId}`); if (!value) return; const s = parseMafiaSession(JSON.parse(value)); return s.roomId === roomId ? s : undefined; } catch { return undefined; }
}
export function saveMafiaSession(session: MafiaSession, storage: Pick<Storage, 'setItem'> = localStorage): void { const s = parseMafiaSession(session); storage.setItem(`game-studio-mafia-seat-v1:${s.roomId}`, JSON.stringify(s)); }
export function forgetMafiaSession(roomId: string, storage: Pick<Storage, 'removeItem'> = localStorage): void { if (UUID.test(roomId)) storage.removeItem(`game-studio-mafia-seat-v1:${roomId}`); }
export function mafiaInvitation(origin: string, session: MafiaSession): string {
  const s = parseMafiaSession(session), url = new URL(origin);
  if (!s.inviteToken || url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('This seat cannot create an invitation.');
  return `${origin}/mafia/${s.roomId}#join=${s.inviteToken}`;
}
export function parseMafiaInvitation(value: string, origin: string): { roomId: string; inviteToken: string } | undefined {
  try {
    const url = new URL(value, origin), path = /^\/mafia\/([0-9a-f-]{36})$/.exec(url.pathname), params = new URLSearchParams(url.hash.slice(1)), entries = [...params];
    if (url.origin !== origin || url.search || !path || !UUID.test(path[1]) || entries.length !== 1 || entries[0][0] !== 'join' || !CAPABILITY.test(entries[0][1])) return;
    return { roomId: path[1], inviteToken: entries[0][1] };
  } catch { return undefined; }
}
export function mafiaAPIBase(): string {
  if (!isCore) return '/mafia-api';
  if (!coreConfig) throw new Error('The live game service is not configured.');
  const url = new URL(coreConfig.api_url);
  if (url.protocol !== 'https:' || url.origin !== coreConfig.api_url) throw new Error('The live game service is not configured.');
  return url.origin;
}
export class MafiaAPIError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function mafiaRequest(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, token?: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^\/mafia(?:\/config|\/rooms(?:\/[0-9a-f-]{36}(?:\/join|\/actions)?)?)$/.test(path)) throw new Error('Choose a valid live Mafia request.');
  if (token !== undefined && !CAPABILITY.test(token)) throw new Error('This room seat is invalid. Open its invitation again.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(mafiaAPIBase() + path, { method, credentials: 'omit', redirect: 'error', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
    let value: unknown;
    try { value = await response.json(); } catch { throw new MafiaAPIError('The live game service could not be reached. Try again shortly.', response.status); }
    if (!response.ok) { const error = value && typeof value === 'object' && 'error' in value ? (value as { error: unknown }).error : undefined; throw new MafiaAPIError(typeof error === 'string' && error.length < 500 ? error : 'The room request could not be completed. Try again shortly.', response.status); }
    return value;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new MafiaAPIError('The room is taking longer than usual. Your seat is saved; try again.', 408);
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export type MafiaAdmission = { path: string; body: { requestId: string; name: string; avatar: MafiaAvatar; playerToken: string; inviteToken: string; maxPlayers?: number; narratorMode?: 'human' | 'ai'; nightSeconds?: number; discussionSeconds?: number; votingSeconds?: number } };
export function createMafiaSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function parseMafiaAdmission(value: unknown): MafiaAdmission {
  const a = object(value), body = object(a.body);
  if (typeof a.path !== 'string' || !/^\/mafia\/rooms(?:\/[0-9a-f-]{36}\/join)?$/.test(a.path) || !uuid(body.requestId) || typeof body.name !== 'string' || validateMafiaName(body.name) !== body.name || !avatars.has(body.avatar) || typeof body.playerToken !== 'string' || !CAPABILITY.test(body.playerToken) || typeof body.inviteToken !== 'string' || !CAPABILITY.test(body.inviteToken)) invalid();
  const create = a.path === '/mafia/rooms';
  if (create && !['human', 'ai'].includes(body.narratorMode)) invalid();
  const settings = create ? parseMafiaSettings(body) : undefined;
  return { path: a.path, body: { requestId: body.requestId, name: body.name, avatar: body.avatar, playerToken: body.playerToken, inviteToken: body.inviteToken, ...(create ? { ...settings, narratorMode: body.narratorMode } : {}) } };
}
export function readMafiaAdmission(key: string, storage: Pick<Storage, 'getItem'> = localStorage): MafiaAdmission | undefined {
  if (key !== 'create' && !UUID.test(key)) return;
  try { const raw = storage.getItem(`game-studio-mafia-admission-v1:${key}`); if (!raw || raw.length >= 3000) return; const admission = parseMafiaAdmission(JSON.parse(raw)); return admission.path === (key === 'create' ? '/mafia/rooms' : `/mafia/rooms/${key}/join`) ? admission : undefined; } catch { return undefined; }
}
export function saveMafiaAdmission(key: string, admission: MafiaAdmission, storage: Pick<Storage, 'setItem'> = localStorage): void { if (key !== 'create' && !UUID.test(key) || admission.path !== (key === 'create' ? '/mafia/rooms' : `/mafia/rooms/${key}/join`)) invalid(); storage.setItem(`game-studio-mafia-admission-v1:${key}`, JSON.stringify(parseMafiaAdmission(admission))); }
export function clearMafiaAdmission(key: string, storage: Pick<Storage, 'removeItem'> = localStorage): void { if (key === 'create' || UUID.test(key)) storage.removeItem(`game-studio-mafia-admission-v1:${key}`); }
