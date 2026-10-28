import type { GameResult, MultiGameSpec } from './game-types';
import { parseFlowProgress, materialReferenceValid, type FlowProgress } from './game-flow-session';
import { validateGameResult } from './game-runtime';
import { validateGameSpec } from './game-design';
import { validateFlowCompletion } from './game-scoring';

export type MultiGameResult = {
  outcome: 'won' | 'lost'; elapsed: number; wallElapsed: number; score: number; points: number;
  games: { stepId: string; result: GameResult; flow?: FlowProgress }[];
  materials: { path: string[]; status: 'completed' | 'skipped'; elapsed: number }[];
};
export type MultiGameProgress = {
  runId: string; status: 'playing' | 'material' | 'completed' | 'lost' | 'free-play';
  activeStepId?: string; reviewedStepIds: string[]; result?: MultiGameResult;
};
/** Neutral outer objects and the existing inner flow formats share one adapter. */
export type MultiMaterialStep = { id: string; type: 'material'; title: string; kind: 'content' | 'video' | 'interactive' | 'lesson' | 'exercise'; reference: string; required: boolean };
export type MultiMaterialRequest = { runId: string; requestId: string; path: string[]; node: MultiMaterialStep };
export type MultiMaterialHandler = (request: MultiMaterialRequest, signal: AbortSignal) => Promise<void>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stepId = /^step-(?:[1-9]|1[0-2])$/;
const innerId = /^step-(?:[1-9]|1[0-9]|2[0-4])$/;
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bounded = (value: unknown, maximum: number, whole = false): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum && (!whole || Number.isSafeInteger(value));
const same = (first: number, second: number) => Math.abs(first - second) < 0.001;
export const multiGamePoints = (result: GameResult) => result.points ?? result.score * 10;

export function multiMaterialPathValid(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 && typeof value[0] === 'string' && stepId.test(value[0]) && (value.length === 1 || typeof value[1] === 'string' && innerId.test(value[1]));
}
export function parseMultiMaterialStep(value: unknown): MultiMaterialStep | undefined {
  if (!record(value) || !keys(value, ['id', 'type', 'title', 'kind', 'reference', 'required']) || typeof value.id !== 'string' || !innerId.test(value.id) || value.type !== 'material' || typeof value.title !== 'string' || !value.title.trim() || value.title !== value.title.trim() || value.title.length > 80 || /[<>\u0000-\u001f\u007f-\u009f]/u.test(value.title) || !['content', 'video', 'interactive', 'lesson', 'exercise'].includes(value.kind as string) || !materialReferenceValid(value.reference) || typeof value.required !== 'boolean') return;
  return structuredClone(value) as MultiMaterialStep;
}
function parseChildResult(value: unknown): GameResult | undefined {
  if (!record(value) || !keys(value, ['outcome', 'elapsed', 'score', 'reviewedLevelIds'], ['points']) || !['won', 'lost'].includes(value.outcome as string) || !bounded(value.elapsed, 86400) || !bounded(value.score, 320, true) || value.points !== undefined && !bounded(value.points, 2_147_483_647, true) || !Array.isArray(value.reviewedLevelIds) || !value.reviewedLevelIds.length || value.reviewedLevelIds.length > 8 || value.reviewedLevelIds.some(id => typeof id !== 'string' || !/^level-[1-8]$/.test(id)) || new Set(value.reviewedLevelIds).size !== value.reviewedLevelIds.length) return;
  return structuredClone(value) as GameResult;
}

/** Strict, identity-free envelope parsing. The full definition is checked separately. */
export function parseMultiGameResult(value: unknown): MultiGameResult | undefined {
  if (!record(value) || !keys(value, ['outcome', 'elapsed', 'wallElapsed', 'score', 'points', 'games', 'materials']) || !['won', 'lost'].includes(value.outcome as string) || !bounded(value.elapsed, 86400) || !bounded(value.wallElapsed, 86400) || value.wallElapsed < value.elapsed || !bounded(value.score, 2560, true) || !bounded(value.points, 2_147_483_647, true) || !Array.isArray(value.games) || !value.games.length || value.games.length > 8 || !Array.isArray(value.materials) || value.materials.length > 11) return;
  const games: MultiGameResult['games'] = [], seenGames = new Set<string>();
  for (const game of value.games) {
    if (!record(game) || !keys(game, ['stepId', 'result'], ['flow']) || typeof game.stepId !== 'string' || !stepId.test(game.stepId) || seenGames.has(game.stepId)) return;
    const result = parseChildResult(game.result), flow = game.flow === undefined ? undefined : parseFlowProgress(game.flow);
    if (!result || Object.hasOwn(game, 'flow') && !flow || flow && (flow.status !== result.outcome || flow.gameplayElapsed !== result.elapsed || flow.score !== result.score || flow.points !== result.points)) return;
    seenGames.add(game.stepId); games.push({ stepId: game.stepId, result, ...(flow ? { flow } : {}) });
  }
  if (games.some((game, index) => game.result.outcome !== (value.outcome === 'lost' && index === games.length - 1 ? 'lost' : 'won'))) return;
  const seenMaterials = new Set<string>();
  for (const material of value.materials) {
    if (!record(material) || !keys(material, ['path', 'status', 'elapsed']) || !multiMaterialPathValid(material.path) || material.path.length !== 1 || seenMaterials.has(material.path[0]) || !['completed', 'skipped'].includes(material.status as string) || !bounded(material.elapsed, 86400)) return;
    seenMaterials.add(material.path[0]);
  }
  const elapsed = games.reduce((sum, game) => sum + game.result.elapsed, 0), score = games.reduce((sum, game) => sum + game.result.score, 0), points = games.reduce((sum, game) => sum + multiGamePoints(game.result), 0);
  const observedWall = games.reduce((sum, game) => sum + (game.flow?.wallElapsed ?? game.result.elapsed), 0) + value.materials.reduce((sum, item) => sum + item.elapsed, 0);
  if (!same(value.elapsed, elapsed) || value.score !== score || value.points !== points || observedWall > value.wallElapsed + 0.001) return;
  return structuredClone({ ...value, games }) as MultiGameResult;
}

/** Validate the exact finite prefix. Free play cannot contribute points or time. */
export function validateMultiGameResult(specValue: unknown, value: unknown): MultiGameResult | undefined {
  try {
    const spec = validateGameSpec(specValue), result = parseMultiGameResult(value);
    if (spec.version !== 8 || !result) return;
    const games = spec.steps.filter(step => step.type === 'game');
    if (result.games.length > games.length || result.outcome === 'won' && result.games.length !== games.length) return;
    for (let index = 0; index < result.games.length; index++) {
      const game = games[index], observation = result.games[index];
      if (game.id !== observation.stepId) return;
      const child = validateGameResult(observation.result, game.spec);
      if (!child || child.outcome !== observation.result.outcome) return;
      const hasFlow = game.spec.version !== 3 && !!game.spec.flow;
      if (hasFlow !== !!observation.flow) return;
      if (hasFlow) validateFlowCompletion(game.spec, observation.flow, child);
    }
    const lastIndex = spec.steps.findIndex(step => step.id === result.games.at(-1)!.stepId);
    const traversed = result.outcome === 'won' ? spec.steps : spec.steps.slice(0, lastIndex);
    const materials = traversed.filter(step => step.type === 'material');
    if (materials.length !== result.materials.length || materials.some((step, index) => result.materials[index].path[0] !== step.id || step.required && result.materials[index].status !== 'completed')) return;
    return result;
  } catch { return; }
}

export function parseMultiGameProgress(value: unknown): MultiGameProgress | undefined {
  if (!record(value) || !keys(value, ['runId', 'status', 'reviewedStepIds'], ['activeStepId', 'result']) || typeof value.runId !== 'string' || !uuid.test(value.runId) || !['playing', 'material', 'completed', 'lost', 'free-play'].includes(value.status as string) || value.activeStepId !== undefined && (typeof value.activeStepId !== 'string' || !stepId.test(value.activeStepId)) || !Array.isArray(value.reviewedStepIds) || value.reviewedStepIds.length > 12 || value.reviewedStepIds.some(id => typeof id !== 'string' || !stepId.test(id)) || new Set(value.reviewedStepIds).size !== value.reviewedStepIds.length) return;
  const terminal = ['completed', 'lost', 'free-play'].includes(value.status as string), result = value.result === undefined ? undefined : parseMultiGameResult(value.result);
  if (terminal !== Object.hasOwn(value, 'result') || terminal && (!result || result.outcome !== (value.status === 'lost' ? 'lost' : 'won')) || ['completed', 'lost'].includes(value.status as string) && value.activeStepId !== undefined) return;
  // A loss can stop inside the final child's first level. That observation is
  // valid without claiming that every authored level in that child was reviewed.
  if (result && result.games.some(game => game.result.outcome === 'won' && !(value.reviewedStepIds as string[]).includes(game.stepId))) return;
  return structuredClone(value) as MultiGameProgress;
}

/** Convenience aggregation still passes through definition-aware validation. */
export function aggregateMultiGameResults(spec: MultiGameSpec, games: MultiGameResult['games'], materials: MultiGameResult['materials'], outcome: MultiGameResult['outcome'], wallElapsed: number): MultiGameResult | undefined {
  return validateMultiGameResult(spec, { outcome, elapsed: games.reduce((sum, game) => sum + game.result.elapsed, 0), wallElapsed, score: games.reduce((sum, game) => sum + game.result.score, 0), points: games.reduce((sum, game) => sum + multiGamePoints(game.result), 0), games, materials });
}
