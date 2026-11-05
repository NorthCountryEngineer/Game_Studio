import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuestionQuest, upsertQuestQuestion, finishQuestQuestions, configureQuestTeams, pickFirstQuestTeam, startQuestionQuest, drawQuestCard, answerQuestCard, rollQuestDie, serializeQuestionQuest, QUESTION_QUEST_STORAGE_KEY } from '../src/lib/question-quest';
import { questionSourceKey, QUEST_QUESTION_SOURCES_STORAGE_KEY } from '../src/lib/question-quest-sources';
import { QUEST_GAME_BACKUP_MAX_BYTES, serializeQuestGameBackup, parseQuestGameBackup, persistQuestGameBackup } from '../src/lib/question-quest-backup';
import { createQuestId } from '../src/lib/question-quest-id';
const bytes = (text: string) => new TextEncoder().encode(text);
function fixture() {
  let state = upsertQuestQuestion(createQuestionQuest('backup-game'), { id: 'question-1', prompt: 'Synthetic backup question?', choices: ['One', 'Two'], correctIndex: 1 });
  state = finishQuestQuestions(state); state = configureQuestTeams(state, state.teams.map(({ id, name, avatar }) => ({ id, name, avatar }))); state = startQuestionQuest(pickFirstQuestTeam(state, () => 0)); state = rollQuestDie(answerQuestCard(drawQuestCard(state, () => 0), 1), () => .99);
  const sources = { [questionSourceKey(state.questions[0])]: { url: 'https://www.cdc.gov/cannabis/', citation: 'Synthetic government citation.', explanation: 'Synthetic source explanation.' } };
  return { state, sources };
}
test('portable game backup roundtrips exact saved progress, dice, questions and paired sources without rerolling', () => {
  const backup = fixture(), decoded = parseQuestGameBackup(bytes(serializeQuestGameBackup(backup.state, backup.sources)));
  assert.deepEqual(decoded, backup); assert.equal(decoded.state.turn.roll, 12); assert.deepEqual(decoded.state.turn.dice, [6, 6]); assert.equal(decoded.state.teams[0].position, 12); assert.equal(decoded.state.teams[0].points, 1);
  decoded.state.questions[0].prompt = 'Edited copy'; assert.equal(backup.state.questions[0].prompt, 'Synthetic backup question?');
});
test('portable backup rejects malformed, oversized, unknown, duplicate and mismatched data atomically', () => {
  const backup = fixture(), raw = serializeQuestGameBackup(backup.state, backup.sources), envelope = JSON.parse(raw);
  for (const text of ['{broken', raw.replace('"version": 1', '"version": 1, "version": 1'), JSON.stringify({ ...envelope, extra: true }), JSON.stringify({ ...envelope, format: 'another-game' }), JSON.stringify({ ...envelope, sources: [...envelope.sources, ...envelope.sources] }), JSON.stringify({ ...envelope, sources: [{ ...envelope.sources[0], key: 'wrong-question' }] }), JSON.stringify({ ...envelope, sources: [{ ...envelope.sources[0], source: { url: 'javascript:alert(1)', citation: 'Bad' } }] }), JSON.stringify({ ...envelope, state: { ...envelope.state, turn: { ...envelope.state.turn, roll: 11 } } })]) assert.throws(() => parseQuestGameBackup(bytes(text)));
  assert.throws(() => parseQuestGameBackup(new Uint8Array(QUEST_GAME_BACKUP_MAX_BYTES + 1))); assert.throws(() => parseQuestGameBackup(new Uint8Array([0xc3, 0x28])));
  assert.equal(serializeQuestGameBackup(backup.state, backup.sources), raw);
});
test('explicit persistence keeps prior raw game and source backups before replacing both current values', () => {
  const data = new Map([[QUESTION_QUEST_STORAGE_KEY, '{old raw game'], [QUEST_QUESTION_SOURCES_STORAGE_KEY, '{old raw sources']]);
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const backup = fixture(); assert.equal(persistQuestGameBackup(storage, backup), true); assert.equal(data.get(`${QUESTION_QUEST_STORAGE_KEY}:previous`), '{old raw game'); assert.equal(data.get(`${QUEST_QUESTION_SOURCES_STORAGE_KEY}:previous`), '{old raw sources'); assert.equal(data.get(QUESTION_QUEST_STORAGE_KEY), serializeQuestionQuest(backup.state));
});
test('partial persistence rolls back original current values and retains prior raw backups without retrying', () => {
  const data = new Map([[QUESTION_QUEST_STORAGE_KEY, 'original-game'], [QUEST_QUESTION_SOURCES_STORAGE_KEY, 'original-sources']]); let fail = true;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem(key: string, value: string) { if (key === QUEST_QUESTION_SOURCES_STORAGE_KEY && fail) { fail = false; throw new Error('full storage'); } data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  assert.equal(persistQuestGameBackup(storage, fixture()), false); assert.equal(data.get(QUESTION_QUEST_STORAGE_KEY), 'original-game'); assert.equal(data.get(QUEST_QUESTION_SOURCES_STORAGE_KEY), 'original-sources'); assert.equal(data.get(`${QUESTION_QUEST_STORAGE_KEY}:previous`), 'original-game');
  assert.equal(persistQuestGameBackup({ ...storage, getItem() { throw new Error('unavailable'); } }, fixture()), false); assert.equal(data.get(QUESTION_QUEST_STORAGE_KEY), 'original-game');
});
test('UUID fallback uses secure random bytes with RFC v4 and variant bits when randomUUID is unavailable', () => {
  let calls = 0; const random = { getRandomValues<T extends ArrayBufferView | null>(array: T): T { calls++; if (array instanceof Uint8Array) array.fill(255); return array; } };
  assert.equal(createQuestId(random), 'ffffffff-ffff-4fff-bfff-ffffffffffff'); assert.equal(calls, 1);
  assert.equal(createQuestId({ ...random, randomUUID: () => '00000000-0000-4000-8000-000000000001' }), '00000000-0000-4000-8000-000000000001'); assert.equal(calls, 1);
});
