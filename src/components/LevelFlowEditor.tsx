import { useRef, useState, type DragEvent } from 'react';
import { useConfirm } from './Confirm';
import { getGameLevels } from '../lib/game-design';
import { defaultGameFlow } from '../lib/game-flow';
import { isCooperativeGameSpec, type ArcadeGameSpec, type GameFlowNode, type GameLevel } from '../lib/game-types';

const worlds: { id: GameLevel['theme']; title: string }[] = [{ id: 'pond', title: 'Lakeside' }, { id: 'garden', title: 'Garden' }, { id: 'space', title: 'Space' }];
const difficultyNames = ['Very gentle', 'Gentle', 'A little challenge', 'Tricky', 'Very tricky'];
const dragType = 'application/x-game-studio-flow';
const nextSeed = (old = 0) => { const values = new Uint32Array(1); crypto.getRandomValues(values); const seed = values[0] % 2147483647 + 1; return seed === old ? seed % 2147483647 + 1 : seed; };
type Addition = 'level' | 'lesson' | 'video' | 'exercise' | 'menu';
const palette: { type: Addition; title: string; symbol: string }[] = [{ type: 'level', title: 'Game level', symbol: '▣' }, { type: 'lesson', title: 'Lesson', symbol: '▤' }, { type: 'video', title: 'Video', symbol: '▶' }, { type: 'exercise', title: 'Exercise', symbol: '✎' }, { type: 'menu', title: 'Level home', symbol: '⌂' }];

/** The home remains first, and all other steps retain stable identifiers on reorder. */
export function moveFlowStep(nodes: GameFlowNode[], id: string, index: number): GameFlowNode[] {
  const source = nodes.findIndex(node => node.id === id);
  if (source < 0 || nodes[source].type === 'menu') return nodes;
  const copy = [...nodes], [node] = copy.splice(source, 1);
  const first = copy[0]?.type === 'menu' ? 1 : 0;
  copy.splice(Math.max(first, Math.min(copy.length, index)), 0, node);
  return copy;
}

export function LevelSettings({ level, onChange, continuous = false, disabled = false }: { level: GameLevel; onChange: (next: GameLevel) => void; continuous?: boolean; disabled?: boolean }) {
  return <fieldset disabled={disabled} className="game-flow-settings">
    {!continuous && <><label>Level title<input value={level.title} maxLength={80} onChange={event => onChange({ ...level, title: event.target.value })}/></label><label>Level description<textarea value={level.brief} maxLength={300} rows={3} onChange={event => onChange({ ...level, brief: event.target.value.replace(/[\r\n]/g, ' ') })}/></label></>}
    <div className="game-field-pair"><label>{continuous ? 'Starting world' : 'Theme'}<select value={level.theme} onChange={event => onChange({ ...level, theme: event.target.value as GameLevel['theme'] })}>{worlds.map(world => <option value={world.id} key={world.id}>{world.title}</option>)}</select></label><label>{continuous ? 'Starting difficulty' : 'Difficulty'}<select value={level.rules.difficulty} onChange={event => onChange({ ...level, rules: { ...level.rules, difficulty: Number(event.target.value) } })}>{difficultyNames.map((name, index) => <option value={index + 1} key={name}>{name}</option>)}</select></label></div>
    {!continuous && <div className="game-field-pair"><label>Collectible goal<input type="number" min={3} max={40} value={level.rules.goal} onChange={event => onChange({ ...level, rules: { ...level.rules, goal: Number(event.target.value) } })}/></label><label>Time limit (seconds)<input type="number" min={30} max={180} value={level.rules.timeLimit} onChange={event => onChange({ ...level, rules: { ...level.rules, timeLimit: Number(event.target.value) } })}/></label></div>}
    <div className="game-field-pair"><label>{continuous ? 'Starting lives' : 'Lives'}<input type="number" min={1} max={5} value={level.rules.lives} onChange={event => onChange({ ...level, rules: { ...level.rules, lives: Number(event.target.value) } })}/></label><label>Layout seed<input type="number" min={1} max={2147483647} value={level.seed} onChange={event => onChange({ ...level, seed: Number(event.target.value) })}/></label></div><button type="button" className="button secondary" onClick={() => onChange({ ...level, seed: nextSeed(level.seed) })}>↻ Shuffle layout</button>
  </fieldset>;
}

export function LevelFlowEditor({ spec, disabled, onChange, neutralLabels = false }: { spec: ArcadeGameSpec; disabled: boolean; onChange: (next: ArcadeGameSpec) => void; neutralLabels?: boolean }) {
  const labels = neutralLabels ? palette.map(item => ({ ...item, title: item.type === 'lesson' ? 'Client object' : item.type === 'exercise' ? 'Interactive object' : item.title })) : palette;
  const confirm = useConfirm();
  const levels = getGameLevels(spec), cooperative = isCooperativeGameSpec(spec);
  const nodes: GameFlowNode[] = cooperative ? levels.map((level, index) => ({ id: `step-${index + 1}`, type: 'level', levelId: level.id })) : spec.flow?.nodes ?? defaultGameFlow(spec).nodes;
  const [selection, setSelection] = useState(nodes[0]?.id ?? ''), [announcement, setAnnouncement] = useState('');
  const activeDrag = useRef<{ payload: string; value: string }>();
  const selected = nodes.find(node => node.id === selection) ?? nodes[0];
  const selectedLevel = selected?.type === 'level' ? levels.find(level => level.id === selected.levelId) : undefined;
  function commit(nextNodes: GameFlowNode[], nextLevels = levels) {
    const levelOrder = nextNodes.filter(node => node.type === 'level').map(node => nextLevels.find(level => level.id === node.levelId)!);
    onChange({ ...spec, version: spec.version === 1 ? 2 : spec.version, levels: levelOrder, progression: spec.progression ?? 'Explore each world, collect rewards and finish the adventure.', ...(!cooperative ? { flow: { version: 1, nodes: nextNodes } } : {}) });
  }
  function move(id: string, target: number) {
    const next = moveFlowStep(nodes, id, target); commit(next); setSelection(id); setAnnouncement(`Step moved to position ${next.findIndex(node => node.id === id) + 1}.`);
  }
  function add(type: Addition, index = nodes.length) {
    if (disabled || nodes.length >= 24 || cooperative && type !== 'level') return;
    const id = Array.from({ length: 24 }, (_, position) => `step-${position + 1}`).find(candidate => !nodes.some(node => node.id === candidate))!;
    let node: GameFlowNode, nextLevels = levels;
    if (type === 'level') {
      if (levels.length >= 8) return;
      const levelId = Array.from({ length: 8 }, (_, position) => `level-${position + 1}`).find(candidate => !levels.some(level => level.id === candidate))!;
      const level = { id: levelId, title: `World ${levels.length + 1}`, brief: 'Explore, collect rewards and reach your goal.', theme: spec.theme, rules: { ...levels.at(-1)!.rules }, seed: nextSeed() };
      nextLevels = [...levels, level]; node = { id, type: 'level', levelId };
    } else if (type === 'menu') {
      if (nodes.some(node => node.type === 'menu')) return;
      node = { id, type: 'menu', title: 'Choose your level' }; index = 0;
    } else node = { id, type: 'material', title: type === 'lesson' ? neutralLabels ? 'Custom client object' : 'A lesson between worlds' : type === 'video' ? 'Watch a video' : neutralLabels ? 'Interactive client object' : 'Try an exercise', kind: type, reference: `client:${type}-${id.slice(5)}`, required: false };
    const copy = [...nodes]; copy.splice(Math.max(copy[0]?.type === 'menu' && type !== 'menu' ? 1 : 0, Math.min(copy.length, index)), 0, node);
    commit(copy, nextLevels); setSelection(id); setAnnouncement(`${labels.find(item => item.type === type)!.title} added.`);
  }
  function remove(node: GameFlowNode) {
    if (disabled || node.type === 'level' && levels.length <= 1) return;
    commit(nodes.filter(item => item.id !== node.id), node.type === 'level' ? levels.filter(level => level.id !== node.levelId) : levels); setAnnouncement('Step removed.');
  }
  function startDrag(event: DragEvent, value: string) {
    if (disabled || value.startsWith('move:') && nodes.find(node => node.id === value.slice(5))?.type === 'menu') { event.preventDefault(); return; }
    const payload = JSON.stringify({ token: crypto.randomUUID(), value });
    activeDrag.current = { payload, value };
    event.dataTransfer.setData(dragType, payload); event.dataTransfer.effectAllowed = value.startsWith('add:') ? 'copy' : 'move';
  }
  function endDrag() { activeDrag.current = undefined; }
  function drop(event: DragEvent, index: number) {
    event.preventDefault(); event.stopPropagation(); if (disabled) return;
    const gesture = activeDrag.current; activeDrag.current = undefined;
    if (!gesture || event.dataTransfer.getData(dragType) !== gesture.payload) return;
    const value = gesture.value;
    if (value.startsWith('move:')) { const id = value.slice(5), source = nodes.findIndex(node => node.id === id); if (source >= 0) move(id, index > source ? index - 1 : index); }
    else if (value.startsWith('add:') && palette.some(item => item.type === value.slice(4))) add(value.slice(4) as Addition, index);
  }
  function allowDrop(event: DragEvent) { if (!disabled && activeDrag.current && event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = activeDrag.current.value.startsWith('add:') ? 'copy' : 'move'; } }
  return <section className="game-level-plan game-flow-plan" aria-labelledby="game-flow-heading">
    <div className="game-section-heading"><div><span className="eyebrow">BUILD THE JOURNEY</span><h3 id="game-flow-heading">Your game flow.</h3></div><span className="game-level-count">{levels.length} / 8 levels · {nodes.length} / 24 steps</span></div>
    <p className="game-small-note">Drag a step into the stack, then select it to edit its settings. Use the add buttons and move arrows with a keyboard or touch. {neutralLabels ? 'Levels work on their own; client objects, videos and interactive objects are optional.' : 'Levels can stand alone as a fun game; lessons, videos and exercises are optional.'}</p>
    <div className="game-flow-palette" aria-label="Add a game flow step">{labels.map(item => <button key={item.type} type="button" className="button secondary" draggable={!disabled && !(cooperative && item.type !== 'level')} onDragStart={event => startDrag(event, `add:${item.type}`)} onDragEnd={endDrag} onClick={() => add(item.type)} disabled={disabled || nodes.length >= 24 || item.type === 'level' && levels.length >= 8 || cooperative && item.type !== 'level' || item.type === 'menu' && nodes.some(node => node.type === 'menu')}><span aria-hidden="true">{item.symbol}</span> ＋ {item.title}</button>)}</div>
    {cooperative && <p className="game-small-note">This shared world supports game levels. Client material and a level home are available in solo leveled games.</p>}
    <div className="game-flow-editor"><ol className="game-flow-stack" aria-label="Ordered game flow" onDragOver={allowDrop} onDrop={event => drop(event, nodes.length)}>{nodes.map((node, index) => {
      const level = node.type === 'level' ? levels.find(item => item.id === node.levelId) : undefined;
      return <li key={node.id} className={`${selected.id === node.id ? 'selected' : ''} step-${node.type}`} onDragOver={allowDrop} onDrop={event => drop(event, index)}><button type="button" className="game-flow-step" aria-pressed={selected.id === node.id} draggable={!disabled && node.type !== 'menu'} onDragStart={event => startDrag(event, `move:${node.id}`)} onDragEnd={endDrag} onClick={() => setSelection(node.id)}><span className="game-flow-number">{index + 1}</span><span><small>{node.type === 'level' ? 'GAME LEVEL' : node.type === 'menu' ? 'LEVEL HOME' : neutralLabels && node.kind === 'lesson' ? 'CLIENT OBJECT' : neutralLabels && node.kind === 'exercise' ? 'INTERACTIVE OBJECT' : node.kind.toUpperCase()}</small><strong>{level?.title || (node.type !== 'level' ? node.title : 'Untitled level')}</strong>{level && <em>{worlds.find(world => world.id === level.theme)?.title} · {level.rules.goal} rewards</em>}</span></button><div className="game-flow-order"><button type="button" disabled={disabled || node.type === 'menu' || index === 0 || index === 1 && nodes[0].type === 'menu'} aria-label={`Move step ${index + 1} earlier`} onClick={() => move(node.id, index - 1)}>↑</button><button type="button" disabled={disabled || node.type === 'menu' || index === nodes.length - 1} aria-label={`Move step ${index + 1} later`} onClick={() => move(node.id, index + 1)}>↓</button></div></li>;
    })}<li className="game-flow-drop" aria-hidden="true">Drop a step here</li></ol>
    <div className="game-flow-inspector" key={selected.id}><span className="eyebrow">{selected.type === 'level' ? 'LEVEL SETTINGS' : selected.type === 'menu' ? 'HOME SCREEN SETTINGS' : 'CLIENT MATERIAL SETTINGS'}</span><h4>{selectedLevel?.title || (selected.type !== 'level' ? selected.title : 'Level settings')}</h4>
      {selectedLevel ? <LevelSettings level={selectedLevel} disabled={disabled} onChange={level => commit(nodes, levels.map(item => item.id === level.id ? level : item))}/> : selected.type === 'material' ? <fieldset disabled={disabled} className="game-flow-settings"><label>Material title<input value={selected.title} maxLength={80} onChange={event => commit(nodes.map(node => node.id === selected.id ? { ...selected, title: event.target.value } : node))}/></label><label>Material type<select value={selected.kind} onChange={event => commit(nodes.map(node => node.id === selected.id ? { ...selected, kind: event.target.value as 'lesson' | 'video' | 'exercise' } : node))}><option value="lesson">{neutralLabels ? 'Client object' : 'Lesson'}</option><option value="video">Video</option><option value="exercise">{neutralLabels ? 'Interactive object' : 'Exercise'}</option></select></label><label>Client material reference<input value={selected.reference} maxLength={128} autoComplete="off" placeholder={neutralLabels ? 'client:object-123' : 'ncacademy:lesson-123'} onChange={event => commit(nodes.map(node => node.id === selected.id ? { ...selected, reference: event.target.value } : node))}/></label><p className="game-small-note">{neutralLabels ? 'Use a client-owned reference such as client:object-123. The connected application resolves it and displays its own object or video. Enter no URLs, personal information or access tokens.' : 'Use a client-owned reference such as ncacademy:lesson-123. The connected application resolves it and displays its own lesson, video or exercise. Enter no URLs, student information or access tokens.'}</p><label className="game-checkbox"><input type="checkbox" checked={selected.required} onChange={event => commit(nodes.map(node => node.id === selected.id ? { ...selected, required: event.target.checked } : node))}/>Require the client to confirm completion before continuing</label><p className="game-small-note">{selected.required ? 'In the published game, this step waits for a connected client. The private playtest offers an explicit preview action.' : 'Standalone players can continue past this step. A connected client can display its material before continuing.'} {neutralLabels ? 'The client controls completion decisions and any external awards.' : 'Game Studio does not award assignment credit for this step; the client controls completion and points.'}</p></fieldset> : selected.type === 'menu' ? <fieldset disabled={disabled} className="game-flow-settings"><label>Home screen title<input value={selected.title} maxLength={80} onChange={event => commit(nodes.map(node => node.id === selected.id ? { ...selected, title: event.target.value } : node))}/></label><p className="game-small-note">The home screen sits first. Players can practice any unlocked level or play the full adventure in order for combined points and completion. Required client activities unlock later practice levels.</p></fieldset> : null}
      <button type="button" className="text-button danger game-flow-remove" disabled={disabled || selected.type === 'level' && levels.length <= 1} onClick={() => remove(selected)}>Remove {selected.type === 'level' ? 'level' : 'step'}</button>
    </div></div>
    <div className="game-flow-footer"><label>Journey description<textarea rows={2} maxLength={300} disabled={disabled} value={spec.progression ?? 'Explore each world, collect rewards and finish the adventure.'} onChange={event => onChange({ ...spec, version: spec.version === 1 ? 2 : spec.version, levels, progression: event.target.value.replace(/[\r\n]/g, ' ') })}/></label>{spec.flow && <button type="button" className="text-button" disabled={disabled} onClick={() => { void (async () => { if (spec.flow?.nodes.some(node => node.type !== 'level') && !await confirm('Remove the custom material and home steps from this draft? Your authored game levels will stay saved.')) return; const { flow: _flow, ...next } = spec; onChange(next); setAnnouncement('Custom flow removed. Authored levels kept.'); })(); }}>Use levels only · remove custom flow</button>}<p className="game-small-note">Custom flow is for solo games with levels. Remove the custom flow before switching to continuous or two-player play; your authored levels stay saved. Client material needs the host integration before it can run in that application.</p></div>
    <p role="status" className="game-flow-announcement">{announcement}</p>
  </section>;
}
