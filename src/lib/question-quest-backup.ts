import { QUESTION_QUEST_STORAGE_KEY, parseQuestionQuest, serializeQuestionQuest, type QuestState } from './question-quest';
import { QUEST_QUESTION_SOURCES_STORAGE_KEY, parseQuestQuestionSource, questionSourceKey, saveQuestQuestionSources, type QuestQuestionSources } from './question-quest-sources';

export const QUEST_GAME_BACKUP_MAX_BYTES = 1024 * 1024;
export type QuestGameBackup = { state: QuestState; sources: QuestQuestionSources };
const FORMAT = 'game-studio-health-backup';
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function fail(message = 'This is not a valid health game backup. Your current game has not been changed.'): never { throw new Error(message); }
function uniqueFields(text: string) {
  const stack: { object: boolean; key: boolean; names: Set<string> }[] = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const value = token[0], current = stack.at(-1);
    if (value === '{' || value === '[') { if (stack.length >= 12) fail(); stack.push({ object: value === '{', key: value === '{', names: new Set() }); }
    else if (value === '}' || value === ']') stack.pop();
    else if (value === ',' && current?.object) current.key = true;
    else if (value.startsWith('"') && current?.object && current.key) { const name = JSON.parse(value); if (current.names.has(name)) fail('A backup field is repeated. Your current game has not been changed.'); current.names.add(name); current.key = false; }
  }
}
function normalized(stateValue: unknown, sourceValue: unknown): QuestGameBackup {
  const state = parseQuestionQuest(stateValue); serializeQuestionQuest(state);
  if (!Array.isArray(sourceValue) || sourceValue.length > 100) fail();
  const allowed = new Set(state.questions.map(questionSourceKey)), sources: QuestQuestionSources = {};
  for (const raw of sourceValue) {
    const entry = object(raw);
    if (!entry || !exact(entry, ['key', 'source']) || typeof entry.key !== 'string' || !allowed.has(entry.key) || Object.hasOwn(sources, entry.key)) fail('A backup source does not match an exact question and answer. Your current game has not been changed.');
    sources[entry.key] = parseQuestQuestionSource(entry.source);
  }
  // Enforce the existing companion-storage bounds as well as the file limit.
  saveQuestQuestionSources({ setItem() {} }, state, sources);
  return { state, sources };
}
export function serializeQuestGameBackup(stateValue: QuestState, sourceValue: QuestQuestionSources): string {
  const state = parseQuestionQuest(stateValue), allowed = [...new Set(state.questions.map(questionSourceKey))];
  if (!object(sourceValue) || Object.keys(sourceValue).some(key => !allowed.includes(key))) fail();
  const entries = allowed.filter(key => Object.hasOwn(sourceValue, key)).map(key => ({ key, source: sourceValue[key] }));
  const backup = normalized(state, entries), raw = JSON.stringify({ format: FORMAT, version: 1, state: backup.state, sources: entries.map(entry => ({ key: entry.key, source: backup.sources[entry.key] })) }, null, 2);
  if (new TextEncoder().encode(raw).byteLength > QUEST_GAME_BACKUP_MAX_BYTES) fail('This game backup is larger than 1 MB. Your current game has not been changed.');
  return raw;
}
export function parseQuestGameBackup(bytes: Uint8Array): QuestGameBackup {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > QUEST_GAME_BACKUP_MAX_BYTES) fail('Choose a nonempty health game backup no larger than 1 MB.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('The game backup must be UTF-8 JSON.'); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { fail('The game backup is not valid JSON.'); }
  uniqueFields(text);
  const value = object(raw);
  if (!value || !exact(value, ['format', 'version', 'state', 'sources']) || value.format !== FORMAT || value.version !== 1) fail();
  return normalized(value.state, value.sources);
}

/** Best-effort persistence after explicit restore; callers retain a full in-memory prior copy. */
export function persistQuestGameBackup(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, backup: QuestGameBackup): boolean {
  const checked = parseQuestGameBackup(new TextEncoder().encode(serializeQuestGameBackup(backup.state, backup.sources)));
  const game = serializeQuestionQuest(checked.state); let sources = '';
  saveQuestQuestionSources({ setItem(_key, value) { sources = value; } }, checked.state, checked.sources);
  let priorGame: string | null, priorSources: string | null;
  try { priorGame = storage.getItem(QUESTION_QUEST_STORAGE_KEY); priorSources = storage.getItem(QUEST_QUESTION_SOURCES_STORAGE_KEY); }
  catch { return false; }
  try {
    if (priorGame !== null) storage.setItem(`${QUESTION_QUEST_STORAGE_KEY}:previous`, priorGame);
    if (priorSources !== null) storage.setItem(`${QUEST_QUESTION_SOURCES_STORAGE_KEY}:previous`, priorSources);
  } catch { return false; }
  try { storage.setItem(QUESTION_QUEST_STORAGE_KEY, game); storage.setItem(QUEST_QUESTION_SOURCES_STORAGE_KEY, sources); return true; }
  catch {
    // Both original values were captured before writes. Keep their raw backups
    // even when the browser rejects rollback; never retry a partial restore.
    try { if (priorGame === null) storage.removeItem(QUESTION_QUEST_STORAGE_KEY); else storage.setItem(QUESTION_QUEST_STORAGE_KEY, priorGame); } catch { /* Prior raw backup remains. */ }
    try { if (priorSources === null) storage.removeItem(QUEST_QUESTION_SOURCES_STORAGE_KEY); else storage.setItem(QUEST_QUESTION_SOURCES_STORAGE_KEY, priorSources); } catch { /* Prior raw backup remains. */ }
    return false;
  }
}
