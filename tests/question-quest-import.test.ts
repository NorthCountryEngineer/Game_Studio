import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { appendQuestQuestions, answerQuestCard, configureQuestTeams, createQuestionQuest, drawQuestCard, finishQuestQuestions, nextQuestTeam, parseQuestionQuest, pickFirstQuestTeam, projectQuestionQuest, rollQuestDie, serializeQuestionQuest, startQuestionQuest, upsertQuestQuestion, type QuestQuestionInput, type QuestState } from '../src/lib/question-quest';
import { QUEST_IMPORT_MAX_BYTES, QuestionQuestImportError, parseQuestQuestionImport, type QuestImportFormat } from '../src/lib/question-quest-import';

const bytes = (text: string) => new TextEncoder().encode(text);
const txt = (question = 'Which is a prime number?') => `Q: ${question}\nA: 4\nB: 7\nANSWER: B`;
const json = (questions: unknown[] = [{ question: 'Which is a prime number?', choices: ['4', '7'], answer: 'B' }]) => JSON.stringify({ version: 1, questions });
const preview = () => parseQuestQuestionImport(bytes(txt()), 'txt');
function importedError(text: string | Uint8Array, format: QuestImportFormat = 'txt'): QuestionQuestImportError {
  try { parseQuestQuestionImport(typeof text === 'string' ? bytes(text) : text, format); }
  catch (error) { assert.ok(error instanceof QuestionQuestImportError); return error; }
  assert.fail('The import must fail before producing a preview.');
}
function bank(count = 1): QuestState {
  let state = createQuestionQuest('existing-game');
  for (let i = 1; i <= count; i++) state = upsertQuestQuestion(state, { id: `existing-${i}`, prompt: `Existing ${i}?`, choices: ['Yes', 'No'], correctIndex: 0 });
  return state;
}
function playing(): QuestState { const q = finishQuestQuestions(bank()); return startQuestionQuest(pickFirstQuestTeam(configureQuestTeams(q, q.teams.map(({ id, name, avatar }) => ({ id, name, avatar }))), () => 0)); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test('the downloadable TXT and JSON templates produce the same two normalized questions and correct answers', () => {
  const text = parseQuestQuestionImport(readFileSync(new URL('../public/templates/quiz-circuit-questions.txt', import.meta.url)), 'txt');
  const structured = parseQuestQuestionImport(readFileSync(new URL('../public/templates/quiz-circuit-questions.json', import.meta.url)), 'json');
  assert.deepEqual(text.questions, structured.questions); assert.equal(text.questions.length, 2); assert.deepEqual(text.questions.map(q => q.correctIndex), [1, 2]);
  assert.equal(text.questions[0].choices[text.questions[0].correctIndex], 'Ottawa'); assert.equal(text.questions[1].choices[text.questions[1].correctIndex], '7');
  assert.ok(text.questions.every(q => !Object.hasOwn(q, 'id'))); assert.equal(text.format, 'txt'); assert.equal(structured.format, 'json');
});

test('TXT accepts two, three, or four ordered choices, lowercase labels, comments, and an optional trailing separator', () => {
  const source = '# Heading\n\nq: First?\na: Yes\nb: No\nanswer: a\n---\nQ: Second?\nA: One\nB: Two\n# Comment between fields\nC: Three\nANSWER: C\n---\nQ: Third?\nA: Red\nB: Blue\nC: Green\nD: Gold\nANSWER: D\n---\n';
  const result = parseQuestQuestionImport(bytes(source), 'txt'); assert.deepEqual(result.questions.map(q => q.choices.length), [2, 3, 4]); assert.deepEqual(result.questions.map(q => q.correctIndex), [0, 2, 3]);
});

test('UTF-8 BOM and CRLF imports normalize exactly like LF while preserving Unicode and literal punctuation', () => {
  const source = 'Q:  Cafe\u0301: #1 --- 🦊?  \nA:  Oui  \nB: Non\nANSWER: A';
  const plain = parseQuestQuestionImport(bytes(source), 'txt'), windows = parseQuestQuestionImport(bytes('\uFEFF' + source.replace(/\n/g, '\r\n')), 'txt');
  assert.deepEqual(plain, windows); assert.equal(plain.questions[0].prompt, 'Café: #1 --- 🦊?'); assert.deepEqual(plain.questions[0].choices, ['Oui', 'Non']);
  assert.deepEqual(parseQuestQuestionImport(bytes('\uFEFF' + json()), 'json').questions, preview().questions);
});

test('TXT reports the exact offending line for unknown, repeated, out-of-order, and missing-separator fields', () => {
  const cases: [string, number, RegExp][] = [
    ['Q: Question?\nA: Yes\nB: No\nEXTRA: nope\nANSWER: A', 4, /one field per line/],
    ['Q: Question?\nA: Yes\nA: Again\nB: No\nANSWER: A', 3, /appears twice/],
    ['Q: Question?\nB: No\nA: Yes\nANSWER: A', 2, /Expected A:/],
    ['Q: Question?\nA: Yes\nB: No\nD: Maybe\nANSWER: A', 4, /Expected C: or ANSWER:/],
    [txt() + '\n' + txt('Second?'), 5, /Add --- between questions/],
    ['---\n' + txt(), 1, /between complete questions/],
    [txt() + '\n---\n---', 6, /empty question/],
    ['Q: Question?\ncontinued on another line\nA: Yes\nB: No\nANSWER: A', 2, /one field per line/],
  ];
  for (const [source, line, message] of cases) { const error = importedError(source); assert.equal(error.questionNumber, 1 + (source === txt() + '\n---\n---' ? 1 : 0)); assert.equal(error.lineNumber, line); assert.match(error.message, message); }
});

test('missing or invalid answers identify the question, including errors after an earlier valid question', () => {
  const missing = importedError('Q: Missing answer?\nA: Yes\nB: No'); assert.equal(missing.questionNumber, 1); assert.equal(missing.lineNumber, 1); assert.match(missing.message, /Add ANSWER:/);
  const malformed = importedError(txt() + '\n---\nQ: Bad answer?\nA: One\nB: Two\nANSWER: B and A'); assert.equal(malformed.questionNumber, 2); assert.equal(malformed.lineNumber, 9); assert.match(malformed.message, /one choice letter/);
  assert.match(importedError('Q: Too few?\nA: Yes\nANSWER: A').message, /Expected B:/);
  assert.match(importedError(txt().replace('ANSWER: B', 'ANSWER: D')).message, /2–4 choices/);
});

test('both formats apply the existing prompt, choice, answer-range, and duplicate-choice rules', () => {
  const cases = [
    { question: 'x'.repeat(301), choices: ['a', 'b'], answer: 'A' },
    { question: 'Valid?', choices: ['x'.repeat(121), 'b'], answer: 'A' },
    { question: 'Valid?', choices: [' Same ', 'same'], answer: 'A' },
    { question: 'Valid?', choices: ['a'], answer: 'A' },
    { question: 'Valid?', choices: ['a', 'b', 'c', 'd', 'e'], answer: 'A' },
    { question: 'Valid?', choices: ['a', 'b'], answer: 'D' },
    { question: '\u202ebad', choices: ['a', 'b'], answer: 'A' },
    { question: 'Valid?', choices: ['a\nb', 'c'], answer: 'A' },
    { question: '', choices: ['a', 'b'], answer: 'A' },
  ];
  for (const row of cases) { const error = importedError(json([row]), 'json'); assert.equal(error.questionNumber, 1); assert.ok(error.message.length < 500); }
  assert.match(importedError(txt('x'.repeat(301))).message, /300 printable characters/); assert.match(importedError(txt().replace('A: 4', 'A: ' + 'x'.repeat(121))).message, /120 printable characters/);
});

test('exact maximum Unicode text lengths and one hundred questions are accepted without deduplicating prompts', () => {
  const maximal = { question: '🐸'.repeat(300), choices: ['a'.repeat(120), 'b'.repeat(120)], answer: 'B' };
  const result = parseQuestQuestionImport(bytes(json([maximal])), 'json'); assert.equal([...result.questions[0].prompt].length, 300); assert.equal(result.questions[0].choices[0].length, 120);
  const hundred = Array.from({ length: 100 }, () => ({ question: 'Repeated intentionally?', choices: ['Yes', 'No'], answer: 'A' })); assert.equal(parseQuestQuestionImport(bytes(json(hundred)), 'json').questions.length, 100);
  assert.equal(parseQuestQuestionImport(bytes(Array.from({ length: 100 }, () => txt()).join('\n---\n')), 'txt').questions.length, 100);
  assert.match(importedError(json([...hundred, hundred[0]]), 'json').message, /between 1 and 100/); assert.equal(importedError(Array.from({ length: 101 }, () => txt()).join('\n---\n')).questionNumber, 101);
});

test('JSON accepts only its versioned data schema, uppercase choice letters, and no imported identities', () => {
  for (const source of ['[]', '{}', '{"version":2,"questions":[]}', '{"version":1,"questions":[],"extra":true}', '{"version":1,"questions":{}}', json([])]) assert.ok(importedError(source, 'json').message.length < 500);
  for (const row of [null, ['question'], { question: 'Test?', choices: ['A', 'B'], answer: 'a' }, { question: 'Test?', choices: ['A', 'B'], answer: 0 }, { question: 'Test?', choices: ['A', 'B'], answer: 'A', id: 'forged' }, { prompt: 'Test?', choices: ['A', 'B'], answer: 'A' }, { question: 'Test?', choices: ['A', 'B'], answer: 'A', extra: true }]) assert.equal(importedError(json([row]), 'json').questionNumber, 1);
});

test('JSON rejects duplicate keys, including escaped equivalents, instead of silently replacing a correct answer', () => {
  for (const source of ['{"version":1,"version":1,"questions":[]}', '{"version":1,"questions":[{"question":"Test?","choices":["A","B"],"answer":"A","answer":"B"}]}', '{"version":1,"questions":[{"question":"Test?","choices":["A","B"],"answer":"A","\\u0061nswer":"B"}]}']) assert.match(importedError(source, 'json').message, /field is repeated/);
  const literal = parseQuestQuestionImport(bytes(json([{ question: 'Literal: {"answer":"A","answer":"B"}?', choices: ['{', '}'], answer: 'A' }])), 'json'); assert.equal(literal.questions.length, 1);
});

test('malformed JSON provides a bounded corrective error without reflecting private file contents', () => {
  const secret = 'PRIVATE-CONTENT-MUST-NOT-BE-REFLECTED'; const error = importedError('{\n"version":1,\n"questions":[' + secret, 'json'); assert.match(error.message, /not valid JSON/); assert.equal(error.message.includes(secret), false); assert.ok(error.message.length < 300);
  assert.match(importedError('['.repeat(12) + '0' + ']'.repeat(12), 'json').message, /nested too deeply/);
});

test('unknown prototype-related fields are rejected and document contents remain inert plain text', () => {
  const before = (Object.prototype as any).polluted;
  assert.match(importedError('{"version":1,"questions":[],"__proto__":{"polluted":true}}', 'json').message, /JSON template/);
  assert.match(importedError('{"version":1,"questions":[{"question":"Test?","choices":["A","B"],"answer":"A","__proto__":{"polluted":true}}]}', 'json').message, /only question, choices and answer/);
  assert.equal((Object.prototype as any).polluted, before);
  const literal = '<script>globalThis.polluted=true</script> & **bold**'; assert.equal(parseQuestQuestionImport(bytes(txt(literal)), 'txt').questions[0].prompt, literal);
});

test('byte limits are exact and apply before decoding, with invalid UTF-8 and unsupported formats rejected', () => {
  const body = txt(), padded = '#' + 'x'.repeat(QUEST_IMPORT_MAX_BYTES - bytes(body).byteLength - 2) + '\n' + body;
  assert.equal(bytes(padded).byteLength, 256 * 1024); assert.equal(parseQuestQuestionImport(bytes(padded), 'txt').questions.length, 1);
  assert.match(importedError(padded + 'x').message, /too large/); assert.match(importedError(new Uint8Array([0xc3, 0x28])).message, /not valid UTF-8/); assert.match(importedError(new Uint8Array([0xff, 0xfe, 0x41, 0x00])).message, /not valid UTF-8/);
  assert.match(importedError('\uFEFF\uFEFF' + txt()).message, /one optional UTF-8 BOM/); assert.match(importedError(txt().replace('prime', '\uFEFFprime')).message, /one optional UTF-8 BOM/); assert.match(importedError(txt().replace(/\n/g, '\r')).message, /line endings/);
  assert.match(importedError(bytes(txt()), 'docx' as QuestImportFormat).message, /\.txt or \.json/); assert.throws(() => parseQuestQuestionImport(txt() as any, 'txt'), QuestionQuestImportError);
  for (const empty of ['', '  \n\r\n ', '# Comments only\n\n']) assert.ok(importedError(empty).message.length < 300);
});

test('batch append preserves existing authored state and adds only fresh reviewed identities', () => {
  const original = freeze(bank(2)), raw = serializeQuestionQuest(original), imported = preview().questions; let nextId = 0;
  const result = appendQuestQuestions(original, imported, () => `fresh-${++nextId}`); assert.equal(nextId, 1); assert.equal(result.questions.length, 3); assert.deepEqual(result.questions.slice(0, 2), original.questions); assert.equal(result.questions[2].id, 'fresh-1'); assert.equal(result.questions[2].correctIndex, 1); assert.equal(result.phase, 'questions'); assert.deepEqual(result.teams, original.teams); assert.equal(serializeQuestionQuest(original), raw);
  imported[0].choices[0] = 'Mutated preview'; assert.equal(result.questions[2].choices[0], '4'); assert.deepEqual(parseQuestionQuest(result), result); assert.equal('questions' in projectQuestionQuest(result), false);
});

test('append validates the entire batch and remaining capacity before requesting any IDs', () => {
  const original = freeze(bank()), raw = serializeQuestionQuest(original); let ids = 0; const makeId = () => `new-${++ids}`;
  const bad: QuestQuestionInput = { prompt: 'Invalid last choice?', choices: ['same', 'SAME'], correctIndex: 0 };
  assert.throws(() => appendQuestQuestions(original, [...preview().questions, bad], makeId), /Question 2:.*different text/); assert.equal(ids, 0); assert.equal(serializeQuestionQuest(original), raw);
  assert.throws(() => appendQuestQuestions(freeze(bank(100)), preview().questions, makeId), /room for 0 more/); assert.equal(ids, 0);
  assert.throws(() => appendQuestQuestions(original, [], makeId), /between 1 and 100/); assert.throws(() => appendQuestQuestions(original, [{ ...preview().questions[0], id: 'forged' } as any], makeId)); assert.equal(ids, 0);
});

test('ID collisions or generator failures never partially append or replace an existing question', () => {
  const original = freeze(bank()), raw = serializeQuestionQuest(original), pair = [preview().questions[0], preview().questions[0]];
  assert.throws(() => appendQuestQuestions(original, pair, () => 'existing-1'), /already in use/); assert.throws(() => appendQuestQuestions(original, pair, () => 'duplicate-new'), /already in use/);
  let n = 0; assert.throws(() => appendQuestQuestions(original, pair, () => { if (++n === 2) throw new Error('ID generator unavailable'); return 'valid-first'; }), /ID generator unavailable/);
  assert.throws(() => appendQuestQuestions(original, pair, () => ''), /stable game, team or question identifier/); assert.throws(() => appendQuestQuestions(original, pair, undefined as any), /identifiers are required/); assert.equal(serializeQuestionQuest(original), raw);
});

test('imports can fill exactly one hundred slots and intentionally repeated prompts remain separate cards', () => {
  const original = freeze(bank(98)), input = preview().questions[0]; let nextId = 0;
  const result = appendQuestQuestions(original, [input, input], () => `new-${++nextId}`); assert.equal(result.questions.length, 100); assert.equal(result.questions[98].prompt, result.questions[99].prompt); assert.notEqual(result.questions[98].id, result.questions[99].id); assert.equal(original.questions.length, 98);
  assert.throws(() => appendQuestQuestions(original, [input, input, input], () => 'unused'), /room for 2 more/);
});

test('batch import is locked outside question setup and leaves active progress and saved dice untouched', () => {
  const teams = finishQuestQuestions(bank()), first = configureQuestTeams(teams, teams.teams.map(({ id, name, avatar }) => ({ id, name, avatar }))), game = playing(), rolled = rollQuestDie(answerQuestCard(drawQuestCard(game, () => 0), 0), () => .99);
  let result = playing(); while (result.phase !== 'results') { result = rollQuestDie(answerQuestCard(drawQuestCard(result, () => 0), 0), () => .99); if (result.phase !== 'results') result = nextQuestTeam(result); }
  for (const state of [teams, first, game, rolled, result]) { const raw = serializeQuestionQuest(freeze(state)); assert.throws(() => appendQuestQuestions(state, preview().questions, () => 'new-card'), /Return to question setup/); assert.equal(serializeQuestionQuest(state), raw); }
});
