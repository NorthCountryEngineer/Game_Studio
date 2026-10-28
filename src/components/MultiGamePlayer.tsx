import { useEffect, useRef, useState } from 'react';
import { GamePlayer, type GamePlayerProps } from './GamePlayer';
import { gameReviewLevelIds, type GameResult, type MultiGameSpec, type SingleGameSpec } from '../lib/game-types';
import { getGameLevels, validateGameSpec } from '../lib/game-design';
import { aggregateMultiGameResults, multiGamePoints, type MultiGameProgress, type MultiGameResult, type MultiMaterialRequest } from '../lib/multi-game-session';
import type { FlowProgress } from '../lib/game-flow-session';

type Props = GamePlayerProps & { spec: MultiGameSpec };
const stepName = (step: MultiGameSpec['steps'][number]) => step.type === 'material' ? step.title : step.spec.title;

export function MultiGamePlayer(props: Props) {
  const [run, setRun] = useState(0);
  try { validateGameSpec(props.spec); } catch (error) { return <p role="alert">{error instanceof Error ? error.message : 'This journey could not be loaded safely.'}</p>; }
  if (props.playtest && props.stepId) return <MultiStepPreview key={props.stepId} {...props} />;
  return <MultiGameRun key={run} {...props} restart={() => setRun(value => value + 1)} />;
}

/** Step review is private and cannot manufacture public sequence completion. */
function MultiStepPreview({ spec, stepId, onMultiProgress }: Props) {
  const step = spec.steps.find(value => value.id === stepId);
  const runId = useRef(crypto.randomUUID()).current;
  const levels = useRef(new Set<string>()), materialReviewed = useRef(false);
  const [levelId, setLevelId] = useState(''), [round, setRound] = useState(0), [reviewed, setReviewed] = useState(false), [objectsChecked, setObjectsChecked] = useState(false);
  if (!step) return <p role="alert">Choose a step in this journey.</p>;
  const child = step.type === 'material' ? undefined : step.spec;
  const objects = child && child.version !== 3 ? child.flow?.nodes.filter(node => node.type === 'material') || [] : [];
  function mark(ids: string[] = [], checked = materialReviewed.current) {
    ids.forEach(id => levels.current.add(id));
    const done = step!.type === 'material' || gameReviewLevelIds((step as { spec: SingleGameSpec }).spec).every(id => levels.current.has(id)) && (!objects.length || checked);
    if (!done) return;
    setReviewed(true); onMultiProgress?.({ runId, status: 'playing', activeStepId: step!.id, reviewedStepIds: [step!.id] });
  }
  return <section className="multi-player-step-preview"><span className="eyebrow">PRIVATE STEP PREVIEW</span><h3>{stepName(step)}</h3>
    {step.type === 'material' ? <div className="flow-player-panel"><p>{step.kind} · {step.required ? 'Client completion required' : 'Optional'}</p><p>Client reference: <code>{step.reference}</code></p><p>Review the reference and its intended behavior in the connected client. This preview does not complete a client object.</p><button className="button secondary" onClick={() => mark()}>Review this client object</button></div> : <>
      {step.spec.version !== 3 && !step.spec.asteroids?.endless && getGameLevels(step.spec).length > 1 && <label className="multi-preview-level">Preview inside this game<select value={levelId} onChange={event => { setLevelId(event.target.value); setRound(value => value + 1); }}><option value="">Full game</option>{getGameLevels(step.spec).map(level => <option key={level.id} value={level.id}>{level.title}</option>)}</select></label>}
      <GamePlayer key={`${step.id}-${round}`} spec={step.spec} playtest levelId={levelId || undefined}
        onComplete={value => mark(value.reviewedLevelIds)} onReview={value => mark(value.reviewedLevelIds)}
        onFlowProgress={progress => { if (objects.length && objects.every(node => progress.materials.some(item => item.nodeId === node.id))) materialReviewed.current = true; mark(progress.completedLevelIds); }} />
      {objects.length > 0 && <label className="game-checkbox"><input type="checkbox" checked={objectsChecked} onChange={event => { setObjectsChecked(event.target.checked); materialReviewed.current = event.target.checked; mark([], event.target.checked); }}/>I reviewed this game’s client object references and requirements.</label>}
      <button className="text-button" onClick={() => setRound(value => value + 1)}>Restart step preview</button>
    </>}
    <p role="status">{reviewed ? 'This step has been reviewed for the saved journey.' : step.type === 'free-play' ? 'Play for five seconds and use Finish playtest, or finish a round, to review free play.' : child && child.version !== 3 ? 'Complete a round in every level and review any client objects in this game.' : 'Complete or explicitly reveal this game, then review the result.'}</p>
  </section>;
}

function MultiGameRun({ spec, onMultiProgress, onMultiComplete, onMultiMaterialRequest, playtest, restart }: Props & { restart: () => void }) {
  const [index, setIndex] = useState(0), [stepFinished, setStepFinished] = useState(false), [finished, setFinished] = useState<MultiGameResult>(), [freePlay, setFreePlay] = useState(false);
  const [games, setGames] = useState<MultiGameResult['games']>([]), [materials, setMaterials] = useState<MultiGameResult['materials']>([]), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const runId = useRef(crypto.randomUUID()).current, started = useRef(performance.now()).current;
  const frozen = useRef<MultiGameResult>(), accepted = useRef(new Set<string>()), reviewed = useRef(new Set<string>());
  const gameRef = useRef(games), materialRef = useRef(materials); gameRef.current = games; materialRef.current = materials;
  const callbacks = useRef({ onMultiProgress, onMultiComplete, onMultiMaterialRequest }); callbacks.current = { onMultiProgress, onMultiComplete, onMultiMaterialRequest };
  const materialStart = useRef(performance.now()), currentRequest = useRef<MultiMaterialRequest>();
  const step = spec.steps[index], bonus = spec.steps.find(value => value.type === 'free-play');

  function emit(status: MultiGameProgress['status'], result?: MultiGameResult, activeStepId = step?.id) {
    callbacks.current.onMultiProgress?.({ runId, status, ...(!['completed', 'lost'].includes(status) && activeStepId ? { activeStepId } : {}), reviewedStepIds: spec.steps.filter(value => reviewed.current.has(value.id)).map(value => value.id), ...(result ? { result: structuredClone(result) } : {}) });
  }
  function finish(outcome: 'won' | 'lost', nextGames = gameRef.current, nextMaterials = materialRef.current) {
    if (frozen.current) return;
    const observedWall = nextGames.reduce((sum, game) => sum + (game.flow?.wallElapsed ?? game.result.elapsed), 0) + nextMaterials.reduce((sum, item) => sum + item.elapsed, 0);
    const total = aggregateMultiGameResults(spec, nextGames, nextMaterials, outcome, Math.min(86400, Math.max(observedWall, (performance.now() - started) / 1000)));
    if (!total) { setError('The journey result could not be verified. Restart the journey to try again.'); return; }
    frozen.current = total; setFinished(total); callbacks.current.onMultiComplete?.(structuredClone(total)); emit(outcome === 'won' ? 'completed' : 'lost', total);
  }
  function advance(nextGames = gameRef.current, nextMaterials = materialRef.current) {
    if (frozen.current) return;
    setError(''); setStepFinished(false);
    if (index + 1 >= spec.steps.length || spec.steps[index + 1].type === 'free-play') finish('won', nextGames, nextMaterials);
    else setIndex(index + 1);
  }
  function completeObject(status: 'completed' | 'skipped', requestId?: string) {
    if (step.type !== 'material' || frozen.current || accepted.current.has(step.id) || requestId && currentRequest.current?.requestId !== requestId || step.required && status === 'skipped') return;
    accepted.current.add(step.id); reviewed.current.add(step.id);
    const next: MultiGameResult['materials'] = [...materialRef.current, { path: [step.id], status, elapsed: Math.min(86400, Math.max(0, (performance.now() - materialStart.current) / 1000)) }];
    materialRef.current = next; setMaterials(next); advance(gameRef.current, next);
  }
  function record(value: GameResult, flow?: FlowProgress) {
    if (step.type !== 'game' || frozen.current || accepted.current.has(step.id) || value.outcome === 'level-complete') return;
    accepted.current.add(step.id);
    if (gameReviewLevelIds(step.spec).every(id => value.reviewedLevelIds.includes(id))) reviewed.current.add(step.id);
    const next = [...gameRef.current, { stepId: step.id, result: value, ...(flow ? { flow } : {}) }]; gameRef.current = next; setGames(next);
    if (value.outcome === 'lost') finish('lost', next);
    else if (index + 1 >= spec.steps.length || spec.steps[index + 1].type === 'free-play') finish('won', next);
    else { setStepFinished(true); emit('playing'); }
  }
  useEffect(() => {
    if (frozen.current) return;
    emit(step.type === 'material' ? 'material' : 'playing');
    if (step.type !== 'material') return;
    const controller = new AbortController(); materialStart.current = performance.now(); setError('');
    const request: MultiMaterialRequest = { runId, requestId: crypto.randomUUID(), path: [step.id], node: step };
    currentRequest.current = request;
    if (!playtest && callbacks.current.onMultiMaterialRequest) void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return callbacks.current.onMultiMaterialRequest!(request, controller.signal);
    }).then(() => { if (!controller.signal.aborted) completeObject('completed', request.requestId); }).catch(value => {
      if (!controller.signal.aborted) setError(value instanceof Error ? value.message : 'This client object is unavailable.');
    });
    return () => { controller.abort(); currentRequest.current = undefined; };
  }, [index, retry, finished]);

  const points = games.reduce((sum, game) => sum + multiGamePoints(game.result), 0), elapsed = games.reduce((sum, game) => sum + game.result.elapsed, 0);
  const hud = <p className="flow-run-totals">{games.filter(game => game.result.outcome === 'won').length} / {spec.steps.filter(value => value.type === 'game').length} games completed · {points} points · {Math.round(elapsed)} seconds of active play</p>;
  if (freePlay && bonus?.type === 'free-play' && finished) return <section className="multi-free-play"><h2>Free play</h2><p>The journey is complete. Its result is saved separately; free-play points and time do not change it.</p>{hud}<GamePlayer spec={bonus.spec} playtest={playtest}
    onComplete={() => { if (playtest) reviewed.current.add(bonus.id); emit('free-play', frozen.current, bonus.id); }}
    onReview={() => { reviewed.current.add(bonus.id); emit('free-play', frozen.current, bonus.id); }} />
    <button className="button secondary" onClick={() => setFreePlay(false)}>Return to journey summary</button>
  </section>;
  if (finished) return <section className="flow-player-panel"><h2>{finished.outcome === 'won' ? 'Journey complete' : 'Journey round finished'}</h2>{hud}<p>{finished.outcome === 'won' ? 'All main games and required client objects are complete.' : 'Restart the journey to try again.'}</p>{bonus && finished.outcome === 'won' && <button className="button primary" onClick={() => { setFreePlay(true); emit('free-play', frozen.current, bonus.id); }}>Continue in free play</button>}<button className="button secondary" onClick={restart}>Restart journey</button></section>;
  if (error && step.type !== 'material') return <section className="flow-player-panel"><p role="alert">{error}</p><button className="button secondary" onClick={restart}>Restart journey</button></section>;
  if (stepFinished) return <section className="flow-player-panel"><h2>Game complete</h2>{hud}<p>Next: {stepName(spec.steps[index + 1])}</p><button className="button primary" onClick={() => advance()}>Continue journey</button></section>;
  if (step.type === 'material') return <section className="flow-player-panel"><span className="eyebrow">CLIENT OBJECT · {step.required ? 'REQUIRED' : 'OPTIONAL'}</span><h2>{step.title}</h2>{hud}<p>{playtest ? 'Private preview: review this reference and the behavior of its client adapter. Preview continuation does not complete the real client object.' : onMultiMaterialRequest ? 'Complete this object in the connected client. The journey continues when that client confirms.' : step.required ? 'Open this journey from its connected client to complete this required object.' : 'This optional object is available in its connected client. You can skip it in standalone play.'}</p>{playtest && <p>Client reference: <code>{step.reference}</code></p>}{error && <p role="alert">{error}</p>}{playtest ? <button className="button primary" onClick={() => completeObject('completed')}>Continue private preview</button> : !step.required && <button className="button secondary" onClick={() => completeObject('skipped')}>Skip optional object</button>}{onMultiMaterialRequest && error && <button className="button secondary" onClick={() => setRetry(value => value + 1)}>Try object again</button>}<button className="text-button" onClick={restart}>Restart journey</button></section>;
  if (step.type !== 'game') return <p role="alert">This journey step is unavailable.</p>;
  const hasFlow = step.spec.version !== 3 && Boolean(step.spec.flow);
  return <section className="multi-active-game"><span className="eyebrow">GAME {games.length + 1} · {step.spec.title}</span>{hud}<GamePlayer key={step.id} spec={step.spec} playtest={playtest}
    onComplete={value => { if (!hasFlow) record(value); }}
    onFlowProgress={(flow, result) => { if (result) record(result, flow); else if (!frozen.current) emit(flow.status === 'material' ? 'material' : 'playing'); }}
    onMaterialRequest={onMultiMaterialRequest ? (request, signal) => onMultiMaterialRequest({ runId, requestId: request.requestId, path: [step.id, request.node.id], node: request.node }, signal) : undefined}
  /></section>;
}
