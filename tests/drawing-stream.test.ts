import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DrawingStream, type DrawingAction, type DrawingSendResult } from '../src/lib/drawing-stream';

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
function setup(send: (action: DrawingAction) => Promise<DrawingSendResult> = async () => 'accepted') {
  let time = 0, id = 0, timerId = 0, changes = 0;
  const timers = new Map<number, { at: number; fn: () => void }>(), calls: DrawingAction[] = [];
  const stream = new DrawingStream(() => changes++, { now: () => time, id: () => `segment-${++id}`, later: (fn, delay) => { timers.set(++timerId, { at: time + delay, fn }); return timerId; }, cancel: timer => { timers.delete(timer as number); } });
  const sender = async (action: DrawingAction) => { calls.push(action); return send(action); };
  stream.update('room:1', 0, true, [], sender);
  async function advance(ms = 500) { time += ms; const due = [...timers].filter(([, timer]) => timer.at <= time); for (const [key, timer] of due) { timers.delete(key); timer.fn(); } for (let i = 0; i < 10; i++) await Promise.resolve(); }
  return { stream, calls, advance, timers, sender, changes: () => changes };
}
const brush = ['#244b50', 5] as const;
test('a held stroke stays local immediately, streams before release and crosses 120 points seamlessly', async () => {
  const pending = deferred<DrawingSendResult>(), s = setup(() => pending.promise);
  assert.equal(s.stream.begin(1, [0, .5], ...brush), true);
  for (let i = 1; i <= 350; i++) s.stream.move(1, [i / 400, .5 + .1 * Math.sin(i)]);
  assert.ok(s.stream.ink.length >= 3); assert.equal(s.calls.length, 0);
  assert.equal(s.stream.ink.at(-1)!.points.at(-1)![0], .875);
  for (let i = 1; i < s.stream.ink.length; i++) assert.deepEqual(s.stream.ink[i - 1].points.at(-1), s.stream.ink[i].points[0]);
  await s.advance(); assert.equal(s.calls.length, 1); assert.equal(s.stream.pointerId, 1);
  for (let i = 351; i <= 700; i++) s.stream.move(1, [i / 800, .5 + .1 * Math.sin(i)]);
  assert.equal(s.stream.pointerId, 1); assert.ok(s.stream.ink.reduce((n, stroke) => n + stroke.points.length, 0) > 700);
  s.stream.end(1); pending.resolve('accepted'); await s.advance(); s.stream.dispose();
});
test('rapid new strokes and taps remain visible while an earlier save is delayed', async () => {
  const pending = deferred<DrawingSendResult>(), s = setup(() => pending.promise);
  s.stream.begin(1, [.1, .1], ...brush); s.stream.end(1, [.2, .2]); await s.advance();
  for (let i = 0; i < 20; i++) { assert.equal(s.stream.begin(i + 2, [i / 30, .4], ...brush), true); s.stream.end(i + 2); }
  assert.equal(s.stream.ink.length, 21); assert.equal(s.calls.length, 1); assert.equal(s.stream.ink.at(-1)!.points.length, 2);
  await s.advance(3000); assert.equal(s.calls.length, 1); pending.resolve('accepted'); await s.advance(); await s.advance(); assert.equal(s.calls.length, 2); s.stream.dispose();
});
test('an ambiguous response retries the immutable batch and retains its ink until acknowledgment', async () => {
  let count = 0; const s = setup(async () => ++count === 1 ? 'retry' : 'accepted');
  s.stream.begin(1, [.1, .1], ...brush); s.stream.end(1, [.2, .2]); await s.advance();
  const first = JSON.stringify(s.calls[0]); s.stream.begin(2, [.3, .3], ...brush); s.stream.end(2, [.4, .4]);
  await s.advance(); assert.equal(JSON.stringify(s.calls[1]), first); assert.equal(s.stream.ink.length, 2);
  const ack = (s.calls[0] as Extract<DrawingAction, { type: 'drawing-batch' }>).segments.map(segment => segment.id);
  s.stream.update('room:1', 0, true, ack, s.sender); assert.equal(s.stream.ink.length, 1); await s.advance(); assert.equal(s.calls.length, 3); s.stream.dispose();
});
test('poll acknowledgment resolves an unknown commit without sending another copy', async () => {
  const pending = deferred<DrawingSendResult>(), s = setup(() => pending.promise);
  s.stream.begin(1, [.1, .1], ...brush); s.stream.end(1, [.2, .2]); await s.advance();
  const ack = (s.calls[0] as Extract<DrawingAction, { type: 'drawing-batch' }>).segments.map(segment => segment.id);
  s.stream.update('room:1', 0, true, ack, s.sender); pending.resolve('retry'); await s.advance(); await s.advance();
  assert.equal(s.calls.length, 1); assert.equal(s.stream.ink.length, 0); s.stream.dispose();
});
test('clear waits behind an unknown write, hides old ink, then shares new ink in the next epoch', async () => {
  let count = 0; const s = setup(async () => ++count === 1 ? 'retry' : 'accepted');
  s.stream.begin(1, [.1, .1], ...brush); s.stream.end(1, [.2, .2]); await s.advance();
  assert.equal(s.stream.clearDrawing(), true); assert.equal(s.stream.hidesServerInk, true);
  s.stream.begin(2, [.6, .6], ...brush); s.stream.end(2, [.7, .7]);
  await s.advance(); assert.deepEqual(s.calls[1], s.calls[0]);
  await s.advance(); assert.deepEqual(s.calls[2], { type: 'clear-drawing', drawingEpoch: 0 });
  s.stream.update('room:1', 1, true, [], s.sender); await s.advance();
  assert.equal(s.calls[3].drawingEpoch, 1); assert.equal(s.calls[3].type, 'drawing-batch'); assert.equal(s.stream.ink.length, 1); s.stream.dispose();
});
test('phase changes and disposal discard old geometry and ignore late saves', async () => {
  const pending = deferred<DrawingSendResult>(), s = setup(() => pending.promise);
  s.stream.begin(1, [.1, .1], ...brush); s.stream.move(1, [.2, .2]); await s.advance();
  s.stream.update('room:2', 0, false, [], s.sender); assert.equal(s.stream.ink.length, 0); assert.equal(s.stream.pointerId, undefined);
  pending.resolve('retry'); await s.advance(); assert.equal(s.calls.length, 1);
  s.stream.update('room:3', 0, true, [], s.sender); s.stream.begin(2, [.2, .2], ...brush); s.stream.dispose();
  const changes = s.changes(); await s.advance(); assert.equal(s.changes(), changes); assert.equal(s.timers.size, 0);
});
test('definitive validation failures stop automatic requests while allowing local ink and explicit recovery', async () => {
  const s = setup(async () => 'rejected'); s.stream.begin(1, [.1, .1], ...brush); s.stream.end(1, [.2, .2]); await s.advance();
  await s.advance(10000); assert.equal(s.calls.length, 1); assert.match(s.stream.status, /Try again/);
  assert.equal(s.stream.begin(2, [.3, .3], ...brush), true); s.stream.end(2, [.4, .4]); assert.equal(s.stream.ink.length, 2);
  s.stream.retry(); await s.advance(); assert.equal(s.calls.length, 2); s.stream.dispose();
});
test('a long offline gesture compacts unsent detail without changing the immutable batch or stopping input', async () => {
  const pending = deferred<DrawingSendResult>(), s = setup(() => pending.promise);
  s.stream.begin(1, [.1, .1], ...brush); s.stream.move(1, [.2, .2]); await s.advance(); const first = JSON.stringify(s.calls[0]);
  for (let i = 0; i < 100000; i++) s.stream.move(1, [(i % 1000) / 1000, .5 + .2 * Math.sin(i)]);
  assert.equal(s.stream.pointerId, 1); assert.ok(s.stream.ink.length <= 256); assert.ok(s.stream.ink.reduce((n, stroke) => n + stroke.points.length, 0) <= 12120);
  assert.equal(JSON.stringify(s.calls[0]), first); assert.match(s.stream.status, /simplified/); pending.resolve('accepted'); s.stream.dispose();
});

test('six full chunks quantize coordinates and fit inside the API request budget', async () => {
  const s = setup(); s.stream.begin(1, [1 / 7, 1 / 11], ...brush);
  for (let i = 1; i < 720; i++) s.stream.move(1, [(i % 83) / 83, (i % 71) / 71]);
  await s.advance(); const action = s.calls[0]; assert.equal(action.type, 'drawing-batch');
  if (action.type === 'drawing-batch') { assert.equal(action.segments.length, 6); assert.ok(action.segments.every(segment => segment.points.length <= 120)); assert.ok(action.segments.every(segment => segment.points.every(point => point.every(value => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-8)))); }
  assert.ok(JSON.stringify({ ...action, requestId: '11111111-1111-4111-8111-111111111111', phaseId: 1, sequence: 1 }).length < 16000); s.stream.dispose();
});
