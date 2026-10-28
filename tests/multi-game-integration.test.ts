import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { defaultMultiGameSpec, validateMultiGameSpec } from '../src/lib/multi-game';
import { defaultGameSpec, updateAsteroidSettings } from '../src/lib/game-design';
import { createPlatformerSpec } from '../src/lib/game-flow';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { aggregateMultiGameResults, parseMultiGameResult, parseMultiGameProgress, validateMultiGameResult, type MultiGameProgress } from '../src/lib/multi-game-session';
import { requestMultiHostMaterial, parseMultiMaterialResponse } from '../src/lib/multi-game-integration';
import { calculateProvisionalPoints, createPublicationBinding, mountGame, parseGameStudioEvent, scorePublishedMultiGame } from '../src/lib/integration';
import type { GameResult, SingleGameSpec } from '../src/lib/game-types';
import type { FlowProgress } from '../src/lib/game-flow-session';

const gameId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333';
const binding = { channel: 'client-channel', gameId, publishedRevision: 2 };
const node = { id: 'step-2', type: 'material' as const, title: 'Client object', kind: 'interactive' as const, reference: 'client:object-123', required: true };
const request = { runId, requestId, path: ['step-2'], node };
const response = { source: 'nce-game-host', version: 4, type: 'material-result', ...binding, runId, requestId, path: ['step-2'], status: 'completed' };
function gameResult(spec: SingleGameSpec, elapsed = 10): GameResult {
  const score = spec.version === 3 ? spec.genre === 'crossword' ? spec.puzzle.entries.length : spec.genre === 'word-search' ? spec.puzzle.words.length : spec.puzzle.blanks.length : spec.levels!.reduce((sum, level) => sum + level.rules.goal, 0);
  return { outcome: 'won', elapsed, score, reviewedLevelIds: spec.version === 3 ? ['level-1'] : spec.levels!.map(level => level.id), ...(spec.version === 7 ? { points: score * 10 } : {}) };
}
function fixture() {
  const platformer = createPlatformerSpec(); platformer.levels = platformer.levels!.slice(0, 1); platformer.levels[0].rules.goal = 3;
  platformer.flow = { version: 1, nodes: [{ id: 'step-1', type: 'level', levelId: 'level-1' }, { ...node, id: 'step-2', kind: 'exercise' }] };
  const crossword = defaultWordGameSpec('crossword'), search = defaultWordGameSpec('word-search');
  const endless = updateAsteroidSettings({ ...defaultGameSpec(), genre: 'dodge', arcade: { rotation: true, shooting: true, scoring: true, highScores: true, splitAsteroids: true } }, { endless: true });
  const spec = validateMultiGameSpec({ ...defaultMultiGameSpec(), steps: [{ id: 'step-1', type: 'game', spec: crossword }, node, { id: 'step-3', type: 'game', spec: platformer }, { id: 'step-4', type: 'game', spec: search }, { id: 'step-5', type: 'free-play', spec: endless }] });
  const child = gameResult(platformer), flow: FlowProgress = { runId, status: 'won', completedLevelIds: ['level-1'], materials: [{ nodeId: 'step-2', status: 'completed', elapsed: 7 }], gameplayElapsed: 10, wallElapsed: 17, score: child.score, points: child.points };
  const games = [{ stepId: 'step-1', result: gameResult(crossword) }, { stepId: 'step-3', result: child, flow }, { stepId: 'step-4', result: gameResult(search) }];
  const materials = [{ path: ['step-2'], status: 'completed' as const, elapsed: 5 }];
  const result = aggregateMultiGameResults(spec, games, materials, 'won', 42)!;
  assert.ok(result);
  return { spec, games, materials, result };
}
const publication = (spec: unknown) => ({ id: gameId, spec, revision: 2, publishedRevision: 2, status: 'Published', createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-28T12:00:00Z', publishedAt: '2026-10-28T12:00:00Z' });

test('multi-game totals include each finite game once and exclude the final perpetual game', () => {
  const { spec, result, games } = fixture();
  assert.equal(result.elapsed, 30); assert.equal(result.wallElapsed, 42);
  assert.equal(result.points, result.score * 10); assert.equal(result.games.length, 3);
  assert.deepEqual(validateMultiGameResult(spec, result), result);
  for (const gamesValue of [[...games].reverse(), [games[0], games[0], games[2]], games.slice(0, 2), [...games, { ...games[0], stepId: 'step-5' }]]) {
    assert.equal(validateMultiGameResult(spec, { ...result, games: gamesValue }), undefined);
  }
  assert.equal(validateMultiGameResult(spec, { ...result, points: result.points + 10 }), undefined);
  assert.equal(validateMultiGameResult(spec, { ...result, elapsed: 31 }), undefined);
});

test('required outer and inner objects, correct paths, and separate timing are part of completion', () => {
  const { spec, result } = fixture();
  for (const materials of [[], [{ ...result.materials[0], status: 'skipped' }], [{ ...result.materials[0], path: ['step-3', 'step-2'] }], [{ ...result.materials[0], path: ['step-4'] }]]) assert.equal(validateMultiGameResult(spec, { ...result, materials }), undefined);
  const missingInner = structuredClone(result); missingInner.games[1].flow!.materials = [];
  assert.equal(validateMultiGameResult(spec, missingInner), undefined);
  const noFlow = structuredClone(result); delete noFlow.games[1].flow;
  assert.equal(validateMultiGameResult(spec, noFlow), undefined);
  assert.equal(validateMultiGameResult(spec, { ...result, wallElapsed: 31 }), undefined);
  assert.equal(validateMultiGameResult(spec, { ...result, games: result.games.map(game => ({ ...game, result: { ...game.result, identity: 'private' } })) }), undefined);
});

test('loss validates only the traversed prefix and cannot claim later material or game completions', () => {
  const { spec, games, materials } = fixture();
  const lost = { ...games[1], result: { ...games[1].result, outcome: 'lost' as const, score: 1, points: 10 }, flow: { ...games[1].flow!, status: 'lost' as const, completedLevelIds: [], materials: [], wallElapsed: 10, score: 1, points: 10 } };
  const result = aggregateMultiGameResults(spec, [games[0], lost], materials, 'lost', 25);
  assert.ok(result); assert.equal(result.outcome, 'lost');
  assert.equal(validateMultiGameResult(spec, { ...result, outcome: 'won' }), undefined);
  assert.equal(aggregateMultiGameResults(spec, [lost], materials, 'lost', 25), undefined);
});

test('v4 observations are strict, identity-free and carry a frozen finite result during free play', () => {
  const { result } = fixture();
  const progress: MultiGameProgress = { runId, status: 'completed', reviewedStepIds: ['step-1', 'step-2', 'step-3', 'step-4'], result };
  const event = { source: 'nce-game-studio', version: 4, type: 'multi-progress', ...binding, progress };
  assert.ok(parseGameStudioEvent(event)); assert.ok(parseGameStudioEvent({ ...event, progress: { ...progress, status: 'free-play', activeStepId: 'step-5' } }));
  for (const invalid of [{ ...event, userId: 'private' }, { ...event, progress: { ...progress, result: { ...result, answers: ['private'] } } }, { ...event, progress: { ...progress, status: 'playing' } }, { ...event, progress: { ...progress, result: undefined } }, { ...event, progress: { ...progress, activeStepId: 'step-5' } }]) assert.equal(parseGameStudioEvent(invalid), undefined);
  assert.equal(parseMultiGameProgress({ ...progress, reviewedStepIds: ['step-1'] }), undefined);
  assert.equal(parseMultiGameResult({ ...result, wallElapsed: 86401 }), undefined);
  const long = structuredClone(result); long.games[0].result.elapsed = 1800; long.elapsed = 1820; long.wallElapsed = 1832;
  assert.ok(parseMultiGameResult(long), 'A word game may take longer than a timed arcade level.');
});

test('a multi-level child loss is reportable without claiming all child levels were reviewed', () => {
  const child = createPlatformerSpec(); delete child.flow;
  const spec = validateMultiGameSpec({ ...defaultMultiGameSpec(), steps: [{ id: 'step-1', type: 'game', spec: child }, { id: 'step-2', type: 'game', spec: defaultWordGameSpec('word-search') }] });
  const lost = { outcome: 'lost' as const, elapsed: 10, score: 1, points: 10, reviewedLevelIds: ['level-1'] };
  const result = aggregateMultiGameResults(spec, [{ stepId: 'step-1', result: lost }], [], 'lost', 10); assert.ok(result);
  const progress = { runId, status: 'lost', reviewedStepIds: [], result };
  assert.ok(parseMultiGameProgress(progress));
  assert.ok(parseGameStudioEvent({ source: 'nce-game-studio', version: 4, type: 'multi-progress', ...binding, progress }));
});

test('published multi-game scales bind all definitions, validate completion and keep client policy separate', async () => {
  const { spec, result } = fixture(), game = publication(spec), hash = await createPublicationBinding(game);
  const policy = { version: 1, max_points: 25, method: 'completion', rounding: 'hundredth', attempt_policy: 'best', max_attempts: 3 };
  assert.equal((await scorePublishedMultiGame(game, hash, result, policy)).earned_points, 25);
  assert.equal((await scorePublishedMultiGame(game, hash, result, { ...policy, method: 'proportional', max_points: 100 })).earned_points, 100);
  assert.equal((await scorePublishedMultiGame(game, hash, result, { ...policy, method: 'arcade_target', arcade_target: result.points * 2 })).earned_points, 12.5);
  assert.throws(() => calculateProvisionalPoints(spec, result, policy), /scorePublishedMultiGame/);
  const changed = structuredClone(game); changed.spec.steps[1] = { ...node, reference: 'client:changed' };
  await assert.rejects(scorePublishedMultiGame(changed, hash, result, policy), /differs/);
  await assert.rejects(scorePublishedMultiGame(game, hash, { ...result, materials: [] }, policy), /valid complete/);
  const scoring = scorePublishedMultiGame(game, hash, result, policy);
  game.spec.title = 'Changed while hashing'; result.points = 99; policy.max_points = 100; hash.published_revision = 50;
  assert.equal((await scoring).earned_points, 25);
});

test('multi-game publication hashes match canonical Python bytes including copied child definitions', async () => {
  const { spec } = fixture(); spec.title = 'Café 🌎 journey';
  const hash = await createPublicationBinding(publication(spec));
  const expected = execFileSync('python3', ['-c', 'import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest())'], { input: JSON.stringify(spec), encoding: 'utf8' }).trim();
  assert.equal(hash.spec_sha256, expected);
});

test('a lost crossword reveal contributes only when the client explicitly allows earned counts', async () => {
  const spec = defaultMultiGameSpec(), first = spec.steps[0]; assert.equal(first.type, 'game');
  if (first.type !== 'game') throw new Error('Expected a game.');
  const observed = { ...gameResult(first.spec), outcome: 'lost' as const, score: 1 }, result = aggregateMultiGameResults(spec, [{ stepId: first.id, result: observed }], [], 'lost', 10)!;
  const game = publication(spec), hash = await createPublicationBinding(game);
  const policy = { version: 1, max_points: 100, method: 'arcade_target', arcade_target: 20, rounding: 'whole', attempt_policy: 'first', max_attempts: 1 };
  assert.equal((await scorePublishedMultiGame(game, hash, result, policy)).earned_points, 0);
  assert.equal((await scorePublishedMultiGame(game, hash, result, { ...policy, reveal_policy: 'earned' })).earned_points, 50);
  const { arcade_target: _target, ...scale } = policy;
  assert.equal((await scorePublishedMultiGame(game, hash, result, { ...scale, method: 'proportional' })).earned_points, 0);
});

test('v4 material requests bind exact window, origin, edition, run, request, nested path and cancellation', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Set<(event: MessageEvent) => void>(), sent: unknown[] = [];
  const target = { postMessage(value: unknown, origin: string) { assert.equal(origin, 'https://client.example'); sent.push(value); } } as Window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_: string, listener: (event: MessageEvent) => void) => listeners.add(listener), removeEventListener: (_: string, listener: (event: MessageEvent) => void) => listeners.delete(listener) } });
  const send = (data: unknown, origin = 'https://client.example', source: unknown = target) => { for (const listener of listeners) listener({ data, origin, source } as MessageEvent); };
  try {
    const nested = { ...request, path: ['step-3', 'step-2'], node: { ...node, kind: 'exercise' as const } }, answer = { ...response, path: nested.path };
    let done = false; const waiting = requestMultiHostMaterial(target, 'https://client.example', binding, nested, new AbortController().signal).then(() => { done = true; });
    assert.equal(sent.length, 1); nested.path[0] = 'step-4';
    send(answer, 'https://evil.example'); send(answer, undefined, {});
    for (const patch of [{ path: ['step-2'] }, { path: ['step-4', 'step-2'] }, { publishedRevision: 3 }, { gameId: runId }, { runId: requestId }, { requestId: runId }, { channel: 'other' }, { token: 'private' }]) send({ ...answer, ...patch });
    await Promise.resolve(); assert.equal(done, false);
    send({ ...answer, path: ['step-3', 'step-2'] }); await waiting; assert.equal(done, true); assert.equal(listeners.size, 0);
    const controller = new AbortController(), aborted = requestMultiHostMaterial(target, 'https://client.example', binding, request, controller.signal); controller.abort();
    await assert.rejects(aborted, /cancelled/); assert.equal(listeners.size, 0);
    const unavailable = requestMultiHostMaterial(target, 'https://client.example', binding, request, new AbortController().signal); send({ ...response, status: 'unavailable' }); await assert.rejects(unavailable, /unavailable/);
    await assert.rejects(requestMultiHostMaterial(target, '*', binding, request, new AbortController().signal), /exact/);
    assert.equal(parseMultiMaterialResponse({ ...response, path: ['step-1', 'step-25'] }), undefined);
    assert.equal(parseGameStudioEvent({ source: 'nce-game-studio', version: 4, type: 'material-request', ...binding, ...request, node: { ...node, reference: 'https://example.com' } }), undefined);
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('mountGame v4 adapter replies once to the immutable path and stale controls are inert', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Set<(event: MessageEvent) => void>(), replies: unknown[] = [], controls: { complete: () => void; unavailable: () => void }[] = [];
  const player = { postMessage(value: unknown) { replies.push(value); } }, frame = { src: '', title: '', style: {}, sandbox: { add() {} }, contentWindow: player, remove() {} };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_: string, listener: (event: MessageEvent) => void) => listeners.add(listener), removeEventListener: (_: string, listener: (event: MessageEvent) => void) => listeners.delete(listener) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => frame } });
  try {
    const mounted = mountGame({ append() {} } as unknown as HTMLElement, { studioOrigin: 'https://games.example', gameId, hostId: 'client', onMaterial(event, value) { controls.push(value); if (event.version === 4) event.path[0] = 'step-9'; } });
    const event = { source: 'nce-game-studio', version: 4, type: 'material-request', ...binding, channel: new URL(frame.src).searchParams.get('channel'), ...request };
    const send = (value: unknown) => { for (const listener of listeners) listener({ data: value, origin: 'https://games.example', source: player } as unknown as MessageEvent); };
    send(event); send(event); assert.equal(controls.length, 1); controls[0].complete(); controls[0].unavailable();
    assert.deepEqual((replies[0] as typeof response).path, ['step-2']); assert.equal((replies[0] as typeof response).version, 4); assert.equal(replies.length, 1);
    send({ ...event, requestId: runId }); send({ ...event, requestId: gameId }); controls[1].complete(); assert.equal(replies.length, 1);
    mounted.destroy(); controls[2].complete(); assert.equal(replies.length, 1);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
