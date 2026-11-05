import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuestionQuest, serializeQuestionQuest, upsertQuestQuestion, type QuestQuestionInput } from '../src/lib/question-quest';
import { QUESTION_QUEST_SOURCES_STORAGE_KEY, QUEST_QUESTION_SOURCES_STORAGE_KEY, QUEST_SOURCE_MAX_CITATION_LENGTH, QUEST_SOURCE_MAX_EXPLANATION_LENGTH, QUEST_SOURCE_MAX_URL_LENGTH, QUEST_SOURCES_MAX_BYTES, loadQuestQuestionSources, parseQuestQuestionSource, questionSourceKey, saveQuestQuestionSources, type QuestQuestionSource } from '../src/lib/question-quest-sources';

const input: QuestQuestionInput = { prompt: 'Synthetic source question?', choices: ['First', 'Second'], correctIndex: 0 };
const source: QuestQuestionSource = { url: 'https://example.test/facts', citation: 'Example Agency. (2026). Synthetic facts.', explanation: 'Synthetic explanation, not a medical claim.' };
function bank(id = 'source-game') { return upsertQuestQuestion(createQuestionQuest(id), { id: 'existing-card', ...input }); }
function storage(raw?: string) {
  const data = new Map<string, string>(raw === undefined ? [] : [[QUESTION_QUEST_SOURCES_STORAGE_KEY, raw]]), writes: string[] = [];
  return { data, writes, getItem: (key: string) => data.get(key) ?? null, setItem(key: string, value: string) { writes.push(key); data.set(key, value); } };
}

test('sources accept bounded normalized plain text and explicit HTTPS links without granting executable content', () => {
  assert.deepEqual(parseQuestQuestionSource({ url: ' HTTPS://EXAMPLE.test/facts%20page#part ', citation: '  Cafe\u0301 Agency. (2026). Facts.  ', explanation: '<script>literal text</script>' }), { url: 'https://example.test/facts%20page#part', citation: 'Café Agency. (2026). Facts.', explanation: '<script>literal text</script>' });
  assert.deepEqual(parseQuestQuestionSource({ url: source.url, citation: source.citation }), { url: source.url, citation: source.citation });
  assert.equal(QUESTION_QUEST_SOURCES_STORAGE_KEY, QUEST_QUESTION_SOURCES_STORAGE_KEY);
});

test('source URL safety rejects protocols, credentials, hidden controls and malformed links before use', () => {
  for (const url of ['http://example.test', 'javascript:alert(1)', 'data:text/html,unsafe', '//example.test', 'https:example.test', 'https://person:secret@example.test/', 'https://@example.test', 'https://example.test\\@other.test', 'https://example.test/a b', 'https://example.test/%0aheader', 'https://example.test/%00', 'https://example.test/%E2%80%AE', 'https://example.test/%zz', 'https://exa\nmple.test', 'https://example.test/\u202e']) assert.throws(() => parseQuestQuestionSource({ ...source, url }), /HTTPS|plain text/);
});

test('source text limits count Unicode characters and reject unknown, missing or multiline fields', () => {
  const maximal = parseQuestQuestionSource({ url: 'https://example.test/' + 'a'.repeat(QUEST_SOURCE_MAX_URL_LENGTH - 21), citation: '🐸'.repeat(QUEST_SOURCE_MAX_CITATION_LENGTH), explanation: '🐸'.repeat(QUEST_SOURCE_MAX_EXPLANATION_LENGTH) });
  assert.equal([...maximal.citation].length, QUEST_SOURCE_MAX_CITATION_LENGTH);
  for (const raw of [null, [], {}, { url: source.url }, { citation: source.citation }, { ...source, extra: true }, { ...source, citation: '' }, { ...source, citation: 'x\ny' }, { ...source, citation: 'x\u202ey' }, { ...source, explanation: '' }, { ...source, citation: 'x'.repeat(QUEST_SOURCE_MAX_CITATION_LENGTH + 1) }, { ...source, explanation: 'x'.repeat(QUEST_SOURCE_MAX_EXPLANATION_LENGTH + 1) }, { ...source, url: source.url + 'x'.repeat(QUEST_SOURCE_MAX_URL_LENGTH) }]) assert.throws(() => parseQuestQuestionSource(raw));
});

test('source keys bind normalized question wording, ordered choices and the correct answer, independently of IDs', () => {
  assert.equal(questionSourceKey(input), questionSourceKey({ ...input, prompt: '  Synthetic source question?  ' }));
  assert.equal(questionSourceKey(input), questionSourceKey({ id: 'other-id', ...input }));
  for (const changed of [{ ...input, prompt: 'Edited question?' }, { ...input, choices: ['Second', 'First'] }, { ...input, correctIndex: 1 }]) assert.notEqual(questionSourceKey(input), questionSourceKey(changed));
  assert.throws(() => questionSourceKey({ ...input, correctIndex: 9 }));
});

test('companion source saves preserve the original game bytes and only keep exact current-card bindings', () => {
  const state = bank(), before = serializeQuestionQuest(state), store = storage(), key = questionSourceKey(input);
  saveQuestQuestionSources(store, state, { [key]: source, [questionSourceKey({ ...input, prompt: 'Old deleted question?' })]: source });
  assert.deepEqual(store.writes, [QUESTION_QUEST_SOURCES_STORAGE_KEY]); assert.equal(serializeQuestionQuest(state), before);
  assert.deepEqual(loadQuestQuestionSources(store, state), { status: 'ready', sources: { [key]: source } });
  const edited = upsertQuestQuestion(state, { id: 'existing-card', ...input, correctIndex: 1 });
  assert.deepEqual(loadQuestQuestionSources(store, edited), { status: 'ready', sources: {} });
  assert.deepEqual(loadQuestQuestionSources(store, bank('different-game')), { status: 'empty', sources: {} });
  assert.equal(store.data.size, 1);
});

test('legacy missing metadata, corrupt metadata and inaccessible storage never rewrite game or source data', () => {
  const state = bank(); assert.deepEqual(loadQuestQuestionSources(storage(), state), { status: 'empty', sources: {} });
  const key = questionSourceKey(input), raw = JSON.stringify({ version: 1, gameId: state.id, sources: [{ key, source }] });
  const broken = ['{broken', 'null', '{}', JSON.stringify({ version: 2, gameId: state.id, sources: [] }), JSON.stringify({ version: 1, gameId: state.id, sources: [{ key, source: { ...source, url: 'javascript:bad' } }] }), JSON.stringify({ version: 1, gameId: state.id, sources: [{ key, source }, { key, source }] }), JSON.stringify({ version: 1, gameId: state.id, sources: Array.from({ length: 101 }, () => ({ key, source })) }), ' '.repeat(QUEST_SOURCES_MAX_BYTES + 1), raw.replace('"version":1', '"version":1,"extra":true')];
  for (const value of broken) { const store = storage(value); assert.deepEqual(loadQuestQuestionSources(store, state), { status: 'invalid', sources: {} }); assert.equal(store.data.get(QUESTION_QUEST_SOURCES_STORAGE_KEY), value); assert.equal(store.writes.length, 0); }
  assert.deepEqual(loadQuestQuestionSources({ getItem() { throw new Error('read unavailable'); } }, state), { status: 'unavailable', sources: {} });
});

test('source write failure and invalid source objects leave prior companion metadata untouched', () => {
  const state = bank(), key = questionSourceKey(input), store = storage('old companion data');
  assert.throws(() => saveQuestQuestionSources(store, state, { [key]: { ...source, citation: '' } })); assert.equal(store.data.get(QUESTION_QUEST_SOURCES_STORAGE_KEY), 'old companion data'); assert.equal(store.writes.length, 0);
  assert.throws(() => saveQuestQuestionSources({ setItem() { throw new Error('quota exhausted'); } }, state, { [key]: source }), /quota/);
  assert.throws(() => saveQuestQuestionSources(store, { ...state, id: 'bad id' }, {}));
});

test('one hundred companion bindings are bounded by encoded bytes before an atomic storage write', () => {
  let state = createQuestionQuest('bounded-sources'); const sources: Record<string, QuestQuestionSource> = {};
  for (let i = 0; i < 100; i++) { const question = { ...input, prompt: `Synthetic source ${i}?` }; state = upsertQuestQuestion(state, { id: `card-${i}`, ...question }); sources[questionSourceKey(question)] = source; }
  const store = storage(); saveQuestQuestionSources(store, state, sources); assert.equal(Object.keys(loadQuestQuestionSources(store, state).sources).length, 100);
  const before = store.data.get(QUESTION_QUEST_SOURCES_STORAGE_KEY), writes = store.writes.length;
  const oversized = Object.fromEntries(Object.keys(sources).map(key => [key, { ...source, citation: '🐸'.repeat(1000), explanation: '🐸'.repeat(1000) }]));
  assert.throws(() => saveQuestQuestionSources(store, state, oversized), /too large/); assert.equal(store.writes.length, writes); assert.equal(store.data.get(QUESTION_QUEST_SOURCES_STORAGE_KEY), before);
  const largeRaw = JSON.stringify({ version: 1, gameId: state.id, sources: Object.entries(oversized).map(([key, source]) => ({ key, source })) });
  assert.ok(largeRaw.length < QUEST_SOURCES_MAX_BYTES && new TextEncoder().encode(largeRaw).byteLength > QUEST_SOURCES_MAX_BYTES);
  assert.deepEqual(loadQuestQuestionSources(storage(largeRaw), state), { status: 'invalid', sources: {} });
});
