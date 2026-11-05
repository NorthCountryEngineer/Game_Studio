import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  QUESTION_QUEST_AVATARS, QUESTION_QUEST_STORAGE_KEY, QUEST_BOARD_LENGTH,
  createQuestionQuest, upsertQuestQuestion, removeQuestQuestion, finishQuestQuestions,
  configureQuestTeams, pickFirstQuestTeam, startQuestionQuest, drawQuestCard,
  answerQuestCard, rollQuestDie, nextQuestTeam, rematchQuestionQuest,
  projectQuestionQuest, loadQuestionQuest, saveQuestionQuest,
  type QuestQuestion, type QuestState, type QuestTeamSetup,
} from '../lib/question-quest';
import '../question-quest.css';

type Navigate = (path: string) => void | Promise<void>;
type TeamDraft = QuestTeamSetup;
type Boot = { state: QuestState; blocked: boolean; message: string };
const COLORS = ['#cf6652', '#25887e', '#5874bb', '#c29132'];
const COLOR_NAMES = ['Coral', 'Jade', 'Blue', 'Gold'];
const LETTERS = ['A', 'B', 'C', 'D'];
const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const HOMES = [[206, 214], [594, 214], [594, 586], [206, 586]];
const FINISHES = [[265, 290], [535, 290], [535, 510], [265, 510]];
const TRACK = [
  ...Array.from({ length: 8 }, (_, i) => [90 + i * 88.57, 90]),
  ...Array.from({ length: 6 }, (_, i) => [710, 178.57 + i * 88.57]),
  ...Array.from({ length: 8 }, (_, i) => [710 - i * 88.57, 710]),
  ...Array.from({ length: 6 }, (_, i) => [90, 621.43 - i * 88.57]),
];
const blankChoices = () => ['', '', '', ''];
const problem = (error: unknown) => error instanceof Error ? error.message : 'That action could not be completed. Please try again.';
const avatar = (id: string) => QUESTION_QUEST_AVATARS.find(value => value.id === id) ?? QUESTION_QUEST_AVATARS[0];
const ordinal = (number: number) => ['1st', '2nd', '3rd', '4th'][number - 1] ?? String(number);
const random = () => { const value = new Uint32Array(1); crypto.getRandomValues(value); return value[0] / 4294967296; };
const fresh = () => createQuestionQuest(crypto.randomUUID());
function boot(): Boot {
  try {
    const restored = loadQuestionQuest(window.localStorage);
    if (restored.status === 'ready') return { state: restored.state, blocked: false, message: 'Your saved quest is ready where you left it.' };
    if (restored.status === 'empty') return { state: fresh(), blocked: false, message: '' };
    return { state: fresh(), blocked: true, message: 'We couldn’t open the saved quest. Your saved data has not been changed.' };
  } catch { return { state: fresh(), blocked: true, message: 'This browser’s saved quest is unavailable. Your saved data has not been changed.' }; }
}

export function QuestionQuest({ navigate }: { navigate: Navigate }) {
  const [initial] = useState(boot), [state, setState] = useState(initial.state);
  const current = useRef(state), root = useRef<HTMLElement>(null), deck = useRef<HTMLButtonElement>(null), modal = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]), locked = useRef(false), mounted = useRef(true), animationEpoch = useRef(0);
  const [storageBlocked, setStorageBlocked] = useState(initial.blocked), [recoveryOpen, setRecoveryOpen] = useState(initial.blocked), [saveIssue, setSaveIssue] = useState('');
  const [notice, setNotice] = useState(initial.message), [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false), [reducedMotion, setReducedMotion] = useState(false);
  const [question, setQuestion] = useState(''), [choices, setChoices] = useState(blankChoices), [choiceCount, setChoiceCount] = useState(4), [correctIndex, setCorrectIndex] = useState(0), [editing, setEditing] = useState<string>();
  const [teamDrafts, setTeamDrafts] = useState<TeamDraft[]>(() => state.teams.map(team => ({ id: team.id, name: team.name, avatar: team.avatar })));
  const [busy, setBusy] = useState<'card' | 'die' | 'picker'>(), [die, setDie] = useState(1), [picker, setPicker] = useState<number>();
  const [cardOpen, setCardOpen] = useState(state.phase === 'playing' && state.turn.stage !== 'draw');
  const [flight, setFlight] = useState({ x: 0, y: 0 }), [celebrate, setCelebrate] = useState<string>();
  const [confirm, setConfirm] = useState<'new' | 'restart' | 'recover'>(), [remove, setRemove] = useState<string>();
  const previousFinishCount = useRef(state.finishOrder.length);
  const view = projectQuestionQuest(state);
  const activeIndex = state.currentTeamIndex, active = activeIndex === null ? undefined : state.teams[activeIndex];
  const activeColor = COLORS[activeIndex ?? 0];

  function apply(operation: (value: QuestState) => QuestState, expected = state) {
    if (current.current !== expected || locked.current) return undefined;
    try {
      const next = operation(current.current); current.current = next; setState(next); setError('');
      if (!storageBlocked) {
        try { saveQuestionQuest(next, window.localStorage); setSaveIssue(''); }
        catch { setSaveIssue('This browser can’t save changes right now. Keep this tab open to continue your quest.'); }
      }
      return next;
    } catch (value) { setError(problem(value)); return undefined; }
  }
  function cancelAnimations() {
    timers.current.forEach(clearTimeout); timers.current = []; animationEpoch.current += 1;
    locked.current = false; setBusy(undefined);
  }
  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    const controls = dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]');
    if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function later(callback: () => void, delay: number) {
    const timer = setTimeout(() => { if (mounted.current) callback(); }, reducedMotion ? Math.min(delay, 80) : delay);
    timers.current.push(timer);
  }
  function animate(kind: 'card' | 'die' | 'picker', duration: number, callback: () => void) {
    if (locked.current) return;
    const expected = current.current, epoch = ++animationEpoch.current;
    locked.current = true; setBusy(kind);
    later(() => {
      if (animationEpoch.current !== epoch || current.current !== expected) return;
      callback(); locked.current = false; setBusy(undefined);
    }, duration);
  }
  useEffect(() => { current.current = state; }, [state]);
  useEffect(() => {
    if (storageBlocked) return;
    try { saveQuestionQuest(state, window.localStorage); setSaveIssue(''); }
    catch { setSaveIssue('This browser can’t save changes right now. Keep this tab open to continue your quest.'); }
  }, [state, storageBlocked]);
  useEffect(() => {
    if (previousFinishCount.current === 0 && state.finishOrder.length > 0) setCelebrate(state.finishOrder[0]);
    previousFinishCount.current = state.finishOrder.length;
  }, [state.finishOrder]);
  useEffect(() => {
    mounted.current = true;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReducedMotion(media.matches);
    const change = () => setFullscreen(document.fullscreenElement === root.current);
    motion(); media.addEventListener('change', motion); document.addEventListener('fullscreenchange', change);
    return () => { mounted.current = false; timers.current.forEach(clearTimeout); media.removeEventListener('change', motion); document.removeEventListener('fullscreenchange', change); };
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (element.closest('input,textarea,select,[contenteditable="true"]')) return;
      if ((event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) || (event.key === 'Enter' && event.altKey)) { event.preventDefault(); void toggleFullscreen(); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (!cardOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.focus();
    return () => previous?.focus();
  }, [cardOpen]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen();
      else setNotice('Full screen is unavailable in this browser. You can still play on this page.');
    } catch { setNotice('Full screen could not open. You can keep playing on this page.'); }
  }
  function resetEditor() { setQuestion(''); setChoices(blankChoices()); setCorrectIndex(0); setChoiceCount(4); setEditing(undefined); }
  function saveQuestion(event: FormEvent) {
    event.preventDefault();
    const next = apply(value => upsertQuestQuestion(value, { id: editing ?? crypto.randomUUID(), prompt: question, choices: choices.slice(0, choiceCount), correctIndex }));
    if (next) { resetEditor(); setNotice(editing ? 'Question updated.' : 'Question added. Ready for another?'); }
  }
  function editQuestion(value: QuestQuestion) { setEditing(value.id); setQuestion(value.prompt); setChoices([...value.choices, ...blankChoices()].slice(0, 4)); setChoiceCount(value.choices.length); setCorrectIndex(value.correctIndex); setError(''); document.getElementById('quest-question-prompt')?.focus(); }
  function draw() {
    if (locked.current) return;
    const rect = deck.current?.getBoundingClientRect();
    if (rect) setFlight({ x: rect.left + rect.width / 2 - window.innerWidth / 2, y: rect.top + rect.height / 2 - window.innerHeight / 2 });
    const next = apply(value => drawQuestCard(value, random));
    if (next) { setCardOpen(true); animate('card', 700, () => {}); }
  }
  function roll() {
    if (locked.current) return;
    const next = apply(value => rollQuestDie(value, random));
    if (!next) return;
    setDie(next.turn.roll ?? 1);
    animate('die', 850, () => setCardOpen(false));
  }
  function nextTeam() { if (locked.current) return; const next = apply(nextQuestTeam); if (next) { setCardOpen(false); setNotice(''); } }
  function pickFirst() {
    if (locked.current) return;
    const next = apply(value => pickFirstQuestTeam(value, random));
    if (!next) return;
    setPicker(next.firstTeamIndex ?? undefined);
    animate('picker', 1000, () => {});
  }
  function startTeams(event: FormEvent) { event.preventDefault(); apply(value => configureQuestTeams(value, teamDrafts)); }
  function newGame() {
    if (current.current !== state) return;
    cancelAnimations(); setRecoveryOpen(false);
    try {
      const previous = window.localStorage.getItem(QUESTION_QUEST_STORAGE_KEY);
      if (previous) window.localStorage.setItem(`${QUESTION_QUEST_STORAGE_KEY}:previous`, previous);
      setStorageBlocked(false);
    } catch { setStorageBlocked(true); setSaveIssue('A new quest can run in this tab, but this browser cannot save it. The previous saved data is untouched.'); }
    const next = fresh(); current.current = next; setState(next); previousFinishCount.current = 0; setCelebrate(undefined); setCardOpen(false); setConfirm(undefined); setNotice(''); setError(''); resetEditor();
    setTeamDrafts(next.teams.map(team => ({ id: team.id, name: team.name, avatar: team.avatar })));
  }
  function recover() {
    if (current.current !== state) return;
    cancelAnimations();
    const next = boot();
    if (next.blocked) { setNotice(next.message); return; }
    current.current = next.state; setState(next.state); setStorageBlocked(false); setRecoveryOpen(false); setNotice('Saved quest restored.'); setError('');
    previousFinishCount.current = next.state.finishOrder.length;
    setTeamDrafts(next.state.teams.map(team => ({ id: team.id, name: team.name, avatar: team.avatar })));
    setCardOpen(next.state.phase === 'playing' && next.state.turn.stage !== 'draw');
  }
  const unsavedQuestion = Boolean(editing || question.trim() || choices.some(value => value.trim()));
  const champion = state.teams.find(team => team.id === celebrate);
  const first = state.firstTeamIndex === null ? undefined : state.teams[state.firstTeamIndex];

  return <main id="main" ref={root} className={`quest-page ${fullscreen ? 'quest-fullscreen' : ''}`}>
    <header className="quest-header"><div className="quest-brand"><span className="quest-brand-symbol" aria-hidden="true">✦</span><div><span>YOUR PEOPLE. YOUR QUESTIONS.</span><h1>Question Quest<span aria-hidden="true">.</span></h1></div></div><nav className="quest-header-actions" aria-label="Game controls"><button onClick={() => void navigate('/party')} className="quest-button quest-button-quiet">← Party games</button><button onClick={() => void toggleFullscreen()} className="quest-button quest-button-outline">{fullscreen ? '↙ Exit full screen' : '↗ Full screen'}</button></nav></header>
    <div className="quest-subbar"><span className="quest-local-note"><i aria-hidden="true"/> One screen. Four teams. Endless possibilities.</span><details className="quest-help"><summary>How to play <span aria-hidden="true">?</span></summary><div><strong>A little knowledge. A little luck.</strong><ol><li>The host adds multiple-choice questions and marks each correct answer before the teams gather.</li><li>Four teams choose their names and icons. Pick a random first team.</li><li>Draw a card. The host clicks the answer the team gives.</li><li>A correct answer earns one point and a die roll. Move that many spaces toward home. A wrong answer ends the turn without moving.</li><li>The first team home gets the first celebration. Keep playing, skipping finished teams, until everyone arrives.</li></ol><p>Questions repeat in a fresh shuffled deck when the stack runs out. Progress stays in this browser.</p></div></details></div>

    {recoveryOpen ? <section className="quest-recovery quest-panel"><span className="quest-eyebrow">YOUR SAVED QUEST</span><h2>Let’s keep your game safe.</h2><p>{notice}</p><div className="quest-actions"><button className="quest-button quest-button-primary" onClick={recover}>Try opening it again</button><button className="quest-button quest-button-outline-dark" onClick={() => setConfirm('recover')}>Start a fresh quest</button></div></section> : <>
      {state.phase === 'questions' && <section className="quest-setup"><div className="quest-setup-heading"><div><span className="quest-eyebrow">01 / MAKE IT YOURS</span><h2>Every great quest<br/>starts with a question.</h2><p>Add your own questions, one at a time. Mark the right answer here; your question bank stays hidden once the teams join.</p></div><div className="quest-setup-stamp" aria-hidden="true"><span>YOU ASK.</span><strong>?</strong><span>THEY ADVENTURE.</span></div></div><div className="quest-question-grid"><form className="quest-panel quest-question-editor" onSubmit={saveQuestion}><div className="quest-panel-heading"><h3>{editing ? 'Edit your question' : `Question ${state.questions.length + 1}`}</h3><span>HOST SETUP</span></div><label htmlFor="quest-question-prompt">Your question<textarea id="quest-question-prompt" value={question} onChange={event => setQuestion(event.target.value)} required maxLength={300} rows={3} placeholder="What will you ask your teams?"/></label><div className="quest-choice-heading"><strong>Answer choices</strong><label>Choices<select aria-label="Number of answer choices" value={choiceCount} onChange={event => { const count = Number(event.target.value); setChoiceCount(count); if (correctIndex >= count) setCorrectIndex(0); }}>{[2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}</select></label></div><fieldset className="quest-answer-editor"><legend>Choose the correct answer</legend>{choices.slice(0, choiceCount).map((choice, index) => <div key={index} className={correctIndex === index ? 'is-correct-choice' : ''}><label className="quest-correct-picker"><input type="radio" name="quest-correct" checked={correctIndex === index} onChange={() => setCorrectIndex(index)} aria-label={`Choice ${LETTERS[index]} is correct`}/><span>{LETTERS[index]}</span></label><label className="quest-answer-field"><span className="quest-sr-only">Answer {LETTERS[index]}</span><input value={choice} onChange={event => setChoices(values => values.map((value, at) => at === index ? event.target.value : value))} required maxLength={120} placeholder={`Answer ${LETTERS[index]}`}/></label><span className="quest-correct-tag">{correctIndex === index ? '✓ Correct' : ''}</span></div>)}</fieldset><div className="quest-actions"><button className="quest-button quest-button-primary">{editing ? 'Save changes' : '+ Add question'}</button>{unsavedQuestion && <button type="button" className="quest-button quest-button-text" onClick={resetEditor}>{editing ? 'Cancel edit' : 'Clear draft'}</button>}</div></form><aside className="quest-panel quest-bank"><div className="quest-panel-heading"><h3>Your card stack</h3><span>{state.questions.length} {state.questions.length === 1 ? 'CARD' : 'CARDS'}</span></div>{state.questions.length ? <ol>{state.questions.map((item, index) => <li key={item.id}><span className="quest-bank-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.prompt}</strong><div className="quest-bank-controls"><button type="button" onClick={() => editQuestion(item)}>Edit</button>{remove === item.id ? <><button type="button" onClick={() => { apply(value => removeQuestQuestion(value, item.id)); setRemove(undefined); if (editing === item.id) resetEditor(); }}>Confirm remove</button><button type="button" onClick={() => setRemove(undefined)}>Keep</button></> : <button type="button" onClick={() => setRemove(item.id)}>Remove</button>}</div></div></li>)}</ol> : <div className="quest-empty-stack"><span aria-hidden="true">✦</span><h4>A stack with your signature.</h4><p>Your saved questions appear here. Add at least one to begin.</p></div>}<div className="quest-bank-footer"><p>{unsavedQuestion ? 'Add or clear the question in the editor before continuing.' : 'Ready? Questions and correct answers will leave the screen.'}</p><button className="quest-button quest-button-primary" disabled={!state.questions.length || unsavedQuestion} onClick={() => { const next = apply(finishQuestQuestions); if (next) { resetEditor(); setNotice(''); } }}>Set up the teams <span aria-hidden="true">→</span></button></div></aside></div></section>}

      {state.phase === 'teams' && <section className="quest-team-setup"><div className="quest-center-heading"><span className="quest-eyebrow">02 / MEET THE ADVENTURERS</span><h2>Four teams.<br/><em>Make a name for yourselves.</em></h2><p>Your question stack is tucked away. Choose your crew’s name and a little personality.</p></div><form onSubmit={startTeams}><div className="quest-team-drafts">{teamDrafts.map((team, index) => <section key={team.id} className="quest-team-draft" style={{ '--team-color': COLORS[index] } as CSSProperties}><span className="quest-eyebrow">TEAM {index + 1} · {COLOR_NAMES[index]}</span><span className="quest-selected-avatar" aria-hidden="true">{avatar(team.avatar).emoji}</span><label htmlFor={`quest-team-${index}`}>Team name<input id={`quest-team-${index}`} value={team.name} onChange={event => setTeamDrafts(values => values.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} maxLength={32} required autoComplete="off"/></label><fieldset><legend>Pick your icon</legend><div>{QUESTION_QUEST_AVATARS.map(icon => <button key={icon.id} type="button" aria-label={`${icon.label} for team ${index + 1}`} aria-pressed={team.avatar === icon.id} className={team.avatar === icon.id ? 'is-selected' : ''} onClick={() => setTeamDrafts(values => values.map((value, at) => at === index ? { ...value, avatar: icon.id } : value))}>{icon.emoji}</button>)}</div></fieldset></section>)}</div><button className="quest-button quest-button-primary quest-button-large" type="submit">Meet at the starting line <span aria-hidden="true">→</span></button></form></section>}

      {state.phase === 'first-team-picker' && <section className="quest-first-picker"><div className="quest-center-heading"><span className="quest-eyebrow">03 / LET CHANCE CHOOSE</span><h2>{first && !busy ? `${first.name}, you’re up first.` : 'Who starts the adventure?'}</h2><p>{first && !busy ? 'Everyone else follows in team order. Ready to make your first move?' : 'One fair pick. Then the quest is yours.'}</p></div><div className={`quest-picker-teams ${busy === 'picker' ? 'is-picking' : ''}`}>{state.teams.map((team, index) => <div key={team.id} className={(busy === 'picker' ? picker === index : state.firstTeamIndex === index) ? 'is-picked' : ''} style={{ '--team-color': COLORS[index], '--pick-index': index } as CSSProperties}><span>{avatar(team.avatar).emoji}</span><strong>{team.name}</strong><small>{state.firstTeamIndex === index && !busy ? 'FIRST TO PLAY' : COLOR_NAMES[index] + ' TEAM'}</small></div>)}</div><div className="quest-center-actions">{first && !busy ? <button className="quest-button quest-button-primary quest-button-large" onClick={() => { const next = apply(startQuestionQuest); if (next) { setCardOpen(false); setNotice(''); } }}>Let’s play <span aria-hidden="true">→</span></button> : <button className="quest-button quest-button-primary quest-button-large" disabled={Boolean(busy)} onClick={pickFirst}>{busy ? 'Choosing your first team…' : '✦ Pick the first team'}</button>}</div></section>}

      {(state.phase === 'playing' || state.phase === 'results') && <section className="quest-game-layout"><div className="quest-board-wrap"><div className="quest-board-corners" aria-hidden="true"><span>ASK.</span><span>ANSWER.</span><span>ADVANCE.</span><span>CELEBRATE.</span></div><div className="quest-board"><svg viewBox="0 0 800 800" className="quest-board-art" role="img" aria-label={`Question Quest board. ${QUEST_BOARD_LENGTH} spaces to home. ${state.teams.map(team => `${team.name}: ${team.position === QUEST_BOARD_LENGTH ? 'home' : `${team.position} spaces`}`).join('. ')}`}><defs><pattern id="quest-board-grain" width="13" height="13" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".65" fill="#b5a688" opacity=".22"/></pattern><filter id="quest-token-shadow" x="-60%" y="-60%" width="220%" height="230%"><feDropShadow dx="0" dy="6" stdDeviation="5" floodColor="#1a2636" floodOpacity=".2"/></filter></defs><rect x="14" y="14" width="772" height="772" rx="36" fill="#f5eddd"/><rect x="14" y="14" width="772" height="772" rx="36" fill="url(#quest-board-grain)"/><rect x="44" y="44" width="712" height="712" rx="24" fill="none" stroke="#d9cdb6" strokeWidth="2"/><rect x="137" y="137" width="526" height="526" rx="30" fill="none" stroke="#ddd2bf" strokeDasharray="3 9"/>{TRACK.map(([x, y], index) => { const color = COLORS[Math.floor(index / 7)]; return <g key={index}><rect x={x - 34} y={y - 34} width="68" height="68" rx="15" fill="#fffaf0" stroke={color} strokeOpacity=".4" strokeWidth="2"/><circle cx={x} cy={y} r={index % 7 === 0 ? 9 : 3} fill={color} opacity={index % 7 === 0 ? .6 : .32}/>{index % 7 === 0 && <path d={`M ${x - 4} ${y - 3} l 8 3 -8 3 Z`} fill="#fffaf0"/>}</g>; })}{state.teams.map((team, index) => <g key={team.id}><rect x={HOMES[index][0] - 57} y={HOMES[index][1] - 51} width="114" height="102" rx="24" fill={COLORS[index]} opacity=".12"/><text x={HOMES[index][0]} y={HOMES[index][1] + 34} textAnchor="middle" fill={COLORS[index]} fontSize="12" fontWeight="800" letterSpacing="2">START</text><circle cx={FINISHES[index][0]} cy={FINISHES[index][1]} r="31" fill={COLORS[index]} opacity=".13"/><circle cx={FINISHES[index][0]} cy={FINISHES[index][1]} r="24" fill="none" stroke={COLORS[index]} strokeDasharray="3 5"/><text x={FINISHES[index][0]} y={FINISHES[index][1] + 49} textAnchor="middle" fill={COLORS[index]} fontSize="11" fontWeight="800" letterSpacing="2">HOME</text></g>)}<text x="400" y="205" textAnchor="middle" className="quest-board-wordmark">QUESTION</text><text x="400" y="246" textAnchor="middle" className="quest-board-wordmark quest-board-wordmark-big">QUEST</text><path d="M 365 564 h 70 M 400 552 v 24" stroke="#c0ae8b" strokeWidth="2"/><text x="400" y="612" textAnchor="middle" fill="#82745d" fontSize="13" letterSpacing="3">A LITTLE KNOWLEDGE. A LITTLE LUCK.</text>{state.teams.map((team, index) => { const location = team.position <= 0 ? HOMES[index] : team.position >= QUEST_BOARD_LENGTH ? FINISHES[index] : TRACK[(index * 7 + team.position - 1) % TRACK.length]; const occupants = state.teams.filter(other => other.position > 0 && other.position < QUEST_BOARD_LENGTH && ((state.teams.indexOf(other) * 7 + other.position - 1) % TRACK.length) === ((index * 7 + team.position - 1) % TRACK.length)); const rank = occupants.findIndex(other => other.id === team.id); const dx = team.position > 0 && team.position < QUEST_BOARD_LENGTH && occupants.length > 1 ? (rank - (occupants.length - 1) / 2) * 21 : 0; return <g key={team.id} className={`quest-token ${activeIndex === index && state.phase === 'playing' ? 'is-current' : ''}`} style={{ transform: `translate(${location[0] + dx}px,${location[1]}px)`, '--team-color': COLORS[index] } as CSSProperties}><circle r="29" fill={COLORS[index]} stroke="#fffdf7" strokeWidth="5" filter="url(#quest-token-shadow)"/><text y="9" textAnchor="middle" fontSize="30">{avatar(team.avatar).emoji}</text>{team.position >= QUEST_BOARD_LENGTH && <circle cx="22" cy="-22" r="11" fill="#fffaf0" stroke={COLORS[index]} strokeWidth="2"/>}{team.position >= QUEST_BOARD_LENGTH && <text x="22" y="-18" textAnchor="middle" fontSize="12" fill={COLORS[index]} fontWeight="800">{state.finishOrder.indexOf(team.id) + 1}</text>}</g>; })}</svg><div className="quest-board-center">{state.phase === 'results' ? <div className="quest-center-finished"><span aria-hidden="true">✦</span><strong>Everyone’s home.</strong><small>A quest well played.</small></div> : <button ref={deck} className={`quest-card-stack ${busy === 'card' ? 'is-dealing' : ''}`} onClick={() => state.turn.stage === 'draw' ? draw() : setCardOpen(true)} disabled={Boolean(busy)} aria-label={state.turn.stage === 'draw' ? `Draw a question card for ${active?.name}` : 'Open the current question card'}><span className="quest-stack-back"/><span className="quest-stack-mid"/><span className="quest-stack-front"><small>QUESTION</small><strong>?</strong><small>QUEST</small></span><span className="quest-stack-prompt">{state.turn.stage === 'draw' ? 'Draw a card' : 'Open your card'} <span aria-hidden="true">↗</span></span></button>}</div></div><div className="quest-board-caption"><span><i aria-hidden="true"/> {QUEST_BOARD_LENGTH} spaces to home</span><span>Correct answer → +1 point → roll & move</span></div></div><aside className="quest-game-sidebar"><div className="quest-turn-panel" style={{ '--team-color': activeColor } as CSSProperties}><span className="quest-eyebrow">{state.phase === 'results' ? 'THE QUEST IS COMPLETE' : `TURN ${state.turnNumber} · YOUR MOVE`}</span><h2>{state.phase === 'results' ? 'What a finish.' : active?.name}</h2>{state.phase === 'results' ? <p>Every team has crossed the finish. The order tells the story.</p> : <><p>{state.turn.stage === 'draw' ? 'A new question. A chance to get closer.' : state.turn.stage === 'answer' ? 'Listen to your team, then choose their answer.' : state.turn.stage === 'roll' ? 'That’s a point. Let’s see how far you’ll go.' : state.turn.correct ? `Forward ${state.turn.roll} ${state.turn.roll === 1 ? 'space' : 'spaces'}. Nicely played.` : 'No move this time. The next team is ready.'}</p><div className={`quest-die ${busy === 'die' ? 'is-rolling' : ''}`} aria-label={busy === 'die' ? 'Rolling the die' : state.turn.roll ? `Rolled ${state.turn.roll}` : 'Six-sided die'}><span>{FACES[(state.turn.roll ?? die) - 1]}</span><small>{busy === 'die' ? 'ROLLING…' : state.turn.roll ? `${state.turn.roll} ${state.turn.roll === 1 ? 'SPACE' : 'SPACES'}` : 'YOUR NEXT MOVE'}</small></div>{state.turn.stage === 'draw' ? <button className="quest-button quest-button-primary" disabled={Boolean(busy)} onClick={draw}>Draw a question <span aria-hidden="true">↗</span></button> : state.turn.stage === 'roll' ? <button className="quest-button quest-button-primary" disabled={Boolean(busy)} onClick={roll}>{busy === 'die' ? 'Rolling…' : 'Roll the die →'}</button> : state.turn.stage === 'complete' ? <button className="quest-button quest-button-primary" disabled={Boolean(busy)} onClick={nextTeam}>Next team <span aria-hidden="true">→</span></button> : <button className="quest-button quest-button-primary" onClick={() => setCardOpen(true)}>Show question <span aria-hidden="true">↗</span></button>}</>}</div><section className="quest-standings" aria-label="Teams, scores and positions"><div className="quest-standings-heading"><h3>Your adventurers</h3><span>POINTS</span></div>{state.teams.map((team, index) => <div key={team.id} className={`quest-team-status ${index === activeIndex && state.phase === 'playing' ? 'is-current' : ''} ${team.position >= QUEST_BOARD_LENGTH ? 'is-home' : ''}`} style={{ '--team-color': COLORS[index] } as CSSProperties}><span className="quest-team-icon">{avatar(team.avatar).emoji}</span><div><strong>{team.name}</strong><span>{team.position >= QUEST_BOARD_LENGTH ? `${ordinal(state.finishOrder.indexOf(team.id) + 1)} home · finished` : `Space ${team.position} / ${QUEST_BOARD_LENGTH}`}</span><i className="quest-progress-track"><i style={{ width: `${team.position / QUEST_BOARD_LENGTH * 100}%` }}/></i></div><b>{team.points}<small>{team.points === 1 ? 'PT' : 'PTS'}</small></b></div>)}</section>{state.finishOrder.length > 0 && <section className="quest-finish-order"><h3>Home, sweet home.</h3><ol>{state.finishOrder.map((id, index) => { const team = state.teams.find(value => value.id === id)!; return <li key={id}><b>{ordinal(index + 1)}</b><span>{avatar(team.avatar).emoji} {team.name}</span><small>{team.points} pts</small></li>; })}</ol></section>}{state.phase === 'results' && <button className="quest-button quest-button-primary" onClick={() => { const next = apply(rematchQuestionQuest); if (next) { setCardOpen(false); setCelebrate(undefined); previousFinishCount.current = 0; } }}>Another quest, same questions →</button>}</aside></section>}
    </>}

    {(error || notice || saveIssue) && <div className="quest-feedback" aria-live="polite">{error && <p role="alert">{error}</p>}{!storageBlocked && notice && <p>{notice}</p>}{saveIssue && <p role="status">{saveIssue}</p>}</div>}
    <footer className="quest-footer"><span>{saveIssue || storageBlocked ? 'Keep this tab open to retain your current progress.' : 'Saved privately in this browser.'}</span><button className="quest-button quest-button-quiet" disabled={Boolean(busy)} onClick={() => setConfirm('new')}>New question bank</button></footer>

    {cardOpen && view.question && !celebrate && <div className={`quest-modal-backdrop ${busy === 'card' ? 'is-dealing' : ''}`}><div ref={modal} className="quest-question-card" role="dialog" aria-modal="true" aria-labelledby="quest-card-heading" tabIndex={-1} style={{ '--quest-flight-x': `${flight.x}px`, '--quest-flight-y': `${flight.y}px`, '--team-color': activeColor } as CSSProperties} onKeyDown={event => { trapFocus(event); if (event.key === 'Escape' && !busy) { event.stopPropagation(); setCardOpen(false); } }}><header><span className="quest-eyebrow">{active?.name} · QUESTION CARD</span><button className="quest-card-close" onClick={() => setCardOpen(false)} disabled={Boolean(busy)} aria-label="Minimize question and show board">×</button></header><div className="quest-question-content"><span className="quest-card-flourish" aria-hidden="true">✦</span><h2 id="quest-card-heading">{view.question.prompt}</h2><p>{state.turn.stage === 'answer' ? 'Host: choose the answer your team gives.' : state.turn.correct ? 'Correct. One point, and one step closer to home.' : 'Not this time. Keep the adventure moving.'}</p><div className="quest-answer-buttons">{view.question.choices.map((choice, index) => <button key={index} className={state.turn.selectedIndex === index ? state.turn.correct ? 'is-right' : 'is-wrong' : ''} disabled={state.turn.stage !== 'answer' || Boolean(busy)} onClick={() => apply(value => answerQuestCard(value, index))}><span>{LETTERS[index]}</span><strong>{choice}</strong>{state.turn.selectedIndex === index && <i aria-hidden="true">{state.turn.correct ? '✓' : '×'}</i>}</button>)}</div>{state.turn.stage === 'roll' && <div className="quest-card-outcome"><strong>+1 point <span aria-hidden="true">✦</span></strong><button className="quest-button quest-button-primary quest-button-large" disabled={Boolean(busy)} onClick={roll}>{busy === 'die' ? <span className="quest-inline-die">{FACES[die - 1]} Rolling…</span> : 'Roll the die & make your move →'}</button></div>}{state.turn.stage === 'complete' && <div className="quest-card-outcome"><strong>{state.turn.correct ? `Rolled ${state.turn.roll}. Onward!` : 'No move this turn.'}</strong><button className="quest-button quest-button-primary quest-button-large" disabled={Boolean(busy)} onClick={nextTeam}>Next team →</button></div>}</div></div></div>}

    {champion && <div className="quest-modal-backdrop quest-celebration-backdrop"><div className="quest-celebration" onKeyDown={trapFocus} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="quest-celebration-title"><div className="quest-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--confetti-index': index, '--team-color': COLORS[index % 4] } as CSSProperties}/>)}</div><span className="quest-eyebrow">FIRST HOME. FIRST TO CELEBRATE.</span><span className="quest-winner-icon" aria-hidden="true">{avatar(champion.avatar).emoji}</span><h2 id="quest-celebration-title">{champion.name}<em>made it home!</em></h2><p>One brilliant finish. The adventure keeps going until every team arrives.</p><button autoFocus className="quest-button quest-button-primary quest-button-large" onClick={() => setCelebrate(undefined)}>Keep the quest going →</button></div></div>}
    {confirm && <div className="quest-modal-backdrop"><section className="quest-confirm" onKeyDown={trapFocus} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="quest-confirm-title"><span className="quest-eyebrow">A NEW ADVENTURE</span><h2 id="quest-confirm-title">Start with a fresh stack?</h2><p>Your current questions, teams and progress will be replaced in this browser. A previous copy is kept here when browser storage is available.</p><div className="quest-actions"><button className="quest-button quest-button-primary" onClick={newGame}>Start a new quest</button><button autoFocus className="quest-button quest-button-outline-dark" onClick={() => setConfirm(undefined)}>Keep this quest</button></div></section></div>}
  </main>;
}

export default QuestionQuest;
