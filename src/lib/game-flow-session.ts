import type { ArcadeGameSpec, GameResult } from './game-types';
import { validateGameResult } from './game-runtime';

export type MaterialStep = { id: string; type: 'material'; title: string; kind: 'lesson' | 'video' | 'exercise'; reference: string; required: boolean };
export type MaterialRequest = { runId: string; requestId: string; node: MaterialStep };
export type MaterialHandler = (request: MaterialRequest, signal: AbortSignal) => Promise<void>;
export type MaterialObservation = { nodeId: string; status: 'completed' | 'skipped'; elapsed: number };
export type FlowProgress = {
  runId: string; status: 'playing' | 'material' | 'won' | 'lost'; activeNodeId?: string;
  completedLevelIds: string[]; materials: MaterialObservation[];
  gameplayElapsed: number; wallElapsed: number; score: number; points?: number;
};

/** One validated result per level. Retries and UI messages never add points twice. */
export function aggregateFlowResults(spec: ArcadeGameSpec, values: GameResult[], outcome: GameResult['outcome']): GameResult | undefined {
  const order = spec.flow?.nodes.filter(node => node.type === 'level').map(node => node.levelId) || spec.levels?.map(level => level.id) || [];
  if (!values.length || values.length > order.length) return;
  const validated = values.map((value, index) => validateGameResult(value, spec, order[index]));
  if (validated.some((value, index) => !value || value.reviewedLevelIds.length !== 1 || index < values.length - 1 && value.outcome === 'lost')) return;
  if (outcome === 'won' && (values.length !== order.length || validated.some(value => value!.outcome === 'lost'))) return;
  if (outcome !== 'lost' && validated.some(value => value!.outcome === 'lost') || outcome === 'lost' && validated.at(-1)!.outcome !== 'lost') return;
  const result: GameResult = { outcome, score: 0, elapsed: 0, reviewedLevelIds: order.slice(0, values.length), ...(spec.version === 7 || spec.arcade?.scoring ? { points: 0 } : {}) };
  for (const value of validated) { result.score += value!.score; result.elapsed += value!.elapsed; if (result.points !== undefined) result.points += value!.points || 0; }
  return validateGameResult(result, spec);
}

export function materialReferenceValid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) && !value.includes('://') && !value.split('/').includes('..');
}

/** Telemetry contains counts and timing, never a student's answers or identity. */
export function parseFlowProgress(value: unknown): FlowProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const required = ['runId', 'status', 'completedLevelIds', 'materials', 'gameplayElapsed', 'wallElapsed', 'score'];
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => ![...required, 'activeNodeId', 'points'].includes(key))) return;
  if (typeof row.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.runId) || !['playing', 'material', 'won', 'lost'].includes(row.status as string)) return;
  if (row.activeNodeId !== undefined && (typeof row.activeNodeId !== 'string' || !/^step-(?:[1-9]|1[0-9]|2[0-4])$/.test(row.activeNodeId))) return;
  const bounded = (n: unknown, max: number, whole = false) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max && (!whole || Number.isSafeInteger(n));
  if (!bounded(row.gameplayElapsed, 1440) || !bounded(row.wallElapsed, 86400) || Number(row.wallElapsed) < Number(row.gameplayElapsed) || !bounded(row.score, 320, true) || row.points !== undefined && !bounded(row.points, 2_147_483_647, true)) return;
  if (!Array.isArray(row.completedLevelIds) || row.completedLevelIds.length > 8 || row.completedLevelIds.some(id => typeof id !== 'string' || !/^level-[1-8]$/.test(id)) || new Set(row.completedLevelIds).size !== row.completedLevelIds.length) return;
  if (!Array.isArray(row.materials) || row.materials.length > 23) return;
  const ids = new Set<string>();
  for (const material of row.materials) {
    if (!material || typeof material !== 'object' || Array.isArray(material) || Object.keys(material).sort().join(',') !== 'elapsed,nodeId,status' || typeof material.nodeId !== 'string' || !/^step-(?:[1-9]|1[0-9]|2[0-4])$/.test(material.nodeId) || ids.has(material.nodeId) || !['completed', 'skipped'].includes(material.status) || !bounded(material.elapsed, 86400)) return;
    ids.add(material.nodeId);
  }
  return structuredClone(row) as FlowProgress;
}
