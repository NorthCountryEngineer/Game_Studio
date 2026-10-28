import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlatformerSpec } from '../src/lib/game-flow.ts';
import { aggregateFlowResults, parseFlowProgress } from '../src/lib/game-flow-session.ts';
import { parseGameStudioEvent, mountGame, calculateProvisionalPoints, validateFlowCompletion, createPublicationBinding, scorePublishedFlow } from '../src/lib/integration.ts';
import { parseMaterialResponse, requestHostMaterial } from '../src/lib/game-flow-integration.ts';
import type { FlowProgress } from '../src/lib/game-flow-session.ts';
import type { GameResult } from '../src/lib/game-types.ts';

const gameId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333';
const node = { id: 'step-3', type: 'material' as const, title: 'Practice activity', kind: 'exercise' as const, reference: 'ncacademy:assignment-123', required: true };
const binding = { channel: 'classroom-channel', gameId, publishedRevision: 2 };
const request = { runId, requestId, node };
const response = { source: 'nce-game-host', version: 3, type: 'material-result', ...binding, runId, requestId, nodeId: node.id, status: 'completed' };
function fixture() {
  const spec = createPlatformerSpec(); spec.levels = spec.levels!.slice(0, 2); spec.levels.forEach(level => { level.rules.goal = 3; });
  spec.flow = { version: 1, nodes: [{ id: 'step-1', type: 'menu', title: 'Adventure map' }, { id: 'step-2', type: 'level', levelId: 'level-2' }, node, { id: 'step-4', type: 'level', levelId: 'level-1' }, { ...node, id: 'step-5', title: 'Final reflection', required: false }] };
  const levels: GameResult[] = ['level-2', 'level-1'].map(id => ({ outcome: 'level-complete', score: 3, points: 30, elapsed: 12, reviewedLevelIds: [id] }));
  const result = aggregateFlowResults(spec, levels, 'won')!;
  const progress: FlowProgress = { runId, status: 'won', completedLevelIds: ['level-2', 'level-1'], materials: [{ nodeId: 'step-3', status: 'completed', elapsed: 25 }, { nodeId: 'step-5', status: 'skipped', elapsed: 2 }], gameplayElapsed: 24, wallElapsed: 51, score: 6, points: 60 };
  return { spec, levels, result, progress };
}

test('flow aggregates actual level order once; full score and active timing exclude materials', () => {
  const { spec, levels, result, progress } = fixture();
  assert.deepEqual(result, { outcome: 'won', elapsed: 24, score: 6, points: 60, reviewedLevelIds: ['level-2', 'level-1'] });
  assert.equal(aggregateFlowResults(spec, [levels[0], levels[0]], 'won'), undefined);
  assert.equal(aggregateFlowResults(spec, [levels[0]], 'won'), undefined);
  assert.equal(aggregateFlowResults(spec, [...levels].reverse(), 'won'), undefined);
  assert.equal(aggregateFlowResults(spec, levels, 'lost'), undefined);
  assert.deepEqual(validateFlowCompletion(spec, progress, result), progress);
  const policy = { version: 1, max_points: 25, method: 'arcade_target', arcade_target: 120, rounding: 'hundredth', attempt_policy: 'best', max_attempts: 3 };
  assert.equal(calculateProvisionalPoints(spec, result, policy).earned_points, 12.5);
  assert.equal(calculateProvisionalPoints(spec, result, { ...policy, max_points: 100 }).earned_points, 50);
});

test('a flow award binds exact material and level definition, and partial loss retains valid observed points', async () => {
  const { spec, result, progress } = fixture();
  const publication = { id: gameId, spec, revision: 2, publishedRevision: 2, status: 'Published', createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-28T12:00:00Z', publishedAt: '2026-10-28T12:00:00Z' };
  const policy = { version: 1, max_points: 100, method: 'completion', rounding: 'whole', attempt_policy: 'first', max_attempts: 1 };
  const hash = await createPublicationBinding(publication);
  assert.equal((await scorePublishedFlow(publication, hash, progress, result, policy)).earned_points, 100);
  const changed = structuredClone(publication); changed.spec.flow!.nodes[2] = { ...node, reference: 'ncacademy:changed-assignment' };
  await assert.rejects(scorePublishedFlow(changed, hash, progress, result, policy), /differs/);
  const lost = aggregateFlowResults(spec, [{ outcome: 'lost', elapsed: 6, score: 1, points: 10, reviewedLevelIds: ['level-2'] }], 'lost')!;
  const partial: FlowProgress = { ...progress, status: 'lost', completedLevelIds: [], materials: [], gameplayElapsed: 6, wallElapsed: 10, score: 1, points: 10 };
  assert.ok(validateFlowCompletion(spec, partial, lost));
  assert.equal(calculateProvisionalPoints(spec, lost, { ...policy, method: 'proportional' }).earned_points, 17);
});

test('required materials and trailing activities must complete before a full flow win', () => {
  const { spec, result, progress } = fixture();
  for (const materials of [[], progress.materials.slice(0, 1), [...progress.materials].reverse(), [{ ...progress.materials[0], status: 'skipped' }, progress.materials[1]]]) assert.throws(() => validateFlowCompletion(spec, { ...progress, materials }, result));
  assert.throws(() => validateFlowCompletion(spec, { ...progress, completedLevelIds: ['level-1', 'level-2'] }, result));
  assert.throws(() => validateFlowCompletion(spec, { ...progress, points: 999 }, result));
  assert.throws(() => validateFlowCompletion(spec, { ...progress, wallElapsed: 25 }, result));
});

test('version3 telemetry rejects extra identity/answer fields, invalid bounds and premature completion', () => {
  const { progress, result } = fixture();
  const event = { source: 'nce-game-studio', version: 3, type: 'flow-progress', ...binding, progress, result };
  assert.ok(parseGameStudioEvent(event));
  assert.equal(parseGameStudioEvent({ ...event, studentId: 'private' }), undefined);
  assert.equal(parseGameStudioEvent({ ...event, result: { ...result, answers: ['private'] } }), undefined);
  assert.equal(parseGameStudioEvent({ ...event, progress: { ...progress, materials: [{ ...progress.materials[0], answers: 'private' }] } }), undefined);
  assert.equal(parseGameStudioEvent({ ...event, result: undefined }), undefined);
  assert.equal(parseGameStudioEvent({ ...event, progress: { ...progress, status: 'material' } }), undefined);
  assert.equal(parseFlowProgress({ ...progress, wallElapsed: 10 }), undefined);
  assert.equal(parseFlowProgress({ ...progress, runId: '-'.repeat(36) }), undefined);
  const material = { source: 'nce-game-studio', version: 3, type: 'material-request', ...binding, ...request };
  assert.ok(parseGameStudioEvent(material));
  for (const reference of ['https://evil.example/lesson', '../../secrets', 'javascript:alert(1)']) assert.equal(parseGameStudioEvent({ ...material, node: { ...node, reference } }), undefined);
  assert.equal(parseMaterialResponse({ ...response, accessToken: 'never-accepted' }), undefined);
});

test('material gate binds parent window, exact origin, edition, run, request, node and cancellation', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Set<(event: MessageEvent) => void>(), sent: unknown[] = [];
  const target = { postMessage(value: unknown, origin: string) { assert.equal(origin, 'https://academy.example'); sent.push(value); } } as Window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_: string, receive: (event: MessageEvent) => void) => listeners.add(receive), removeEventListener: (_: string, receive: (event: MessageEvent) => void) => listeners.delete(receive) } });
  const send = (data: unknown, origin = 'https://academy.example', source: unknown = target) => { for (const receive of listeners) receive({ data, origin, source } as MessageEvent); };
  try {
    let done = false; const controller = new AbortController();
    const waiting = requestHostMaterial(target, 'https://academy.example', binding, request, controller.signal).then(() => { done = true; });
    assert.equal(sent.length, 1);
    send(response, 'https://evil.example'); send(response, undefined, {});
    for (const patch of [{ channel: 'other' }, { publishedRevision: 3 }, { runId: requestId }, { requestId: runId }, { nodeId: 'step-4' }, { gameId: runId }, { token: 'private' }]) send({ ...response, ...patch });
    await Promise.resolve(); assert.equal(done, false); assert.equal(listeners.size, 1);
    send(response); await waiting; assert.equal(done, true); assert.equal(listeners.size, 0);
    send(response); assert.equal(listeners.size, 0);
    const abort = new AbortController(); const cancelled = requestHostMaterial(target, 'https://academy.example', binding, request, abort.signal);
    abort.abort(); await assert.rejects(cancelled, /cancelled/); assert.equal(listeners.size, 0);
    const unavailable = requestHostMaterial(target, 'https://academy.example', binding, request, new AbortController().signal);
    send({ ...response, status: 'unavailable' }); await assert.rejects(unavailable, /unavailable/); assert.equal(listeners.size, 0);
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('host SDK material controls reply once and become inert after destroy', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Set<(event: MessageEvent) => void>(), replies: unknown[] = [];
  const player = { postMessage(value: unknown, origin: string) { assert.equal(origin, 'https://games.example'); replies.push(value); } };
  const frame = { src: '', title: '', style: {}, sandbox: { add() {} }, contentWindow: player, remove() {} };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.add(fn), removeEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.delete(fn) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => frame } });
  let controls: { complete: () => void; unavailable: () => void } | undefined, calls = 0;
  try {
    const mounted = mountGame({ append() {} } as unknown as HTMLElement, { studioOrigin: 'https://games.example', gameId, hostId: 'academy', onMaterial(_event, value) { calls++; controls = value; } });
    const channel = new URL(frame.src).searchParams.get('channel');
    const event = { source: 'nce-game-studio', version: 3, type: 'material-request', ...binding, channel, ...request };
    for (const receive of listeners) receive({ data: event, origin: 'https://games.example', source: player } as unknown as MessageEvent);
    for (const receive of listeners) receive({ data: event, origin: 'https://games.example', source: player } as unknown as MessageEvent);
    assert.equal(calls, 1); controls!.complete(); controls!.unavailable(); assert.equal(replies.length, 1);
    assert.equal((replies[0] as typeof response).requestId, requestId);
    for (const receive of listeners) receive({ data: { ...event, requestId: runId }, origin: 'https://games.example', source: player } as unknown as MessageEvent);
    mounted.destroy(); controls!.complete(); assert.equal(replies.length, 1);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
