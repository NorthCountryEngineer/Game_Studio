/** Local ink and its bounded, idempotent transport are independent of room latency. */
export type DrawingPoint = [number, number];
export type DrawingSegment = { id: string; color: string; width: number; points: DrawingPoint[] };
export type DrawingAction = { type: 'drawing-batch'; drawingEpoch: number; segments: DrawingSegment[] } | { type: 'clear-drawing'; drawingEpoch: number };
export type DrawingSendResult = 'accepted' | 'retry' | 'discarded' | 'rejected';
export type DrawingSender = (action: DrawingAction) => Promise<DrawingSendResult>;
type Pending = DrawingSegment & { accepted?: boolean };
type Flight = { action: DrawingAction; generation: number };
type Environment = { now: () => number; later: (fn: () => void, delay: number) => unknown; cancel: (timer: unknown) => void; id: () => string };
const browserEnvironment = (): Environment => ({ now: Date.now, later: (fn, delay) => window.setTimeout(fn, delay), cancel: timer => window.clearTimeout(timer as number), id: () => crypto.randomUUID() });
const samePoint = (a: DrawingPoint, b: DrawingPoint) => a[0] === b[0] && a[1] === b[1];
const normalized = (point: DrawingPoint): DrawingPoint => point.map(coordinate => Math.round(Math.max(0, Math.min(1, coordinate)) * 10000) / 10000) as DrawingPoint;
const sample = (points: DrawingPoint[], limit: number) => points.length <= limit ? points : Array.from({ length: limit }, (_, i) => points[Math.round(i * (points.length - 1) / (limit - 1))]);

export class DrawingStream {
  private env: Environment;
  private key = '';
  private epoch = 0;
  private serverEpoch = 0;
  private enabled = false;
  private stopped = false;
  private generation = 0;
  private timer?: unknown;
  private lastAttempt = -Infinity;
  private flight?: Flight;
  private retryAction?: DrawingAction;
  private clear?: { from: number; to: number; accepted?: boolean };
  private pending: Pending[] = [];
  private current?: DrawingSegment;
  private pointer?: number;
  private send?: DrawingSender;
  private changed: () => void;
  private blocked = false;
  private simplified = false;
  private acknowledgments = new Set<string>();

  constructor(changed: () => void, env?: Environment) { this.changed = changed; this.env = env ?? browserEnvironment(); }

  update(key: string, epoch: number, enabled: boolean, acknowledgments: readonly string[], send: DrawingSender) {
    this.stopped = false;
    this.send = send;
    if (key !== this.key || epoch !== this.serverEpoch && epoch !== this.clear?.to) {
      this.reset(); this.key = key; this.epoch = epoch;
    }
    this.serverEpoch = epoch;
    if (this.clear && epoch === this.clear.to) { this.clear = undefined; this.epoch = epoch; }
    this.enabled = enabled;
    if (!enabled) { this.current = undefined; this.pointer = undefined; this.pending = []; this.clear = undefined; }
    const ack = new Set(acknowledgments);
    this.acknowledgments = ack;
    this.pending = this.pending.filter(segment => !ack.has(segment.id));
    if (this.retryAction?.type === 'drawing-batch' && this.retryAction.segments.every(segment => ack.has(segment.id))) this.retryAction = undefined;
    if (this.retryAction?.type === 'clear-drawing' && epoch > this.retryAction.drawingEpoch) this.retryAction = undefined;
    this.changed(); this.schedule();
  }

  private reset() {
    this.generation++; this.flight = undefined; this.retryAction = undefined; this.clear = undefined; this.pending = []; this.current = undefined; this.pointer = undefined;
    this.blocked = false; this.simplified = false; this.lastAttempt = -Infinity;
    if (this.timer !== undefined) this.env.cancel(this.timer);
    this.timer = undefined;
  }

  begin(pointer: number, point: DrawingPoint, color: string, width: number) {
    if (!this.enabled || this.stopped || this.pointer !== undefined) return false;
    this.pointer = pointer; this.current = { id: this.env.id(), color, width, points: [normalized(point)] };
    this.changed(); this.schedule(500); return true;
  }

  move(pointer: number, point: DrawingPoint) {
    if (pointer !== this.pointer || !this.current || !this.enabled) return;
    point = normalized(point);
    const last = this.current.points.at(-1)!;
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < .001) return;
    this.current.points.push(point);
    if (this.current.points.length >= 120) this.seal(true);
    this.changed(); this.schedule();
  }

  end(pointer: number, point?: DrawingPoint) {
    if (pointer !== this.pointer) return;
    if (point) this.move(pointer, point);
    this.seal(false); this.current = undefined; this.pointer = undefined;
    this.changed(); this.schedule();
  }

  clearDrawing() {
    if (!this.enabled || this.stopped || this.clear) return false;
    this.current = undefined; this.pointer = undefined; this.pending = [];
    this.clear = { from: this.epoch, to: this.epoch + 1 }; this.epoch++;
    this.blocked = false; this.changed(); this.schedule(); return true;
  }

  private seal(continuing: boolean) {
    const stroke = this.current;
    if (!stroke || continuing && stroke.points.length < 2) return;
    if (stroke.points.length === 1) stroke.points.push([...stroke.points[0]]);
    this.pending.push(stroke);
    this.current = continuing ? { id: this.env.id(), color: stroke.color, width: stroke.width, points: [[...stroke.points.at(-1)!]] } : undefined;
    this.compact();
  }

  private compact() {
    // Never alter a batch whose commit is unknown. Only unsent detail is simplified.
    const immutable = this.flight?.action ?? this.retryAction;
    const protectedIds = new Set(immutable?.type === 'drawing-batch' ? immutable.segments.map(s => s.id) : []);
    const mutable = (segment: Pending) => !segment.accepted && !protectedIds.has(segment.id);
    if (this.pending.reduce((sum, s) => sum + s.points.length, 0) > 12000) {
      for (const segment of this.pending) if (mutable(segment)) segment.points = sample(segment.points, Math.max(2, Math.ceil(segment.points.length / 2)));
      this.simplified = true;
    }
    // Adjacent chunks from one gesture can be joined under backpressure, preserving endpoints.
    if (this.pending.length > 256) {
      const compacted: Pending[] = [];
      for (const segment of this.pending) {
        const prior = compacted.at(-1);
        if (prior && mutable(prior) && mutable(segment) && prior.color === segment.color && prior.width === segment.width && samePoint(prior.points.at(-1)!, segment.points[0])) {
          prior.points = sample([...prior.points, ...segment.points.slice(1)], 120); this.simplified = true;
        } else compacted.push(segment);
      }
      this.pending = compacted;
    }
    // Retain a hard memory bound even for synthetic pointer spam over a whole round.
    if (this.pending.length > 4096) {
      let excess = this.pending.length - 4096;
      this.pending = this.pending.filter(segment => !mutable(segment) || excess-- <= 0);
      this.simplified = true;
    }
  }

  private hasWork() { return Boolean(this.current || this.retryAction || this.clear && !this.clear.accepted || this.pending.some(s => !s.accepted)); }
  private schedule(delay = 0) {
    if (this.stopped || !this.enabled || this.blocked || this.timer !== undefined || !this.hasWork()) return;
    this.timer = this.env.later(() => { this.timer = undefined; void this.tick(); }, Math.max(delay, this.lastAttempt + 500 - this.env.now(), 0));
  }

  private async tick() {
    if (this.stopped || !this.enabled) return;
    this.seal(true); this.changed();
    if (this.flight) { this.schedule(500); return; }
    const segments = this.pending.filter(segment => !segment.accepted).slice(0, 6);
    const action: DrawingAction | undefined = this.retryAction ?? (this.clear && !this.clear.accepted ? { type: 'clear-drawing', drawingEpoch: this.clear.from } : segments.length ? { type: 'drawing-batch', drawingEpoch: this.epoch, segments: segments.map(({ id, color, width, points }) => ({ id, color, width, points: points.map(point => [...point]) })) } : undefined);
    if (!action || !this.send) { this.schedule(500); return; }
    const flight: Flight = { action, generation: this.generation }; this.flight = flight; this.lastAttempt = this.env.now();
    let result: DrawingSendResult;
    try { result = await this.send(action); } catch { result = 'retry'; }
    if (this.stopped || flight.generation !== this.generation || this.flight !== flight) return;
    this.flight = undefined;
    if (action.type === 'drawing-batch' && action.segments.every(segment => this.acknowledgments.has(segment.id)) || action.type === 'clear-drawing' && this.serverEpoch > action.drawingEpoch) result = 'accepted';
    if (result === 'accepted') {
      this.retryAction = undefined;
      if (action.type === 'clear-drawing') { if (this.clear?.from === action.drawingEpoch) this.clear.accepted = true; }
      else { const ids = new Set(action.segments.map(s => s.id)); for (const segment of this.pending) if (ids.has(segment.id)) segment.accepted = true; }
    } else if (result === 'discarded') { this.reset(); }
    else { this.retryAction = action; if (result === 'rejected') this.blocked = true; }
    this.changed(); this.schedule(500);
  }

  retry() { this.blocked = false; this.schedule(); this.changed(); }
  get pointerId() { return this.pointer; }
  get clearing() { return Boolean(this.clear); }
  get hidesServerInk() { return Boolean(this.clear && this.serverEpoch !== this.clear.to); }
  get status() { return this.blocked ? 'Some ink could not be shared. Try again.' : this.simplified ? 'Connection slow. Drawing detail is being simplified while it catches up.' : ''; }
  get ink(): DrawingSegment[] { return [...this.pending, ...(this.current ? [this.current] : [])]; }
  dispose() { this.stopped = true; this.reset(); }
}
