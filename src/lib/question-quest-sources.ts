import { QUESTION_QUEST_STORAGE_KEY, createQuestionQuest, upsertQuestQuestion, type QuestQuestionInput, type QuestState } from './question-quest';

export type QuestQuestionSource = { url: string; citation: string; explanation?: string };
export type QuestQuestionSources = Record<string, QuestQuestionSource>;
export type QuestQuestionSourceLoad = { status: 'ready' | 'empty' | 'invalid' | 'unavailable'; sources: QuestQuestionSources };
export const QUESTION_QUEST_SOURCES_STORAGE_KEY = `${QUESTION_QUEST_STORAGE_KEY}:sources:v1`;
export const QUEST_QUESTION_SOURCES_STORAGE_KEY = QUESTION_QUEST_SOURCES_STORAGE_KEY;
export const QUEST_SOURCE_MAX_URL_LENGTH = 2048;
export const QUEST_SOURCE_MAX_CITATION_LENGTH = 1000;
export const QUEST_SOURCE_MAX_EXPLANATION_LENGTH = 1000;
export const QUEST_SOURCES_MAX_BYTES = 512 * 1024;
const KEY_MAX_LENGTH = 4096;
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function fail(message = 'The question sources could not be read. Your questions and progress have not been changed.'): never { throw new Error(message); }
function plain(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || UNPRINTABLE.test(value)) fail(`${label} must be plain text on one line.`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || [...normalized].length > limit) fail(`${label} must contain between 1 and ${limit} printable characters.`);
  return normalized;
}

/** A source is inert text and an explicit HTTPS link; never executable content. */
export function parseQuestQuestionSource(value: unknown): QuestQuestionSource {
  const source = object(value);
  if (!source || !exact(source, Object.hasOwn(source, 'explanation') ? ['url', 'citation', 'explanation'] : ['url', 'citation'])) fail('A source needs a URL and citation, with an optional explanation.');
  const rawUrl = plain(source.url, 'Source URL', QUEST_SOURCE_MAX_URL_LENGTH);
  if (!/^https:\/\//i.test(rawUrl) || /[\s\\]/u.test(rawUrl)) fail('Use a complete HTTPS source URL without credentials or control characters.');
  try { if (UNPRINTABLE.test(decodeURIComponent(rawUrl))) fail('Use a complete HTTPS source URL without credentials or control characters.'); }
  catch { fail('Use a complete HTTPS source URL without credentials or control characters.'); }
  let url: URL;
  try { url = new URL(rawUrl); } catch { fail('Use a complete HTTPS source URL.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /^https:\/\/[^/]*@/i.test(rawUrl) || url.href.length > QUEST_SOURCE_MAX_URL_LENGTH) fail('Use a complete HTTPS source URL without credentials or control characters.');
  const citation = plain(source.citation, 'Source citation', QUEST_SOURCE_MAX_CITATION_LENGTH);
  const explanation = Object.hasOwn(source, 'explanation') ? plain(source.explanation, 'Source explanation', QUEST_SOURCE_MAX_EXPLANATION_LENGTH) : undefined;
  return { url: url.href, citation, ...(explanation === undefined ? {} : { explanation }) };
}

/** Full normalized content, rather than a short hash, prevents source collisions. */
export function questionSourceKey(input: QuestQuestionInput): string {
  const q = upsertQuestQuestion(createQuestionQuest('source-key'), { id: 'source-card', prompt: input.prompt, choices: input.choices, correctIndex: input.correctIndex }).questions[0];
  return JSON.stringify([q.prompt, q.choices, q.correctIndex]);
}

/** Companion metadata never changes the existing version 1 game save. */
export function loadQuestQuestionSources(storage: Pick<Storage, 'getItem'>, state: QuestState): QuestQuestionSourceLoad {
  let raw: string | null;
  try { raw = storage.getItem(QUESTION_QUEST_SOURCES_STORAGE_KEY); } catch { return { status: 'unavailable', sources: {} }; }
  if (raw === null) return { status: 'empty', sources: {} };
  try {
    if (typeof raw !== 'string' || raw.length > QUEST_SOURCES_MAX_BYTES || new TextEncoder().encode(raw).byteLength > QUEST_SOURCES_MAX_BYTES) fail();
    const data = object(JSON.parse(raw));
    if (!data || !exact(data, ['version', 'gameId', 'sources']) || data.version !== 1 || typeof data.gameId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.gameId) || !Array.isArray(data.sources) || data.sources.length > 100) fail();
    if (data.gameId !== state.id) return { status: 'empty', sources: {} };
    const allowed = new Set(state.questions.map(questionSourceKey)), seen = new Set<string>(), sources: QuestQuestionSources = {};
    for (const rawEntry of data.sources) {
      const entry = object(rawEntry);
      if (!entry || !exact(entry, ['key', 'source']) || typeof entry.key !== 'string' || entry.key.length > KEY_MAX_LENGTH || seen.has(entry.key)) fail();
      seen.add(entry.key);
      const source = parseQuestQuestionSource(entry.source);
      if (allowed.has(entry.key)) sources[entry.key] = source;
    }
    return { status: 'ready', sources };
  } catch { return { status: 'invalid', sources: {} }; }
}

/** Save only sources still bound to exact cards in this game, in a separate key. */
export function saveQuestQuestionSources(storage: Pick<Storage, 'setItem'>, state: QuestState, sources: QuestQuestionSources): void {
  if (typeof state.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(state.id) || !Array.isArray(state.questions) || state.questions.length > 100) fail();
  const allowed = new Set(state.questions.map(questionSourceKey));
  if (!object(sources)) fail();
  const entries = [...allowed].filter(key => Object.hasOwn(sources, key)).map(key => ({ key, source: parseQuestQuestionSource(sources[key]) }));
  const raw = JSON.stringify({ version: 1, gameId: state.id, sources: entries });
  if (new TextEncoder().encode(raw).byteLength > QUEST_SOURCES_MAX_BYTES) fail('The question sources are too large to save. The questions remain unchanged.');
  storage.setItem(QUESTION_QUEST_SOURCES_STORAGE_KEY, raw);
}
