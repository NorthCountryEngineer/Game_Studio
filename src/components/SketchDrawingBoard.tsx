import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { PartyRoom } from '../lib/party';
import { DrawingStream, type DrawingPoint, type DrawingSegment, type DrawingSender } from '../lib/drawing-stream';

function renderSegment(stroke: DrawingSegment) {
  return stroke.points.length === 1 || stroke.points.every(p => p[0] === stroke.points[0][0] && p[1] === stroke.points[0][1]) ? <circle key={stroke.id} cx={stroke.points[0][0] * 800} cy={stroke.points[0][1] * 500} r={stroke.width / 2} fill={stroke.color}/> : <polyline key={stroke.id} points={stroke.points.map(([x, y]) => `${x * 800},${y * 500}`).join(' ')} stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" fill="none"/>;
}

export function SketchDrawingBoard({ room, enabled, send }: { room: PartyRoom; enabled: boolean; send: DrawingSender }) {
  const [color, setColor] = useState('#244b50'), [width, setWidth] = useState(5), [, redraw] = useState(0);
  const canvas = useRef<SVGSVGElement>(null), stream = useRef<DrawingStream>();
  const sender = useRef(send); sender.current = send;
  const stableSender = useRef<DrawingSender>(action => sender.current(action));
  if (!stream.current) stream.current = new DrawingStream(() => redraw(n => n + 1));
  const drawing = stream.current, strokes = (room.game.strokes ?? []) as DrawingSegment[];
  const serverInk = useMemo(() => strokes.map(renderSegment), [room.game.strokes]);
  const epoch = room.game.drawingEpoch ?? 0, context = `${room.roomId}:${room.phaseId}`;
  useEffect(() => {
    drawing.update(context, epoch, enabled, [...(room.game.drawingAckIds ?? []), ...strokes.map(s => s.id)], stableSender.current);
    if (drawing.pointerId === undefined) releaseCapture();
  }, [context, epoch, enabled, room.game.strokes, room.game.drawingAckIds]);
  useEffect(() => () => { releaseCapture(); drawing.dispose(); }, []);
  const captured = useRef<number>();
  function releaseCapture() {
    const id = captured.current; captured.current = undefined;
    if (id !== undefined && canvas.current?.hasPointerCapture(id)) canvas.current.releasePointerCapture(id);
  }
  function point(event: { clientX: number; clientY: number }): DrawingPoint {
    const box = canvas.current?.getBoundingClientRect();
    return box?.width && box.height ? [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))] : [0, 0];
  }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (!enabled || event.isPrimary === false || event.button !== 0 || !drawing.begin(event.pointerId, point(event), color, width)) return;
    event.preventDefault(); captured.current = event.pointerId;
    try { canvas.current?.setPointerCapture(event.pointerId); } catch { /* Pointer may already have ended. */ }
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (drawing.pointerId !== event.pointerId) return;
    event.preventDefault();
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of samples) drawing.move(event.pointerId, point(sample));
    drawing.move(event.pointerId, point(event));
  }
  function finish(event: PointerEvent<SVGSVGElement>) {
    if (drawing.pointerId !== event.pointerId) return;
    event.preventDefault(); drawing.end(event.pointerId, point(event)); releaseCapture();
  }
  function cancel(event: PointerEvent<SVGSVGElement>) {
    if (drawing.pointerId !== event.pointerId) return;
    drawing.end(event.pointerId); releaseCapture();
  }
  const acknowledged = new Set([...strokes.map(s => s.id), ...(room.game.drawingAckIds ?? [])]);
  const ink = [...(drawing.hidesServerInk ? [] : strokes), ...drawing.ink.filter(s => !acknowledged.has(s.id))];
  return <div className="party-drawing">
    <svg ref={canvas} viewBox="0 0 800 500" role="img" aria-label="Shared drawing canvas" className={enabled ? 'can-draw' : ''} style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }} onContextMenu={event => { if (enabled) event.preventDefault(); }} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      {!drawing.hidesServerInk && serverInk}
      {drawing.ink.filter(s => !acknowledged.has(s.id)).map(renderSegment)}
    </svg>
    {enabled && <div className="party-drawing-tools"><div aria-label="Brush colors">{['#244b50', '#f07662', '#4f8f73', '#6b5a9d', '#e4b347', '#ffffff'].map(value => <button key={value} style={{ background: value }} aria-label={`Brush ${value}`} aria-pressed={color === value} className={color === value ? 'selected' : ''} onClick={() => setColor(value)}/>)}</div><label>Brush<select aria-label="Brush width" value={width} onChange={event => setWidth(Number(event.target.value))}><option value={3}>Fine</option><option value={5}>Medium</option><option value={10}>Bold</option></select></label><button className="text-button" disabled={drawing.clearing || !ink.length} onClick={() => { if (drawing.clearDrawing()) releaseCapture(); }}>Clear drawing</button>{drawing.status && <small role="status">{drawing.status} <button className="text-button" onClick={() => drawing.retry()}>Try sharing again</button></small>}</div>}
  </div>;
}
