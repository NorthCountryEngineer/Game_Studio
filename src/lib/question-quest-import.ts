import { createQuestionQuest, upsertQuestQuestion, type QuestQuestionInput } from './question-quest';
import { parseQuestQuestionSource, type QuestQuestionSource } from './question-quest-sources';

export const QUEST_IMPORT_MAX_BYTES = 256 * 1024;
export type QuestImportFormat = 'txt' | 'json';
export type QuestImportPreview = { format: QuestImportFormat; questions: QuestQuestionInput[]; sources?: (QuestQuestionSource | null)[] };
type ImportedRows = { questions: QuestQuestionInput[]; sources: (QuestQuestionSource | null)[] };
export class QuestionQuestImportError extends Error {
  constructor(message: string, readonly questionNumber?: number, readonly lineNumber?: number) {
    const location = questionNumber !== undefined ? `Question ${questionNumber}${lineNumber !== undefined ? `, line ${lineNumber}` : ''}` : lineNumber !== undefined ? `Line ${lineNumber}` : '';
    super(`${location ? `${location}: ` : ''}${message}`); this.name = 'QuestionQuestImportError';
  }
}
function fail(message: string, question?: number, line?: number): never { throw new QuestionQuestImportError(message, question, line); }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function exact(value: Record<string, unknown> | undefined, keys: string[]): boolean { return Boolean(value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))); }
function validated(input: QuestQuestionInput, number: number, line?: number): QuestQuestionInput {
  try {
    const card = upsertQuestQuestion(createQuestionQuest('import-preview'), { id: 'preview-card', ...input }).questions[0];
    return { prompt: card.prompt, choices: [...card.choices], correctIndex: card.correctIndex };
  } catch (error) { fail(error instanceof Error ? error.message : 'Check the question and answer choices.', number, line); }
}
function validatedSource(value: unknown, number: number, line?: number): QuestQuestionSource {
  try { return parseQuestQuestionSource(value); }
  catch (error) { fail(error instanceof Error ? error.message : 'Check the source URL and citation.', number, line); }
}
function uniqueJsonFields(text: string): void {
  // JSON.parse establishes syntax first. Check its string/structural tokens so
  // duplicate keys cannot silently replace a different answer or question.
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const value = token[0], current = stack.at(-1), line = () => text.slice(0, token.index).split('\n').length;
    if (value === '{' || value === '[') {
      if (stack.length >= 8) fail('The JSON is nested too deeply. Use the JSON template structure.', undefined, line());
      stack.push({ object: value === '{', key: value === '{', keys: new Set() });
    } else if (value === '}' || value === ']') stack.pop();
    else if (value === ',' && current?.object) current.key = true;
    else if (value.startsWith('"') && current?.object && current.key) {
      const key = JSON.parse(value) as string;
      if (current.keys.has(key)) fail('A JSON field is repeated. Keep one copy of each field.', undefined, line());
      current.keys.add(key); current.key = false;
    }
  }
}
function jsonQuestions(text: string): ImportedRows {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    const message = error instanceof Error ? error.message : '', position = /(?:at position|position) (\d+)/.exec(message), knownLine = /line (\d+)/.exec(message);
    const line = position ? text.slice(0, Number(position[1])).split('\n').length : knownLine ? Number(knownLine[1]) : undefined;
    fail('This is not valid JSON. Check commas and quotation marks against the JSON template.', undefined, line);
  }
  uniqueJsonFields(text);
  const root = object(value);
  if (!exact(root, ['version', 'questions']) || root!.version !== 1 || !Array.isArray(root!.questions)) fail('Use exactly {"version":1,"questions":[...]} from the JSON template.');
  const questions = root!.questions as unknown[];
  if (questions.length < 1 || questions.length > 100) fail('The file must contain between 1 and 100 questions.');
  const sources: (QuestQuestionSource | null)[] = [];
  const inputs = questions.map((value, index) => {
    const row = object(value), number = index + 1;
    if (!exact(row, row && Object.hasOwn(row, 'source') ? ['question', 'choices', 'answer', 'source'] : ['question', 'choices', 'answer'])) fail('Use only question, choices and answer fields, plus optional source; do not include question IDs.', number);
    if (typeof row!.answer !== 'string' || !/^[A-D]$/.test(row!.answer)) fail('Set answer to one uppercase choice letter: A, B, C or D.', number);
    sources.push(Object.hasOwn(row!, 'source') ? validatedSource(row!.source, number) : null);
    return validated({ prompt: row!.question as string, choices: row!.choices as string[], correctIndex: row!.answer.charCodeAt(0) - 65 }, number);
  });
  return { questions: inputs, sources };
}
type Field = { tag: string; value: string; line: number };
function textQuestions(text: string): ImportedRows {
  const questions: QuestQuestionInput[] = [], sources: (QuestQuestionSource | null)[] = []; let fields: Field[] = [];
  const finish = () => {
    const number = questions.length + 1, start = fields[0]?.line;
    const answerAt = fields.findIndex(field => field.tag === 'ANSWER');
    if (answerAt < 0) fail('Add ANSWER: with the correct choice letter before the separator or end of the file.', number, start);
    if (questions.length >= 100) fail('A file can contain up to 100 questions.', number, start);
    const answer = fields[answerAt], source = fields.find(field => field.tag === 'SOURCE'), citation = fields.find(field => field.tag === 'CITATION'), explanation = fields.find(field => field.tag === 'EXPLANATION');
    if (!/^[A-D]$/i.test(answer.value)) fail('Set ANSWER: to one choice letter: A, B, C or D.', number, answer.line);
    if (source && !citation) fail('Add CITATION: after SOURCE: so the source URL and citation stay together.', number, source.line);
    questions.push(validated({ prompt: fields[0].value, choices: fields.slice(1, answerAt).map(field => field.value), correctIndex: answer.value.toUpperCase().charCodeAt(0) - 65 }, number, start));
    sources.push(source ? validatedSource({ url: source.value, citation: citation!.value, ...(explanation ? { explanation: explanation.value } : {}) }, number, source.line) : null);
    fields = [];
  };
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim(), number = questions.length + 1, lineNumber = index + 1;
    if (!line || line.startsWith('#')) continue;
    if (line === '---') { if (!fields.length) fail('Put --- between complete questions, not before an empty question.', number, lineNumber); finish(); continue; }
    const match = /^(Q|A|B|C|D|ANSWER|SOURCE|CITATION|EXPLANATION)[ \t]*:[ \t]*(.*)$/i.exec(line);
    if (!match) fail('Use one field per line: Q:, A:, B:, optional C:/D:, then ANSWER:. Optional SOURCE:, CITATION: and EXPLANATION: follow the answer.', number, lineNumber);
    const tag = match[1].toUpperCase(), previous = fields.at(-1)?.tag;
    if (tag === 'Q' && fields.length) fail('Add --- between questions.', number, lineNumber);
    if (fields.some(field => field.tag === tag)) fail(`${tag}: appears twice in this question. Keep one of each field.`, number, lineNumber);
    const allowed = !previous ? ['Q'] : previous === 'Q' ? ['A'] : previous === 'A' ? ['B'] : previous === 'B' ? ['C', 'ANSWER'] : previous === 'C' ? ['D', 'ANSWER'] : previous === 'D' ? ['ANSWER'] : previous === 'ANSWER' ? ['SOURCE'] : previous === 'SOURCE' ? ['CITATION'] : previous === 'CITATION' ? ['EXPLANATION'] : [];
    if (!allowed.includes(tag)) fail(`Expected ${allowed.length ? allowed.map(field => `${field}:`).join(' or ') : '--- before the next question'}. Keep question and choices in order.`, number, lineNumber);
    fields.push({ tag, value: match[2].trim(), line: lineNumber });
  }
  if (fields.length) finish();
  if (!questions.length) fail('The file has no questions. Start with Q: using the TXT template.');
  return { questions, sources };
}

/** Read local bytes into a validated preview. This never edits a bank or saves data. */
export function parseQuestQuestionImport(bytes: Uint8Array, format: QuestImportFormat): QuestImportPreview {
  if (!(bytes instanceof Uint8Array)) fail('Open a UTF-8 TXT or JSON question file.');
  if (bytes.byteLength > QUEST_IMPORT_MAX_BYTES) fail('The file is too large. Use a file of 256 KiB or less.');
  if (format !== 'txt' && format !== 'json') fail('Choose a .txt or .json question file.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('The file is not valid UTF-8 text. Save it as UTF-8 TXT or JSON and try again.'); }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (text.includes('\uFEFF')) fail('Only one optional UTF-8 BOM is allowed, at the start of the file.');
  text = text.replace(/\r\n/g, '\n');
  if (text.includes('\r')) fail('Use normal LF or CRLF line endings. Do not use a bare carriage return.');
  if (!text.trim()) fail('The file is empty. Add at least one question using the template.');
  const result = format === 'txt' ? textQuestions(text) : jsonQuestions(text);
  return { format, questions: result.questions, ...(result.sources.some(Boolean) ? { sources: result.sources } : {}) };
}
