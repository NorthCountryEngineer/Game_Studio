import { useEffect, useRef, useState } from 'react';
import type { ArcadeGameSpec, GameResult } from '../lib/game-types';
import { validateGameSpec } from '../lib/game-design';
import { aggregateFlowResults, type FlowProgress, type MaterialObservation, type MaterialRequest } from '../lib/game-flow-session';
import { GameFrame, type GamePlayerProps } from './GamePlayer';

export function LevelFlowPlayer(props: GamePlayerProps & { spec: ArcadeGameSpec }) {
  const [run, setRun] = useState(0);
  try { validateGameSpec(props.spec); } catch { return <p role="alert">This game flow could not be loaded safely.</p>; }
  return <FlowRun key={run} {...props} restart={() => setRun(value => value + 1)} />;
}

function FlowRun({ spec, onComplete, onFlowProgress, onMaterialRequest, playtest, restart }: GamePlayerProps & { spec: ArcadeGameSpec; restart: () => void }) {
  const nodes = spec.flow!.nodes;
  const [index, setIndex] = useState(nodes[0]?.type === 'menu' ? 1 : 0), [homeOpen, setHomeOpen] = useState(nodes[0]?.type === 'menu'), [levelFinished, setLevelFinished] = useState(false);
  const [results, setResults] = useState<GameResult[]>([]), [materials, setMaterials] = useState<MaterialObservation[]>([]);
  const [terminal, setTerminal] = useState<GameResult>(), [character, setCharacter] = useState<string>(), [materialError, setMaterialError] = useState(''), [retry, setRetry] = useState(0), [practiceId, setPracticeId] = useState(''), [practiceResult, setPracticeResult] = useState<GameResult>();
  const runId = useRef(crypto.randomUUID()).current, started = useRef(performance.now()).current;
  const completed = useRef(onComplete), observed = useRef(onFlowProgress), handler = useRef(onMaterialRequest);
  completed.current = onComplete; observed.current = onFlowProgress; handler.current = onMaterialRequest;
  const node = index >= 0 ? nodes[index] : undefined;
  const materialStart = useRef(performance.now());
  const request = useRef<MaterialRequest>();
  const accepted = useRef(new Set<string>()), acceptedLevels = useRef(new Set<string>()), ended = useRef(false);
  const resultRef = useRef(results); resultRef.current = results;
  const materialRef = useRef(materials); materialRef.current = materials;

  function progress(status: FlowProgress['status'], nextResults = resultRef.current, nextMaterials = materialRef.current, result?: GameResult) {
    const gameplayElapsed = nextResults.reduce((sum, value) => sum + value.elapsed, 0);
    observed.current?.({ runId, status, ...(node ? { activeNodeId: node.id } : {}),
      completedLevelIds: nextResults.filter(value => value.outcome !== 'lost').flatMap(value => value.reviewedLevelIds), materials: nextMaterials,
      gameplayElapsed, wallElapsed: Math.max(gameplayElapsed, Math.min(86400, (performance.now() - started) / 1000)),
      score: nextResults.reduce((sum, value) => sum + value.score, 0),
      ...(spec.version === 7 || spec.arcade?.scoring ? { points: nextResults.reduce((sum, value) => sum + (value.points || 0), 0) } : {}),
    }, result);
  }
  function finish(nextResults = resultRef.current, nextMaterials = materialRef.current) {
    if (ended.current) return;
    const total = aggregateFlowResults(spec, nextResults, 'won');
    if (!total) return;
    ended.current = true;
    setTerminal(total); completed.current?.(total); progress('won', nextResults, nextMaterials, total);
  }
  function advance(nextResults = resultRef.current, nextMaterials = materialRef.current) {
    setMaterialError(''); setLevelFinished(false);
    if (index + 1 >= nodes.length) finish(nextResults, nextMaterials);
    else setIndex(index + 1);
  }
  function finishMaterial(status: MaterialObservation['status'], requestId?: string) {
    if (node?.type !== 'material' || accepted.current.has(node.id) || requestId && request.current?.requestId !== requestId || status === 'skipped' && node.required) return;
    accepted.current.add(node.id);
    const next = [...materialRef.current, { nodeId: node.id, status, elapsed: Math.min(86400, (performance.now() - materialStart.current) / 1000) }];
    materialRef.current = next; setMaterials(next); advance(resultRef.current, next);
  }
  useEffect(() => {
    if (terminal) return;
    progress(node?.type === 'material' ? 'material' : 'playing');
    if (node?.type !== 'material' || homeOpen || practiceId) return;
    materialStart.current = performance.now(); setMaterialError('');
    const controller = new AbortController();
    const current: MaterialRequest = { runId, requestId: crypto.randomUUID(), node };
    request.current = current;
    if (handler.current && !playtest) void Promise.resolve().then(() => { if (controller.signal.aborted) return; return handler.current!(current, controller.signal); }).then(() => {
      if (!controller.signal.aborted) finishMaterial('completed', current.requestId);
    }).catch(error => { if (!controller.signal.aborted) setMaterialError(error instanceof Error ? error.message : 'The connected application could not open this material.'); });
    return () => { controller.abort(); request.current = undefined; };
  }, [index, retry, homeOpen, practiceId, terminal]);

  function record(value: GameResult) {
    if (node?.type !== 'level' || ended.current || acceptedLevels.current.has(node.id) || levelFinished || value.reviewedLevelIds.length !== 1 || value.reviewedLevelIds[0] !== node.levelId) return;
    acceptedLevels.current.add(node.id);
    const next = [...resultRef.current, value]; resultRef.current = next; setResults(next);
    if (value.outcome === 'lost') {
      const total = aggregateFlowResults(spec, next, 'lost');
      if (total) { ended.current = true; setTerminal(total); completed.current?.(total); progress('lost', next, materials, total); }
    } else {
      setLevelFinished(true); completed.current?.({ ...value, outcome: 'level-complete' }); progress('playing', next);
    }
  }
  const nextNode = nodes[index + 1];
  const nextTitle = nextNode?.type === 'level' ? 'the next level' : nextNode?.title || 'the end of the adventure';
  const totalPoints = results.reduce((sum, value) => sum + (value.points || 0), 0), playSeconds = results.reduce((sum, value) => sum + value.elapsed, 0);
  const hud = <p className="flow-run-totals" aria-live="polite">{results.filter(value => value.outcome !== 'lost').length} / {spec.levels!.length} levels completed · {totalPoints} points · {Math.round(playSeconds)} seconds of active play</p>;
  if (terminal) return <section className="flow-player-panel"><h2>{terminal.outcome === 'won' ? 'Adventure complete!' : 'Try another adventure run'}</h2>{hud}<p>{materials.filter(value => value.status === 'completed').length} material steps completed. Material time is tracked separately from active gameplay.</p><button className="button primary" onClick={restart}>Play again</button></section>;
  if (practiceId) return <section className="flow-player-panel"><h2>Level practice</h2><p>Practice results stay separate from the full adventure and client assignment completion.</p>{practiceResult ? <><p>{practiceResult.outcome === 'lost' ? 'Practice round finished' : 'Practice level complete'} · {practiceResult.points ?? 0} points · {Math.round(practiceResult.elapsed)} seconds</p><button className="button primary" onClick={() => { setPracticeId(''); setPracticeResult(undefined); }}>Return to level home</button></> : <><GameFrame spec={spec} levelId={practiceId} playtest={playtest} characterId={character} onCharacter={setCharacter} onComplete={setPracticeResult}/><button className="text-button" onClick={() => setPracticeId('')}>Return to level home</button></>}</section>;
  if (homeOpen) return <section className="flow-player-panel"><h2>{nodes[0].type === 'menu' ? nodes[0].title : 'Choose a level'}</h2>{hud}<p>Play the full adventure for combined points and completion. You can also choose an unlocked level for practice. Required activities unlock later practice levels.</p><button className="button primary" onClick={() => setHomeOpen(false)}>{results.length ? 'Continue full adventure' : 'Start full adventure'}</button><ol className="flow-home-levels">{nodes.filter(value => value.type === 'level').map(value => {
    const position = nodes.findIndex(item => item.id === value.id);
    const locked = nodes.slice(0, position).some(item => item.type === 'material' && item.required && !materials.some(material => material.nodeId === item.id && material.status === 'completed'));
    return <li key={value.id}><button className="button secondary" disabled={locked} onClick={() => { if (value.type === 'level') { setPracticeResult(undefined); setPracticeId(value.levelId); } }}>{spec.levels!.find(level => level.id === (value.type === 'level' ? value.levelId : ''))?.title}{locked ? ' · Locked' : ' · Practice'}</button></li>;
  })}</ol></section>;
  if (node?.type === 'material') return <section className="flow-player-panel" aria-labelledby="flow-material-title"><span className="eyebrow">{node.kind} · {node.required ? 'Required' : 'Optional'}</span><h2 id="flow-material-title">{node.title}</h2>{hud}<p>{playtest ? 'Playtest preview: review this step and its client reference. Continue previews the route; it does not complete an exercise in the client application.' : onMaterialRequest ? 'Complete this material in the connected application. Your game resumes when that application confirms completion.' : node.required ? 'This step needs its connected application. Open this game from the client’s lesson or activity to continue.' : 'This optional material is available from its connected application. You can continue this standalone game.'}</p>{playtest && <p>Client reference: <code>{node.reference}</code></p>}{materialError && <p role="alert">{materialError}</p>}<div className="game-button-row">{playtest && <button className="button primary" onClick={() => finishMaterial('completed')}>Continue playtest preview</button>}{!playtest && !node.required && <button className="button secondary" onClick={() => finishMaterial('skipped')}>Skip optional material</button>}{!playtest && onMaterialRequest && materialError && <button className="button secondary" onClick={() => setRetry(value => value + 1)}>Try material again</button>}<button className="text-button" onClick={restart}>Restart adventure</button></div></section>;
  if (levelFinished) return <section className="flow-player-panel"><h2>Level complete</h2>{hud}<p>{index + 1 < nodes.length ? `Next: ${nextTitle}` : 'You reached the end of this adventure.'}</p><button className="button primary" onClick={() => advance()}>{index + 1 < nodes.length ? 'Continue adventure' : 'Finish adventure'}</button>{nodes[0].type === 'menu' && index + 1 < nodes.length && <button className="button secondary" onClick={() => { advance(); setHomeOpen(true); }}>Level selection</button>}</section>;
  if (node?.type !== 'level') return <p role="alert">This flow step is unavailable.</p>;
  return <section className="flow-active-level">{hud}<GameFrame key={node.id} spec={spec} levelId={node.levelId} playtest={playtest} onComplete={record} characterId={character} onCharacter={setCharacter} /></section>;
}
