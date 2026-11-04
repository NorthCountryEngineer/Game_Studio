import type { PartyRecognitionAck, PartyRoom, PartySession } from './party';

export type SketchRecognitionTarget = { roomId: string; phaseId: number; drawingEpoch: number; inkSha256: string; token: string };
type Timer = number;
export type SketchRecognitionScheduler = { update: (room?: PartyRoom, session?: PartySession) => void; close: () => void };
type RecognitionPorts = {
  request: (target: SketchRecognitionTarget, signal: AbortSignal) => Promise<PartyRecognitionAck>;
  setTimeout: (callback: () => void, milliseconds: number) => Timer;
  clearTimeout: (timer: Timer) => void;
  now?: () => number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SPACING_MS = 3000;

/** Only public ink identity and this human's capability enter the background lane. */
function recognitionTarget(room?: PartyRoom, session?: PartySession): SketchRecognitionTarget | undefined {
  if (!room || !session || room.kind !== 'sketch-guess' || room.status !== 'playing' || room.phase !== 'draw' || room.self.left || session.roomId !== room.roomId || session.playerId !== room.self.id || !UUID.test(room.roomId)) return;
  const artist = room.game.artistId, hash = room.game.inkSha256, epoch = room.game.drawingEpoch;
  if (typeof artist !== 'string' || !UUID.test(artist) || typeof hash !== 'string' || !HASH.test(hash) || !Number.isSafeInteger(room.phaseId) || room.phaseId < 0 || !Number.isSafeInteger(epoch) || epoch < 0 || !Array.isArray(room.game.strokes) || !room.game.strokes.length) return;
  if (!room.players.some(player => player.id === session.playerId && !player.left && !player.isAI) || !room.players.some(player => player.isAI && !player.left && player.id !== artist)) return;
  return { roomId: room.roomId, phaseId: room.phaseId, drawingEpoch: epoch, inkSha256: hash, token: session.token };
}

/** Independent, bounded work: never joins the room poll/action/drawing queue. */
export function createSketchRecognitionScheduler(ports: RecognitionPorts): SketchRecognitionScheduler {
  const now = ports.now ?? Date.now;
  let closed = false, scope = '', target: SketchRecognitionTarget | undefined, timer: Timer | undefined, lastStartedAt = -Infinity;
  let flight: { controller: AbortController; scope: string; hash: string } | undefined;
  const handled = new Set<string>(), attempts = new Map<string, number>();
  function cancelTimer() { if (timer !== undefined) ports.clearTimeout(timer); timer = undefined; }
  function schedule() {
    if (closed || !target || flight || handled.has(target.inkSha256) || timer !== undefined) return;
    timer = ports.setTimeout(() => { timer = undefined; start(); }, Math.max(0, lastStartedAt + SPACING_MS - now()));
  }
  function start() {
    if (closed || !target || flight || handled.has(target.inkSha256)) return;
    const snapshot = target, work = { controller: new AbortController(), scope, hash: snapshot.inkSha256 };
    flight = work; lastStartedAt = now(); attempts.set(work.hash, (attempts.get(work.hash) ?? 0) + 1);
    void ports.request(snapshot, work.controller.signal).then(ack => {
      if (closed || flight !== work || scope !== work.scope) return;
      if (ack.status !== 'busy') handled.add(work.hash);
    }).catch(() => { /* Transient recognition errors never block or replace gameplay. */ }).finally(() => {
      if (closed || flight !== work || scope !== work.scope) return;
      flight = undefined;
      // One initial attempt plus three bounded retries reaches the longest
      // server cadence (nine seconds in a three-minute drawing round).
      if ((attempts.get(work.hash) ?? 0) >= 4) handled.add(work.hash);
      // Bound retained work identities in a long drawing round.
      while (handled.size > 64) handled.delete(handled.values().next().value!);
      while (attempts.size > 64) attempts.delete(attempts.keys().next().value!);
      schedule();
    });
  }
  return {
    update(room, session) {
      if (closed) return;
      const next = recognitionTarget(room, session);
      const nextScope = next ? `${next.roomId}:${next.phaseId}:${next.drawingEpoch}:${session!.playerId}:${next.token}:${room!.game.artistId}` : '';
      if (nextScope !== scope) {
        cancelTimer(); flight?.controller.abort(); flight = undefined; handled.clear(); attempts.clear(); scope = nextScope;
      }
      target = next;
      if (!target) cancelTimer(); else schedule();
    },
    close() { closed = true; cancelTimer(); flight?.controller.abort(); flight = undefined; target = undefined; handled.clear(); attempts.clear(); },
  };
}
