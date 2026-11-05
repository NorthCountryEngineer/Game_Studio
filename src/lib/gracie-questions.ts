import catalog from '../data/gracie-questions.json';
import { parseQuestQuestionImport, type QuestImportPreview } from './question-quest-import';
import { questionSourceKey, type QuestQuestionSource } from './question-quest-sources';
import type { QuestQuestionInput } from './question-quest';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

/** Reviewed data for the fixed engine. Loading or playing never invokes a model. */
export const GRACIE_QUESTION_PRESET: QuestImportPreview = freeze(parseQuestQuestionImport(new TextEncoder().encode(JSON.stringify(catalog)), 'json'));
export type GracieQuestionAdditions = { questions: QuestQuestionInput[]; sources: (QuestQuestionSource | null)[]; skipped: number };
const PRESET_KEYS = GRACIE_QUESTION_PRESET.questions.map(questionSourceKey);
const PRESET_SOURCES = new Map(PRESET_KEYS.map((key, index) => [key, GRACIE_QUESTION_PRESET.sources?.[index]]));

/** Preserve authored cards and add only exact missing copies. Capacity is atomic in appendQuestQuestions. */
export function getGracieQuestionAdditions(existingQuestions: readonly QuestQuestionInput[]): GracieQuestionAdditions {
  if (!Array.isArray(existingQuestions) || existingQuestions.length > 100) throw new Error('A game can contain up to 100 questions.');
  const seen = new Set(existingQuestions.map(questionSourceKey));
  const questions: QuestQuestionInput[] = [], sources: (QuestQuestionSource | null)[] = [];
  for (const [index, question] of GRACIE_QUESTION_PRESET.questions.entries()) {
    const key = PRESET_KEYS[index];
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push({ prompt: question.prompt, choices: [...question.choices], correctIndex: question.correctIndex });
    const source = GRACIE_QUESTION_PRESET.sources?.[index]; sources.push(source ? { ...source } : null);
  }
  return { questions, sources, skipped: GRACIE_QUESTION_PRESET.questions.length - questions.length };
}

/** A citation belongs to this exact wording, choice order and answer only. */
export function sourceForGracieQuestion(question: QuestQuestionInput): QuestQuestionSource | undefined {
  const key = questionSourceKey(question);
  const source = PRESET_SOURCES.get(key);
  return source ? { ...source } : undefined;
}
