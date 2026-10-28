import { validateGameSpec } from './game-design';
import { validateGameResult } from './game-runtime';
import type { Game } from './game-types';
import { isCooperativeGameSpec, isEndlessAsteroids } from './game-types';
import { parseFlowProgress, type FlowProgress } from './game-flow-session';
import { validateMultiGameResult } from './multi-game-session';

/** Host assignment rules, independent of game definitions and casual leaderboards. */
export type ScoringPolicy = {
  version: 1;
  max_points: number;
  method: 'proportional' | 'completion' | 'arcade_target';
  arcade_target?: number;
  rounding: 'whole' | 'hundredth';
  attempt_policy: 'first' | 'latest' | 'best';
  max_attempts: number;
  reveal_policy: 'zero' | 'earned';
};
export type ProvisionalPoints = {
  earned_points: number;
  max_points: number;
  numerator: number;
  denominator: number;
  method: ScoringPolicy['method'];
  provisional: true;
};
export type PublicationBinding = { game_id: string; published_revision: number; spec_sha256: string };
export type ScoringAttempt = { ordinal: number; earned_points: number };

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected a plain scoring object.');
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Scoring data has missing or unexpected fields.');
  return record;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

/** Missing reveal_policy normalizes to zero; unknown rules never silently disappear. */
export function validateScoringPolicy(value: unknown): ScoringPolicy {
  const p = object(value, ['version', 'max_points', 'method', 'rounding', 'attempt_policy', 'max_attempts'], ['arcade_target', 'reveal_policy']);
  if (p.version !== 1 || typeof p.method !== 'string' || !['proportional', 'completion', 'arcade_target'].includes(p.method) || typeof p.rounding !== 'string' || !['whole', 'hundredth'].includes(p.rounding) || typeof p.attempt_policy !== 'string' || !['first', 'latest', 'best'].includes(p.attempt_policy) || Object.hasOwn(p, 'reveal_policy') && (typeof p.reveal_policy !== 'string' || !['zero', 'earned'].includes(p.reveal_policy))) throw new Error('Unsupported assignment scoring policy.');
  if (p.method !== 'arcade_target' && Object.hasOwn(p, 'arcade_target')) throw new Error('Only arcade_target scoring accepts an arcade target.');
  return {
    version: 1,
    max_points: integer(p.max_points, 1, 10000, 'Maximum points'),
    method: p.method as ScoringPolicy['method'],
    ...(p.method === 'arcade_target' ? { arcade_target: integer(p.arcade_target, 1, 1000000, 'Arcade target') } : {}),
    rounding: p.rounding as ScoringPolicy['rounding'],
    attempt_policy: p.attempt_policy as ScoringPolicy['attempt_policy'],
    max_attempts: integer(p.max_attempts, 1, 100, 'Maximum attempts'),
    reveal_policy: p.reveal_policy as ScoringPolicy['reveal_policy'] || 'zero',
  };
}

/** A validated full definition supplies the denominator, never client-reported maxima. */
export function gameObjectiveUnits(value: unknown): number {
  const spec = validateGameSpec(value);
  if (spec.version === 8) throw new Error('Use scorePublishedMultiGame for a complete multi-game observation.');
  if (isCooperativeGameSpec(spec)) throw new Error('Cooperative-enabled editions require a future per-player scoring contract.');
  if (isEndlessAsteroids(spec)) throw new Error('Endless games have no finite objective total. Choose an explicit arcade target.');
  return spec.version === 3 ? spec.genre === 'crossword' ? spec.puzzle.entries.length : spec.genre === 'word-search' ? spec.puzzle.words.length : spec.puzzle.blanks.length : spec.version !== 1 ? spec.levels!.reduce((total, level) => total + level.rules.goal, 0) : spec.rules.goal;
}

/** Deterministic half-up arithmetic. This is a provisional observation, not a grade. */
export function calculateProvisionalPoints(specValue: unknown, resultValue: unknown, policyValue: unknown): ProvisionalPoints {
  const spec = validateGameSpec(specValue), policy = validateScoringPolicy(policyValue);
  if (spec.version === 8) throw new Error('Use scorePublishedMultiGame to validate and score the whole journey.');
  if (isCooperativeGameSpec(spec)) throw new Error('Cooperative-enabled editions do not award assignment points.');
  if (isEndlessAsteroids(spec) && policy.method !== 'arcade_target') throw new Error('Endless games require an explicit arcade target; finite completion and proportional scoring do not apply.');
  object(resultValue, ['outcome', 'elapsed', 'score', 'reviewedLevelIds', ...(spec.version === 7 || spec.version !== 3 && spec.arcade?.scoring ? ['points'] : [])]);
  const result = validateGameResult(resultValue, spec);
  if (!result || result.outcome === 'level-complete') throw new Error('Finish one valid complete game attempt before calculating points.');
  let numerator: number, denominator: number;
  if (policy.method === 'arcade_target') {
    if (spec.version === 3 || spec.version !== 7 && !spec.arcade?.scoring || result.points === undefined) throw new Error('Arcade target scoring requires an arcade game with point scoring enabled.');
    denominator = policy.arcade_target!; numerator = Math.min(result.points, denominator);
  } else if (policy.method === 'completion') {
    denominator = 1; numerator = result.outcome === 'won' ? 1 : 0;
  } else {
    denominator = gameObjectiveUnits(spec); numerator = result.score;
  }
  // A lost crossword currently means the player revealed the solution. Keep
  // pre-reveal earned counts only when the host explicitly chooses that rule.
  if (spec.version === 3 && spec.genre === 'crossword' && result.outcome === 'lost' && policy.reveal_policy === 'zero') numerator = 0;
  const factor = policy.rounding === 'whole' ? 1 : 100;
  const units = numerator * policy.max_points * factor;
  const earned_points = Math.floor((2 * units + denominator) / (2 * denominator)) / factor;
  return { earned_points, max_points: policy.max_points, numerator, denominator, method: policy.method, provisional: true };
}

/** Ordinals are issued by the host server. Browser timestamps do not order attempts. */
export function selectScoringAttempt(values: unknown, policyValue: unknown): ScoringAttempt | undefined {
  const policy = validateScoringPolicy(policyValue);
  if (!Array.isArray(values) || values.length > policy.max_attempts) throw new Error('The attempt history exceeds its approved policy.');
  const ordinals = new Set<number>();
  const attempts = values.map(value => {
    const row = object(value, ['ordinal', 'earned_points']), ordinal = integer(row.ordinal, 1, policy.max_attempts, 'Attempt ordinal');
    if (ordinals.has(ordinal)) throw new Error('Attempt ordinals must be unique.');
    ordinals.add(ordinal);
    const points = row.earned_points, factor = policy.rounding === 'whole' ? 1 : 100;
    if (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > policy.max_points || points !== Math.round(points * factor) / factor) throw new Error('An attempt has points outside its approved scale or precision.');
    return { ordinal, earned_points: points };
  }).sort((a, b) => a.ordinal - b.ordinal);
  if (policy.attempt_policy === 'latest') return attempts.at(-1);
  if (policy.attempt_policy === 'best') return attempts.reduce<ScoringAttempt | undefined>((best, next) => !best || next.earned_points > best.earned_points ? next : best, undefined);
  return attempts[0];
}

function published(value: unknown): Game {
  const row = object(value, ['id', 'spec', 'revision', 'status', 'publishedRevision', 'createdAt', 'updatedAt', 'publishedAt']);
  if (typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.id) || row.status !== 'Published' || row.revision !== row.publishedRevision) throw new Error('Use an exact current published game snapshot.');
  integer(row.publishedRevision, 1, 1000000000, 'Published revision');
  for (const key of ['createdAt', 'updatedAt', 'publishedAt']) if (typeof row[key] !== 'string' || (row[key] as string).length > 40 || !/[Tt].*(?:[Zz]|[+-]\d\d:\d\d)$/u.test(row[key] as string) || !Number.isFinite(Date.parse(row[key] as string))) throw new Error('The published snapshot has an invalid timestamp.');
  return { ...row, spec: validateGameSpec(row.spec) } as Game;
}

/** Matches backend canonical JSON for the supported schema: sorted ASCII keys,
 * integer-only numeric fields and literal Unicode. Reject lone surrogates rather
 * than silently replacing bytes during UTF-8 encoding. No provider is called. */
export async function createPublicationBinding(value: unknown): Promise<PublicationBinding> {
  const game = published(value);
  function canonical(item: unknown): string {
    if (typeof item === 'string') { if (/[\uD800-\uDFFF]/u.test(item)) throw new Error('Cannot hash invalid Unicode in a game definition.'); return JSON.stringify(item); }
    if (typeof item === 'number') { if (!Number.isSafeInteger(item)) throw new Error('Game definition hashes require integer numeric fields.'); return JSON.stringify(item); }
    if (typeof item === 'boolean') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}`;
    throw new Error('Unsupported value in a game definition.');
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(game.spec)));
  return { game_id: game.id, published_revision: game.publishedRevision!, spec_sha256: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}

/** Bind a scale calculation to the host's admitted immutable publication. The
 * host must still check enrollment, runtime and server-issued attempt authority. */
export async function scorePublishedGame(publication: unknown, expectedValue: unknown, result: unknown, policy: unknown): Promise<ProvisionalPoints> {
  const expected = { ...object(expectedValue, ['game_id', 'published_revision', 'spec_sha256']) };
  if (typeof expected.game_id !== 'string' || typeof expected.spec_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expected.spec_sha256)) throw new Error('An exact publication binding is required.');
  integer(expected.published_revision, 1, 1000000000, 'Published revision');
  // Freeze validated inputs before yielding to WebCrypto. A caller mutating its
  // original objects while hashing cannot change the edition or calculation.
  const snapshot = published(publication), points = calculateProvisionalPoints(snapshot.spec, result, policy);
  const actual = await createPublicationBinding(snapshot);
  if (expected.game_id !== actual.game_id || expected.published_revision !== actual.published_revision || expected.spec_sha256 !== actual.spec_sha256) throw new Error('The published game differs from the admitted assignment snapshot.');
  return points;
}

/** Check the whole route, including material after the last level. The host must
 * separately verify required completions against its own admitted activity records. */
export function validateFlowCompletion(specValue: unknown, progressValue: unknown, resultValue: unknown): FlowProgress {
  const spec = validateGameSpec(specValue), progress = parseFlowProgress(progressValue);
  if (spec.version === 3 || spec.version === 8 || !spec.flow || !progress || !['won', 'lost'].includes(progress.status)) throw new Error('A completed finite game flow is required.');
  const result = validateGameResult(resultValue, spec);
  if (!result || result.outcome !== progress.status || result.elapsed !== progress.gameplayElapsed || result.score !== progress.score || result.points !== progress.points) throw new Error('The flow and game observations disagree.');
  if (progress.materials.reduce((sum, item) => sum + item.elapsed, 0) + progress.gameplayElapsed > progress.wallElapsed + 0.001) throw new Error('Material timing exceeds the observed run duration.');
  const played = result.reviewedLevelIds, completed = result.outcome === 'lost' ? played.slice(0, -1) : played;
  if (JSON.stringify(progress.completedLevelIds) !== JSON.stringify(completed)) throw new Error('The flow has an invalid level completion order.');
  const lastPlayed = spec.flow.nodes.findIndex(node => node.type === 'level' && node.levelId === played.at(-1));
  const traversed = result.outcome === 'won' ? spec.flow.nodes : spec.flow.nodes.slice(0, lastPlayed);
  const materialNodes = traversed.filter(node => node.type === 'material');
  if (progress.materials.length !== materialNodes.length || materialNodes.some((node, index) => node.id !== progress.materials[index].nodeId || node.required && progress.materials[index].status !== 'completed')) throw new Error('The flow is missing a material step or required completion.');
  return progress;
}

export async function scorePublishedFlow(publication: unknown, binding: unknown, progress: unknown, result: unknown, policy: unknown): Promise<ProvisionalPoints> {
  const snapshot = published(publication);
  validateFlowCompletion(snapshot.spec, progress, result);
  return scorePublishedGame(snapshot, binding, result, policy);
}

/** Client-owned scale for a complete journey. Materials add no game points;
 * their required completion is validated separately from their subject matter.
 * The final continuous game is excluded from every finite denominator and total. */
export async function scorePublishedMultiGame(publication: unknown, expectedValue: unknown, resultValue: unknown, policyValue: unknown): Promise<ProvisionalPoints> {
  const expected = { ...object(expectedValue, ['game_id', 'published_revision', 'spec_sha256']) };
  if (typeof expected.game_id !== 'string' || typeof expected.spec_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expected.spec_sha256)) throw new Error('An exact publication binding is required.');
  integer(expected.published_revision, 1, 1000000000, 'Published revision');
  const snapshot = published(publication), policy = validateScoringPolicy(policyValue), result = validateMultiGameResult(snapshot.spec, resultValue);
  if (snapshot.spec.version !== 8 || !result) throw new Error('A valid complete multi-game observation is required.');
  const finiteGames = snapshot.spec.steps.filter(step => step.type === 'game');
  let numerator: number, denominator: number;
  if (policy.method === 'completion') { numerator = result.outcome === 'won' ? 1 : 0; denominator = 1; }
  else if (policy.method === 'arcade_target') {
    denominator = policy.arcade_target!;
    const observed = result.games.reduce((sum, game, index) => {
      const spec = finiteGames[index].spec;
      return sum + (spec.version === 3 && spec.genre === 'crossword' && game.result.outcome === 'lost' && policy.reveal_policy === 'zero' ? 0 : game.result.points ?? game.result.score * 10);
    }, 0);
    numerator = Math.min(observed, denominator);
  }
  else {
    denominator = finiteGames.reduce((sum, step) => sum + gameObjectiveUnits(step.spec), 0);
    numerator = result.games.reduce((sum, game, index) => {
      const spec = finiteGames[index].spec;
      return sum + (spec.version === 3 && spec.genre === 'crossword' && game.result.outcome === 'lost' && policy.reveal_policy === 'zero' ? 0 : game.result.score);
    }, 0);
  }
  const factor = policy.rounding === 'whole' ? 1 : 100, units = numerator * policy.max_points * factor;
  const points: ProvisionalPoints = { earned_points: Math.floor((2 * units + denominator) / (2 * denominator)) / factor, max_points: policy.max_points, numerator, denominator, method: policy.method, provisional: true };
  const actual = await createPublicationBinding(snapshot);
  if (expected.game_id !== actual.game_id || expected.published_revision !== actual.published_revision || expected.spec_sha256 !== actual.spec_sha256) throw new Error('The published game differs from the admitted snapshot.');
  return points;
}
