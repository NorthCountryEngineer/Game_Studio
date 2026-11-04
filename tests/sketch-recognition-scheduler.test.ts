import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSketchRecognitionScheduler, type SketchRecognitionTarget } from '../src/lib/sketch-recognition-scheduler';
import type { PartyRecognitionAck, PartyRoom, PartySession } from '../src/lib/party';

const ROOM = '11111111-1111-4111-8111-111111111111', HUMAN = '22222222-2222-4222-8222-222222222222', AI = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64), TOKEN = 't'.repeat(43);
const session: PartySession = { roomId: ROOM, playerId: HUMAN, token: TOKEN };
function room(patch: Record<string, any> = {}): PartyRoom { return { roomId: ROOM, kind: 'sketch-guess', status: 'playing', phase: 'draw', phaseId: 1, self: { id: HUMAN, isHost: true, actionSequence: 8 }, players: [{ id: HUMAN, name: 'Artist', avatar: 'fox', score: 0 }, { id: AI, name: 'AI', avatar: 'robot', score: 0, isAI: true }], game: { artistId: HUMAN, drawingEpoch: 0, inkSha256: HASH, strokes: [{ color: '#244b50', width: 5, points: [[.1, .2], [.3, .4]] }] }, ...patch } as PartyRoom; }
function ack(target: SketchRecognitionTarget, status: PartyRecognitionAck['status'] = 'ready'): PartyRecognitionAck { return { version: 1, roomId: target.roomId, phaseId: target.phaseId, drawingEpoch: target.drawingEpoch, inkSha256: target.inkSha256, status, retryAfterMs: 3000 }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(respond: (target: SketchRecognitionTarget, signal: AbortSignal) => Promise<PartyRecognitionAck>) {
  let clock = 0, next = 0; const timers = new Map<number, { at: number; run: () => void }>(), requests: { target: SketchRecognitionTarget; signal: AbortSignal; at: number }[] = [];
  const scheduler = createSketchRecognitionScheduler({ now: () => clock, setTimeout: (run, delay) => { const id = ++next; timers.set(id, { at: clock + delay, run }); return id; }, clearTimeout: id => { timers.delete(id); }, request: (target, signal) => { requests.push({ target, signal, at: clock }); return respond(target, signal); } });
  function advance(milliseconds = 0) { clock += milliseconds; let count = 0; for (;;) { const due = [...timers].filter(([, timer]) => timer.at <= clock); if (!due.length) return; assert.ok(++count < 20); for (const [id, timer] of due) { timers.delete(id); timer.run(); } } }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  return { scheduler, requests, advance, settle, timers };
}

test('recognition uses only authoritative public ink in an active human seat with an AI guesser', () => {
  const base = room();
  for (const [candidate, seat] of [
    [undefined, session], [base, undefined], [room({ kind: 'trivia' }), session], [room({ status: 'lobby' }), session], [room({ phase: 'reveal' }), session],
    [room({ self: { ...base.self, left: true } }), session], [room({ players: [base.players[0]] }), session],
    [room({ game: { ...base.game, artistId: AI } }), session], [room({ game: { ...base.game, strokes: [] } }), session],
    [room({ game: { ...base.game, inkSha256: undefined } }), session], [room({ game: { ...base.game, inkSha256: 'invalid' } }), session],
    [base, { ...session, playerId: AI }], [base, { ...session, roomId: AI }],
  ] as [PartyRoom | undefined, PartySession | undefined][]) {
    const h = harness(async target => ack(target)); h.scheduler.update(candidate, seat); h.advance(); assert.equal(h.requests.length, 0); h.scheduler.close();
  }
  const h = harness(async target => ack(target)); h.scheduler.update(base, session); h.advance(); assert.equal(h.requests.length, 1); assert.deepEqual(Object.keys(h.requests[0].target).sort(), ['drawingEpoch', 'inkSha256', 'phaseId', 'roomId', 'token']); assert.equal(h.requests[0].target.token, TOKEN); h.scheduler.close();
});

test('unchanged completed ink is not repeated, changing ink coalesces without parallel requests', async () => {
  const first = deferred<PartyRecognitionAck>(), second = deferred<PartyRecognitionAck>(); let calls = 0;
  const h = harness(async () => ++calls === 1 ? first.promise : second.promise), base = room();
  h.scheduler.update(base, session); h.advance(); h.scheduler.update(room({ game: { ...base.game, inkSha256: 'b'.repeat(64) } }), session); h.scheduler.update(room({ game: { ...base.game, inkSha256: 'c'.repeat(64) } }), session); h.advance(6000); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].signal.aborted, false);
  first.resolve(ack(h.requests[0].target)); await h.settle(); h.advance(); assert.equal(h.requests.length, 2); assert.equal(h.requests[1].target.inkSha256, 'c'.repeat(64)); assert.ok(h.requests[1].at - h.requests[0].at >= 3000);
  second.resolve(ack(h.requests[1].target, 'cached')); await h.settle(); h.scheduler.update(room({ game: { ...base.game, inkSha256: 'c'.repeat(64) } }), session); h.advance(60000); await h.settle(); assert.equal(h.requests.length, 2); h.scheduler.close(); assert.equal(h.timers.size, 0);
});

test('busy and network requests allow one initial attempt plus three retries per ink hash', async () => {
  for (const failing of ['busy', 'network']) {
    const h = harness(async target => { if (failing === 'network') throw new Error('Offline'); return ack(target, 'busy'); }); h.scheduler.update(room(), session); h.advance(); await h.settle();
    h.advance(2999); assert.equal(h.requests.length, 1); h.advance(1); await h.settle(); assert.equal(h.requests.length, 2); h.advance(3000); await h.settle(); assert.equal(h.requests.length, 3); h.advance(3000); await h.settle(); assert.equal(h.requests.length, 4); h.advance(60000); await h.settle(); assert.equal(h.requests.length, 4); assert.deepEqual(h.requests.map(request => request.at), [0, 3000, 6000, 9000]); h.scheduler.close();
  }
});

test('a three-minute round can reach its nine-second server cadence and completed static ink never repeats', async () => {
  let calls = 0; const h = harness(async target => ack(target, ++calls < 4 ? 'busy' : 'ready')), current = room({ settings: { roundSeconds: 180 } });
  h.scheduler.update(current, session); h.advance(); await h.settle();
  for (let retry = 0; retry < 3; retry++) { h.advance(3000); await h.settle(); }
  assert.equal(h.requests.length, 4); assert.deepEqual(h.requests.map(request => request.at), [0, 3000, 6000, 9000]);
  h.scheduler.update(current, session); h.advance(180000); await h.settle(); assert.equal(h.requests.length, 4); assert.equal(h.timers.size, 0); h.scheduler.close();
});

test('phase, clear, room and session changes abort and fence old work without waiting on old promises', async () => {
  for (const change of ['phase', 'epoch', 'room', 'token', 'clear']) {
    const pending: ReturnType<typeof deferred<PartyRecognitionAck>>[] = [], h = harness(async () => { const d = deferred<PartyRecognitionAck>(); pending.push(d); return d.promise; }), base = room();
    h.scheduler.update(base, session); h.advance(); let next = room(), seat = session;
    if (change === 'phase') next = room({ phaseId: 2 });
    if (change === 'epoch') next = room({ game: { ...base.game, drawingEpoch: 1 } });
    if (change === 'room') { next = room({ roomId: AI }); seat = { ...session, roomId: AI }; }
    if (change === 'token') seat = { ...session, token: 'u'.repeat(43) };
    if (change === 'clear') next = room({ game: { ...base.game, drawingEpoch: 1, strokes: [], inkSha256: undefined } });
    h.scheduler.update(next, seat); assert.equal(h.requests[0].signal.aborted, true); h.advance(3000);
    assert.equal(h.requests.length, change === 'clear' ? 1 : 2); pending[0].resolve(ack(h.requests[0].target)); await h.settle();
    if (change !== 'clear') { assert.equal(h.requests[1].signal.aborted, false); pending[1].resolve(ack(h.requests[1].target)); await h.settle(); }
    h.advance(30000); await h.settle(); assert.equal(h.requests.length, change === 'clear' ? 1 : 2); h.scheduler.close(); assert.equal(h.timers.size, 0);
  }
});

test('unmount cancels scheduled work and aborts active recognition while late success remains inert', async () => {
  const d = deferred<PartyRecognitionAck>(), h = harness(async () => d.promise); h.scheduler.update(room(), session); h.advance(); h.scheduler.close(); assert.equal(h.requests[0].signal.aborted, true); d.resolve(ack(h.requests[0].target)); await h.settle(); h.advance(60000); h.scheduler.update(room(), session); h.advance(); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
  const idle = harness(async target => ack(target)); idle.scheduler.update(room(), session); idle.scheduler.close(); idle.advance(); assert.equal(idle.requests.length, 0);
});
