import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { appendQuestQuestions, createQuestionQuest, serializeQuestionQuest, upsertQuestQuestion, type QuestQuestionInput } from '../src/lib/question-quest';
import { parseQuestQuestionImport } from '../src/lib/question-quest-import';
import { GRACIE_QUESTION_PRESET, getGracieQuestionAdditions, sourceForGracieQuestion } from '../src/lib/gracie-questions';
import { parseQuestQuestionSource, questionSourceKey } from '../src/lib/question-quest-sources';

const synthetic: QuestQuestionInput = { prompt: 'An existing synthetic authored card?', choices: ['First', 'Second'], correctIndex: 0 };

test('the reviewed Gracie catalog passes the same importer and includes one valid source per card', () => {
  const parsed = parseQuestQuestionImport(readFileSync(new URL('../src/data/gracie-questions.json', import.meta.url)), 'json');
  assert.deepEqual(parsed, GRACIE_QUESTION_PRESET); assert.ok(parsed.questions.length >= 1 && parsed.questions.length <= 100);
  assert.equal(new Set(parsed.questions.map(questionSourceKey)).size, parsed.questions.length);
  assert.equal(parsed.sources?.length, parsed.questions.length);
  assert.ok(parsed.sources?.every(source => source !== null));
  for (const source of parsed.sources ?? []) assert.deepEqual(parseQuestQuestionSource(source), source);
  assert.ok(Object.isFrozen(GRACIE_QUESTION_PRESET)); assert.ok(Object.isFrozen(GRACIE_QUESTION_PRESET.questions));
});

test('Gracie additions keep authored cards intact, use fresh IDs and skip exact existing copies on repeated loading', () => {
  const original = upsertQuestQuestion(createQuestionQuest('preset-test'), { id: 'original-card', ...synthetic }), before = serializeQuestionQuest(original), additions = getGracieQuestionAdditions(original.questions);
  assert.equal(additions.questions.length, GRACIE_QUESTION_PRESET.questions.length); assert.equal(additions.skipped, 0); assert.equal(additions.sources.length, additions.questions.length);
  let id = 0; const next = appendQuestQuestions(original, additions.questions, () => `preset-${++id}`);
  assert.equal(serializeQuestionQuest(original), before); assert.deepEqual(next.questions[0], original.questions[0]); assert.deepEqual(next.teams, original.teams);
  const repeated = getGracieQuestionAdditions(next.questions); assert.deepEqual(repeated.questions, []); assert.deepEqual(repeated.sources, []); assert.equal(repeated.skipped, GRACIE_QUESTION_PRESET.questions.length);
});

test('preset source lookup and de-duplication use exact content rather than IDs or just matching prompts', () => {
  const first = GRACIE_QUESTION_PRESET.questions[0], source = GRACIE_QUESTION_PRESET.sources?.[0] ?? undefined;
  assert.deepEqual(sourceForGracieQuestion({ id: 'manual-or-file-card', ...first }), source);
  assert.equal(getGracieQuestionAdditions([{ ...first, prompt: '  ' + first.prompt + '  ' }]).skipped, 1);
  const edited = { ...first, choices: [...first.choices], correctIndex: (first.correctIndex + 1) % first.choices.length };
  assert.equal(sourceForGracieQuestion(edited), undefined); assert.equal(getGracieQuestionAdditions([edited]).skipped, 0);
  assert.equal(sourceForGracieQuestion({ ...first, prompt: 'Different wording?' }), undefined);
  const reversed = { ...first, choices: [...first.choices].reverse() }; assert.notEqual(questionSourceKey(first), questionSourceKey(reversed));
});

test('returned preset data and source objects cannot mutate the reviewed catalog', () => {
  const before = JSON.stringify(GRACIE_QUESTION_PRESET), additions = getGracieQuestionAdditions([]);
  additions.questions[0].choices[0] = 'Changed returned choice'; additions.questions[0].prompt = 'Changed returned prompt';
  if (additions.sources[0]) additions.sources[0].citation = 'Changed returned citation';
  const source = sourceForGracieQuestion(GRACIE_QUESTION_PRESET.questions[0]); if (source) source.citation = 'Changed lookup result';
  assert.equal(JSON.stringify(GRACIE_QUESTION_PRESET), before);
});

test('preset batches fit the existing capacity atomically and capacity failures do not partially add cards', () => {
  const additions = getGracieQuestionAdditions([]); let state = createQuestionQuest('preset-capacity');
  for (let i = 0; i < 100 - additions.questions.length; i++) state = upsertQuestQuestion(state, { id: `authored-${i}`, ...synthetic, prompt: `Synthetic authored ${i}?` });
  let id = 0; assert.equal(appendQuestQuestions(state, additions.questions, () => `new-${++id}`).questions.length, 100);
  const full = upsertQuestQuestion(state, { id: 'one-extra-authored', ...synthetic }), before = serializeQuestionQuest(full); id = 0;
  assert.throws(() => appendQuestQuestions(full, additions.questions, () => `new-${++id}`), /exceed 100/); assert.equal(id, 0); assert.equal(serializeQuestionQuest(full), before);
});
