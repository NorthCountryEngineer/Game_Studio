import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  QUESTION_QUEST_AVATARS, QUESTION_QUEST_STORAGE_KEY, QUEST_BOARD_LENGTH,
  createQuestionQuest, upsertQuestQuestion, appendQuestQuestions, removeQuestQuestion, finishQuestQuestions,
  configureQuestTeams, pickFirstQuestTeam, startQuestionQuest, drawQuestCard,
  answerQuestCard, rollQuestDie, nextQuestTeam, rematchQuestionQuest,
  projectQuestionQuest, loadQuestionQuest, saveQuestionQuest,
  type QuestQuestion, type QuestState, type QuestTeamSetup,
} from '../lib/question-quest';
import { QUEST_IMPORT_MAX_BYTES, parseQuestQuestionImport, type QuestImportPreview, type QuestImportFormat } from '../lib/question-quest-import';
import { QUEST_QUESTION_SOURCES_STORAGE_KEY, loadQuestQuestionSources, saveQuestQuestionSources, parseQuestQuestionSource, questionSourceKey, type QuestQuestionSource, type QuestQuestionSources } from '../lib/question-quest-sources';
import { GRACIE_QUESTION_PRESET, getGracieQuestionAdditions, sourceForGracieQuestion } from '../lib/gracie-questions';
import '../question-quest.css';

type Navigate = (path: string) => void | Promise<void>;
type TeamDraft = QuestTeamSetup;
type Boot = { state: QuestState; blocked: boolean; message: string };
type PieceMotion = { teamId: string; position: number; phase: QuestState['phase']; currentTeamIndex: number | null; finishOrder: string[] };
type DiceOverlay = { faces: [number, number]; settled: boolean; cadence: number };
type PendingQuestionImport = QuestImportPreview & { base: QuestState; generation: number };
const SCHOOL_LOGO = '/branding/health-school-logo.png';
const COLORS = ['#00652b', '#8a6800', '#4e6c79', '#865f40'];
const COLOR_NAMES = ['Forest', 'Gold', 'Slate', 'Bronze'];
const LETTERS = ['A', 'B', 'C', 'D'];
const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const DICE_FRAME_TIMES = [50, 110, 180, 260, 355, 465, 595, 750, 935, 1155, 1415, 1720, 2070];
const DICE_SETTLE_AT = 2240, DICE_CLOSE_AT = 2600, PIECE_STEP_MS = 85;
const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
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
    if (restored.status === 'ready') return { state: restored.state, blocked: false, message: 'Saved game restored.' };
    if (restored.status === 'empty') return { state: fresh(), blocked: false, message: '' };
    return { state: fresh(), blocked: true, message: 'The saved game could not be opened. Your saved data has not been changed.' };
  } catch { return { state: fresh(), blocked: true, message: 'The saved game is unavailable in this browser. Your saved data has not been changed.' }; }
}

function bootSources(state: QuestState) {
  try { return loadQuestQuestionSources(window.localStorage, state); }
  catch { return { status: 'unavailable' as const, sources: {} as QuestQuestionSources }; }
}

export function QuestionQuest({ navigate }: { navigate: Navigate }) {
  const [initial] = useState(boot), [state, setState] = useState(initial.state);
  const current = useRef(state), root = useRef<HTMLElement>(null), deck = useRef<HTMLButtonElement>(null), modal = useRef<HTMLDivElement>(null), diceModal = useRef<HTMLElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]), locked = useRef(false), mounted = useRef(true), animationEpoch = useRef(0);
  const [storageBlocked, setStorageBlocked] = useState(initial.blocked), [recoveryOpen, setRecoveryOpen] = useState(initial.blocked), [saveIssue, setSaveIssue] = useState('');
  const [notice, setNotice] = useState(initial.message), [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false), [reducedMotion, setReducedMotion] = useState(false);
  const [question, setQuestion] = useState(''), [choices, setChoices] = useState(blankChoices), [choiceCount, setChoiceCount] = useState(4), [correctIndex, setCorrectIndex] = useState(0), [editing, setEditing] = useState<string>();
  const [sourceUrl, setSourceUrl] = useState(''), [sourceCitation, setSourceCitation] = useState(''), [sourceExplanation, setSourceExplanation] = useState('');
  const [initialSources] = useState(() => bootSources(initial.state));
  const [questionSources, setQuestionSources] = useState<QuestQuestionSources>(initialSources.sources), sourceCurrent = useRef(initialSources.sources);
  const [sourceSaveIssue, setSourceSaveIssue] = useState(initialSources.status === 'invalid' ? 'Saved citations could not be opened. Your questions and game progress are unchanged.' : initialSources.status === 'unavailable' ? 'This browser could not read saved citations. Keep this tab open when adding sources.' : '');
  const currentDraft = useRef(false), currentDraftSignature = useRef(''), pageActive = useRef(true), sourceBackupNeeded = useRef(initialSources.status === 'invalid' || initialSources.status === 'unavailable');
  const importGeneration = useRef(0);
  const [importReading, setImportReading] = useState(false), [importPreview, setImportPreview] = useState<PendingQuestionImport>(), [importError, setImportError] = useState('');
  const [teamDrafts, setTeamDrafts] = useState<TeamDraft[]>(() => state.teams.map(team => ({ id: team.id, name: team.name, avatar: team.avatar })));
  const [busy, setBusy] = useState<'card' | 'dice' | 'moving' | 'picker'>(), [picker, setPicker] = useState<number>();
  const [diceOverlay, setDiceOverlay] = useState<DiceOverlay>(), [pieceMotion, setPieceMotion] = useState<PieceMotion>();
  const [cardOpen, setCardOpen] = useState(state.phase === 'playing' && state.turn.stage !== 'draw');
  const [flight, setFlight] = useState({ x: 0, y: 0 }), [celebrate, setCelebrate] = useState<string>();
  const [confirm, setConfirm] = useState<'new' | 'restart' | 'recover'>(), [remove, setRemove] = useState<string>();
  const previousFinishCount = useRef(state.finishOrder.length);
  const view = projectQuestionQuest(state);
  const display: QuestState = pieceMotion ? { ...state, phase: pieceMotion.phase, currentTeamIndex: pieceMotion.currentTeamIndex,
    finishOrder: pieceMotion.finishOrder, teams: state.teams.map(team => team.id === pieceMotion.teamId ? { ...team, position: pieceMotion.position } : team) } : state;
  const activeIndex = display.currentTeamIndex, active = activeIndex === null ? undefined : display.teams[activeIndex];
  const activeColor = COLORS[activeIndex ?? 0];

  function apply(operation: (value: QuestState) => QuestState, expected = state) {
    if (current.current !== expected || locked.current) return undefined;
    try {
      const next = operation(current.current); current.current = next; setState(next); setError('');
      if (!storageBlocked) {
        try { saveQuestionQuest(next, window.localStorage); setSaveIssue(''); }
        catch { setSaveIssue('This browser can’t save changes right now. Keep this tab open to continue playing.'); }
      }
      return next;
    } catch (value) { setError(problem(value)); return undefined; }
  }
  function sourceForQuestion(card: QuestQuestion): QuestQuestionSource | undefined {
    return questionSources[questionSourceKey(card)] ?? sourceForGracieQuestion(card);
  }
  function commitQuestionSources(next: QuestState, values: QuestQuestionSources, canSave = !storageBlocked) {
    const kept: QuestQuestionSources = {};
    for (const card of next.questions) { const key = questionSourceKey(card); if (values[key]) kept[key] = values[key]; }
    sourceCurrent.current = kept; setQuestionSources(kept);
    if (!canSave) return;
    try {
      if (sourceBackupNeeded.current) { const previous = window.localStorage.getItem(QUEST_QUESTION_SOURCES_STORAGE_KEY); if (previous) window.localStorage.setItem(`${QUEST_QUESTION_SOURCES_STORAGE_KEY}:previous`, previous); sourceBackupNeeded.current = false; }
      saveQuestQuestionSources(window.localStorage, next, kept); setSourceSaveIssue('');
    }
    catch { setSourceSaveIssue('This browser can’t save citations right now. Keep this tab open to retain them. Your questions and progress remain available.'); }
  }
  function sourcesForBatch(inputs: QuestImportPreview['questions'], values?: (QuestQuestionSource | null)[]) {
    const next = { ...sourceCurrent.current };
    inputs.forEach((card, index) => { if (values?.[index]) next[questionSourceKey(card)] = values[index]!; });
    return next;
  }
  function cancelAnimations() {
    timers.current.forEach(clearTimeout); timers.current = []; animationEpoch.current += 1;
    locked.current = false; setBusy(undefined); setDiceOverlay(undefined); setPieceMotion(undefined);
  }
  function cancelQuestionImport() {
    importGeneration.current += 1;
    setImportReading(false); setImportPreview(undefined); setImportError('');
  }
  async function readQuestionFile(file: File | undefined) {
    if (!mounted.current || !pageActive.current || current.current !== state || state.phase !== 'questions' || state.questions.length >= 100 || currentDraft.current || locked.current) return;
    cancelQuestionImport();
    if (!file) return;
    const expected = state, generation = importGeneration.current;
    const live = () => mounted.current && importGeneration.current === generation && current.current === expected;
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'txt' && extension !== 'json') { setImportError('Choose a .txt or .json question file.'); return; }
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > QUEST_IMPORT_MAX_BYTES) { setImportError('Choose a nonempty file no larger than 256 KB.'); return; }
    setImportReading(true); setNotice('');
    try {
      const bytes = await file.arrayBuffer();
      if (!live()) return;
      const preview = parseQuestQuestionImport(new Uint8Array(bytes), extension as QuestImportFormat);
      if (live()) setImportPreview({ ...preview, base: expected, generation });
    } catch (value) {
      if (live()) setImportError(problem(value));
    } finally {
      if (live()) setImportReading(false);
    }
  }
  function importQuestions() {
    const preview = importPreview;
    if (!mounted.current || !pageActive.current || currentDraft.current || locked.current || !preview || importReading || preview.generation !== importGeneration.current || current.current !== preview.base) return;
    if (preview.questions.length + current.current.questions.length > 100) { setImportError('This file would exceed the limit of 100 questions. Remove questions from the file or the bank first.'); return; }
    const next = apply(value => appendQuestQuestions(value, preview.questions, () => crypto.randomUUID()), preview.base);
    if (next) { const count = preview.questions.length; commitQuestionSources(next, sourcesForBatch(preview.questions, preview.sources)); cancelQuestionImport(); setNotice(`${count} ${count === 1 ? 'question imported' : 'questions imported'}. Existing questions were kept.`); }
  }
  function useGracieQuestions() {
    if (!mounted.current || !pageActive.current || current.current !== state || state.phase !== 'questions' || currentDraft.current || storageBlocked || locked.current) return;
    cancelQuestionImport();
    try {
      const additions = getGracieQuestionAdditions(state.questions);
      if (!additions.questions.length) { setNotice("Gracie’s questions are already in this bank."); setError(''); return; }
      if (state.questions.length + additions.questions.length > 100) { setError(`Gracie’s questions need ${additions.questions.length} free slots. This bank has room for ${100 - state.questions.length}. No questions were added.`); return; }
      const next = apply(value => appendQuestQuestions(value, additions.questions, () => crypto.randomUUID()));
      if (next) { commitQuestionSources(next, sourcesForBatch(additions.questions, additions.sources)); setNotice(`${additions.questions.length} of Gracie’s questions added.${additions.skipped ? ` ${additions.skipped} already in this bank were skipped.` : ''} Existing questions were kept.`); }
    } catch (value) { setError(problem(value)); }
  }
  function leaveGame() { pageActive.current = false; cancelQuestionImport(); void navigate('/party'); }
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
  function animate(kind: 'card' | 'picker', duration: number, callback: () => void) {
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
    catch { setSaveIssue('This browser can’t save changes right now. Keep this tab open to continue playing.'); }
  }, [state, storageBlocked]);
  useEffect(() => {
    if (busy === 'dice' || busy === 'moving') return;
    if (previousFinishCount.current === 0 && state.finishOrder.length > 0) setCelebrate(state.finishOrder[0]);
    previousFinishCount.current = state.finishOrder.length;
  }, [state.finishOrder, busy]);
  useEffect(() => {
    mounted.current = true;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReducedMotion(media.matches);
    const change = () => setFullscreen(document.fullscreenElement === root.current);
    motion(); media.addEventListener('change', motion); document.addEventListener('fullscreenchange', change);
    return () => { mounted.current = false; importGeneration.current += 1; timers.current.forEach(clearTimeout); media.removeEventListener('change', motion); document.removeEventListener('fullscreenchange', change); };
  }, []);
  useEffect(() => { cancelQuestionImport(); }, [state]);
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
  useEffect(() => {
    if (!diceOverlay) return;
    diceModal.current?.focus();
    return () => document.getElementById('quest-current-team')?.focus();
  }, [Boolean(diceOverlay)]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen();
      else setNotice('Full screen is unavailable in this browser. You can still play on this page.');
    } catch { setNotice('Full screen could not open. You can keep playing on this page.'); }
  }
  function resetEditor() { cancelQuestionImport(); setQuestion(''); setChoices(blankChoices()); setCorrectIndex(0); setChoiceCount(4); setEditing(undefined); setSourceUrl(''); setSourceCitation(''); setSourceExplanation(''); }
  function saveQuestion(event: FormEvent) {
    event.preventDefault();
    if (!mounted.current || !pageActive.current || current.current !== state || state.phase !== 'questions' || locked.current || currentDraftSignature.current !== draftSignature) return;
    let source: QuestQuestionSource | undefined;
    try { if (sourceUrl.trim() || sourceCitation.trim() || sourceExplanation.trim()) source = parseQuestQuestionSource({ url: sourceUrl, citation: sourceCitation, ...(sourceExplanation.trim() ? { explanation: sourceExplanation } : {}) }); }
    catch (value) { setError(problem(value)); return; }
    const id = editing ?? crypto.randomUUID();
    const next = apply(value => upsertQuestQuestion(value, { id, prompt: question, choices: choices.slice(0, choiceCount), correctIndex }));
    if (next) { const saved = next.questions.find(card => card.id === id)!; const values = { ...sourceCurrent.current }, key = questionSourceKey(saved); if (source) values[key] = source; else delete values[key]; commitQuestionSources(next, values); resetEditor(); setNotice(editing ? 'Question updated.' : 'Question added.'); }
  }
  function editQuestion(value: QuestQuestion) { if (!mounted.current || !pageActive.current || current.current !== state || state.phase !== 'questions' || locked.current) return; cancelQuestionImport(); setEditing(value.id); setQuestion(value.prompt); setChoices([...value.choices, ...blankChoices()].slice(0, 4)); setChoiceCount(value.choices.length); setCorrectIndex(value.correctIndex); const source = sourceForQuestion(value); setSourceUrl(source?.url ?? ''); setSourceCitation(source?.citation ?? ''); setSourceExplanation(source?.explanation ?? ''); setError(''); document.getElementById('quest-question-prompt')?.focus(); }
  function draw() {
    if (locked.current) return;
    const rect = deck.current?.getBoundingClientRect();
    if (rect) setFlight({ x: rect.left + rect.width / 2 - window.innerWidth / 2, y: rect.top + rect.height / 2 - window.innerHeight / 2 });
    const next = apply(value => drawQuestCard(value, random));
    if (next) { setCardOpen(true); animate('card', 700, () => {}); }
  }
  function roll() {
    if (locked.current) return;
    const before = current.current;
    const next = apply(value => rollQuestDie(value, random));
    if (!next) return;
    const faces = next.turn.dice!;
    const teamIndex = before.currentTeamIndex!;
    const from = before.teams[teamIndex].position, to = next.teams[teamIndex].position;
    const motion: PieceMotion = { teamId: before.teams[teamIndex].id, position: from,
      phase: before.phase, currentTeamIndex: teamIndex, finishOrder: before.finishOrder };
    const epoch = ++animationEpoch.current;
    locked.current = true; setBusy('dice'); setCardOpen(false); setPieceMotion(motion);
    setDiceOverlay({ faces: reducedMotion ? faces : [1, 4], settled: reducedMotion, cadence: 50 });
    // The result is already saved. All frames below are cosmetic, fenced to
    // that exact accepted turn, and consume no additional random samples.
    const schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        if (mounted.current && animationEpoch.current === epoch && current.current === next) callback();
      }, delay);
      timers.current.push(timer);
    };
    if (!reducedMotion) {
      DICE_FRAME_TIMES.forEach((at, index) => schedule(() => setDiceOverlay({
        faces: [(index * 5 + 2) % 6 + 1, (index * 5 + 4) % 6 + 1], settled: false,
        cadence: at - (DICE_FRAME_TIMES[index - 1] ?? 0),
      }), at));
      schedule(() => setDiceOverlay({ faces, settled: true, cadence: 350 }), DICE_SETTLE_AT);
    }
    const closeAt = reducedMotion ? 160 : DICE_CLOSE_AT;
    schedule(() => { setDiceOverlay(undefined); setBusy('moving'); }, closeAt);
    const distance = to - from;
    if (!reducedMotion) {
      for (let step = 1; step <= distance; step++) schedule(() => setPieceMotion({ ...motion, position: from + step }), closeAt + step * PIECE_STEP_MS);
    }
    schedule(() => {
      setPieceMotion(undefined); locked.current = false; setBusy(undefined);
      document.getElementById('quest-current-team')?.focus();
    }, closeAt + (reducedMotion ? 0 : (distance + 1) * PIECE_STEP_MS));
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
    cancelQuestionImport(); cancelAnimations(); setRecoveryOpen(false);
    try {
      const previous = window.localStorage.getItem(QUESTION_QUEST_STORAGE_KEY);
      if (previous) window.localStorage.setItem(`${QUESTION_QUEST_STORAGE_KEY}:previous`, previous);
      const previousSources = window.localStorage.getItem(QUEST_QUESTION_SOURCES_STORAGE_KEY);
      if (previousSources) window.localStorage.setItem(`${QUEST_QUESTION_SOURCES_STORAGE_KEY}:previous`, previousSources);
      setStorageBlocked(false);
    } catch { setStorageBlocked(true); setSaveIssue('The new game can run in this tab, but this browser cannot save it. The previous saved data is unchanged.'); }
    const next = fresh(); current.current = next; setState(next); sourceCurrent.current = {}; setQuestionSources({}); sourceBackupNeeded.current = false; setSourceSaveIssue(''); previousFinishCount.current = 0; setCelebrate(undefined); setCardOpen(false); setConfirm(undefined); setNotice(''); setError(''); resetEditor();
    setTeamDrafts(next.teams.map(team => ({ id: team.id, name: team.name, avatar: team.avatar })));
  }
  function recover() {
    if (current.current !== state) return;
    cancelQuestionImport(); cancelAnimations();
    const next = boot();
    if (next.blocked) { setNotice(next.message); return; }
    const restoredSources = bootSources(next.state); sourceBackupNeeded.current = restoredSources.status === 'invalid' || restoredSources.status === 'unavailable'; sourceCurrent.current = restoredSources.sources; setQuestionSources(restoredSources.sources); setSourceSaveIssue(restoredSources.status === 'invalid' || restoredSources.status === 'unavailable' ? 'Saved citations could not be opened. Your questions and game progress are unchanged.' : '');
    current.current = next.state; setState(next.state); setStorageBlocked(false); setRecoveryOpen(false); setNotice('Saved game restored.'); setError('');
    previousFinishCount.current = next.state.finishOrder.length;
    setTeamDrafts(next.state.teams.map(team => ({ id: team.id, name: team.name, avatar: team.avatar })));
    setCardOpen(next.state.phase === 'playing' && next.state.turn.stage !== 'draw');
  }
  const unsavedQuestion = Boolean(editing || question.trim() || choices.some(value => value.trim()) || sourceUrl.trim() || sourceCitation.trim() || sourceExplanation.trim());
  const draftSignature = JSON.stringify([question, choices, choiceCount, correctIndex, editing, sourceUrl, sourceCitation, sourceExplanation]);
  currentDraft.current = unsavedQuestion; currentDraftSignature.current = draftSignature;
  const answeredQuestion = view.question && state.turn.selectedIndex !== null && (state.turn.stage === 'roll' || state.turn.stage === 'complete') ? state.questions.find(card => card.id === view.question!.id) : undefined;
  const answerSource = answeredQuestion ? sourceForQuestion(answeredQuestion) : undefined;
  const champion = state.teams.find(team => team.id === celebrate);
  const first = state.firstTeamIndex === null ? undefined : state.teams[state.firstTeamIndex];

  return <main id="main" aria-label="10th Grade Health: Drugs & Decision-Making" ref={root} className={`quest-page health-class-game ${fullscreen ? 'quest-fullscreen' : ''}`}>
    <header className="quest-header"><div className="quest-brand"><img className="quest-school-logo" src={SCHOOL_LOGO} alt="School logo" width={512} height={375}/><div><span>10TH GRADE HEALTH · DRUG EDUCATION</span><h1>Drugs &amp; Decision-Making</h1></div></div><nav className="quest-header-actions" aria-label="Game controls"><button onClick={leaveGame} className="quest-button quest-button-quiet">← Party games</button><button onClick={() => void toggleFullscreen()} className="quest-button quest-button-outline">{fullscreen ? '↙ Exit full screen' : '↗ Full screen'}</button></nav></header>
    <div className="quest-subbar"><span className="quest-local-note"><i aria-hidden="true"/> Drug-unit review. Four teams. Custom questions.</span><details className="quest-help"><summary>How to play <span aria-hidden="true">?</span></summary><div><strong>Rules</strong><ol><li>Before play, the host adds drug-unit review questions and selects each correct answer.</li><li>Set up four teams with names and icons. Choose the first team at random.</li><li>On each turn, draw a question card. The host selects the team’s answer.</li><li>A correct answer earns one point and a roll of two dice. Move the sum of both dice, stopping at the finish. An incorrect answer earns no point or movement.</li><li>The first team to reach the finish wins. Continue in team order, skipping finished teams, until all four teams finish.</li></ol><p>Every question is used before the cards are reshuffled. Progress is saved in this browser.</p></div></details></div>

    {recoveryOpen ? <section className="quest-recovery quest-panel"><span className="quest-eyebrow">SAVED GAME</span><h2>Saved game unavailable</h2><p>{notice}</p><div className="quest-actions"><button className="quest-button quest-button-primary" onClick={recover}>Try again</button><button className="quest-button quest-button-outline-dark" onClick={() => setConfirm('recover')}>New game</button></div></section> : <>
      {state.phase === 'questions' && <section className="quest-setup"><div className="quest-setup-heading"><div><span className="quest-eyebrow">01 / QUESTIONS</span><h2>Create the question bank</h2><p>Use Gracie’s prepared questions, upload a completed question file, or enter questions one at a time below. Questions and answer keys are hidden after setup.</p></div></div><section className="quest-panel quest-preset-panel" aria-labelledby="quest-gracie-heading"><div><span className="quest-eyebrow">PREPARED QUESTION BANK</span><h3 id="quest-gracie-heading">Gracie’s Questions</h3><p>Load {GRACIE_QUESTION_PRESET.questions.length} reviewed questions with correct answers, explanations and information sources. Existing questions stay in your bank; exact copies are skipped.</p></div><div className="quest-preset-action"><button type="button" className="quest-button quest-button-primary" disabled={unsavedQuestion || storageBlocked || Boolean(busy)} onClick={useGracieQuestions}>Use Gracie's Questions</button>{unsavedQuestion && <p>Save or clear the manual question before loading the prepared bank.</p>}</div></section><section className="quest-panel quest-import-panel" aria-labelledby="quest-import-heading"><div className="quest-import-intro"><span className="quest-eyebrow">UPLOAD QUESTIONS</span><h3 id="quest-import-heading">Start with a question file</h3><p>Download a template, add your drug-unit questions and correct answers, then choose the file to review it. Importing adds to your existing bank.</p><div className="quest-template-links"><a href="/templates/quiz-circuit-questions.txt" download="10th-grade-health-drug-education-questions.txt">Download text template ↓</a><a href="/templates/quiz-circuit-questions.json" download="10th-grade-health-drug-education-questions.json">JSON template ↓</a></div></div><div className="quest-import-picker"><label htmlFor="quest-question-file">Choose a question file<input id="quest-question-file" type="file" accept=".txt,.json,text/plain,application/json" disabled={unsavedQuestion || state.questions.length >= 100} aria-describedby="quest-import-help" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readQuestionFile(file); }}/></label><p id="quest-import-help">{unsavedQuestion ? 'Add or save the manual question, or use Clear draft / Cancel edit, before importing.' : `${state.questions.length} / 100 questions. Files stay in this browser. Maximum file size: 256 KB.`}</p>{state.questions.length >= 100 && <p>The bank is full. Remove a question before importing more.</p>}{importReading && <div className="quest-import-status" role="status"><span>Reading question file…</span><button type="button" className="quest-button quest-button-text" onClick={cancelQuestionImport}>Cancel import</button></div>}{importError && <p className="quest-import-error" role="alert">{importError}</p>}</div>{importPreview && <div className="quest-import-review"><div className="quest-import-review-heading"><div><h4>Review {importPreview.questions.length} {importPreview.questions.length === 1 ? 'question' : 'questions'}</h4><p>Correct answers are marked below. Nothing has been added yet. Editing a manual question cancels this preview.</p></div><strong>{state.questions.length} existing + {importPreview.questions.length} new</strong></div><ol className="quest-import-list" tabIndex={0} aria-label="Imported questions and correct answers">{importPreview.questions.map((item, index) => <li key={index}><h5>{index + 1}. {item.prompt}</h5><ol type="A">{item.choices.map((choice, choiceIndex) => <li key={choiceIndex} className={item.correctIndex === choiceIndex ? 'is-correct-answer' : ''}>{choice}{item.correctIndex === choiceIndex && <strong> — Correct answer</strong>}</li>)}</ol>{importPreview.sources?.[index] && <div className="quest-import-source"><p>{importPreview.sources[index]!.explanation}</p><p>{importPreview.sources[index]!.citation}</p><a href={importPreview.sources[index]!.url} target="_blank" rel="noopener noreferrer">Read source ↗</a></div>}</li>)}</ol>{state.questions.length + importPreview.questions.length > 100 && <p className="quest-import-error" role="alert">This file would bring the bank to {state.questions.length + importPreview.questions.length} questions. The limit is 100. Choose a smaller file or cancel and remove existing questions.</p>}<div className="quest-actions"><button type="button" className="quest-button quest-button-primary" disabled={unsavedQuestion || state.questions.length + importPreview.questions.length > 100} onClick={importQuestions}>Import {importPreview.questions.length} {importPreview.questions.length === 1 ? 'question' : 'questions'}</button><button type="button" className="quest-button quest-button-outline-dark" onClick={cancelQuestionImport}>Cancel import</button></div></div>}</section><div className="quest-question-grid"><form className="quest-panel quest-question-editor" onChangeCapture={cancelQuestionImport} onSubmit={saveQuestion}><div className="quest-panel-heading"><h3>{editing ? 'Edit your question' : `Question ${state.questions.length + 1}`}</h3><span>HOST SETUP</span></div><label htmlFor="quest-question-prompt">Your question<textarea id="quest-question-prompt" value={question} onChange={event => setQuestion(event.target.value)} required maxLength={300} rows={3} placeholder="What will you ask your teams?"/></label><div className="quest-choice-heading"><strong>Answer choices</strong><label>Choices<select aria-label="Number of answer choices" value={choiceCount} onChange={event => { const count = Number(event.target.value); setChoiceCount(count); if (correctIndex >= count) setCorrectIndex(0); }}>{[2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}</select></label></div><fieldset className="quest-answer-editor"><legend>Choose the correct answer</legend>{choices.slice(0, choiceCount).map((choice, index) => <div key={index} className={correctIndex === index ? 'is-correct-choice' : ''}><label className="quest-correct-picker"><input type="radio" name="quest-correct" checked={correctIndex === index} onChange={() => setCorrectIndex(index)} aria-label={`Choice ${LETTERS[index]} is correct`}/><span>{LETTERS[index]}</span></label><label className="quest-answer-field"><span className="quest-sr-only">Answer {LETTERS[index]}</span><input value={choice} onChange={event => setChoices(values => values.map((value, at) => at === index ? event.target.value : value))} required maxLength={120} placeholder={`Answer ${LETTERS[index]}`}/></label><span className="quest-correct-tag">{correctIndex === index ? '✓ Correct' : ''}</span></div>)}</fieldset><fieldset className="quest-source-editor"><legend>Information source <span>(optional)</span></legend><p>Add an original government, public-health or professional source. Its citation and explanation appear after an answer is selected. Review these fields when editing a question or answer.</p><label htmlFor="quest-source-url">Official information source URL<input id="quest-source-url" type="url" value={sourceUrl} maxLength={2048} placeholder="https://www.cdc.gov/…" onChange={event => setSourceUrl(event.target.value)}/></label><label htmlFor="quest-source-citation">APA citation<textarea id="quest-source-citation" value={sourceCitation} maxLength={1000} rows={3} placeholder="Organization. (Year). Title. URL" onChange={event => setSourceCitation(event.target.value)}/></label><label htmlFor="quest-source-explanation">Answer explanation<textarea id="quest-source-explanation" value={sourceExplanation} maxLength={1000} rows={3} onChange={event => setSourceExplanation(event.target.value)}/></label></fieldset><div className="quest-actions"><button className="quest-button quest-button-primary">{editing ? 'Save changes' : '+ Add question'}</button>{unsavedQuestion && <button type="button" className="quest-button quest-button-text" onClick={resetEditor}>{editing ? 'Cancel edit' : 'Clear draft'}</button>}</div></form><aside className="quest-panel quest-bank"><div className="quest-panel-heading"><h3>Question bank</h3><span>{state.questions.length} {state.questions.length === 1 ? 'CARD' : 'CARDS'}</span></div>{state.questions.length ? <ol>{state.questions.map((item, index) => <li key={item.id}><span className="quest-bank-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.prompt}</strong><div className="quest-bank-controls"><button type="button" onClick={() => editQuestion(item)}>Edit</button>{remove === item.id ? <><button type="button" onClick={() => { const next = apply(value => removeQuestQuestion(value, item.id)); if (next) commitQuestionSources(next, sourceCurrent.current); setRemove(undefined); if (editing === item.id) resetEditor(); }}>Confirm remove</button><button type="button" onClick={() => setRemove(undefined)}>Keep</button></> : <button type="button" onClick={() => setRemove(item.id)}>Remove</button>}</div></div></li>)}</ol> : <div className="quest-empty-stack"><h4>No questions yet.</h4><p>Add at least one question to continue.</p></div>}<div className="quest-bank-footer"><p>{unsavedQuestion ? 'Add or clear the question in the editor before continuing.' : importReading || importPreview ? 'Import or cancel the selected file before continuing.' : 'Questions and answer keys will be hidden during team setup.'}</p><button className="quest-button quest-button-primary" disabled={!state.questions.length || unsavedQuestion || importReading || Boolean(importPreview)} onClick={() => { const next = apply(finishQuestQuestions); if (next) { resetEditor(); setNotice(''); } }}>Set up teams <span aria-hidden="true">→</span></button></div></aside></div></section>}

      {state.phase === 'teams' && <section className="quest-team-setup"><div className="quest-center-heading"><span className="quest-eyebrow">02 / TEAMS</span><h2>Set up four teams</h2><p>Enter a name and choose a piece for each team.</p></div><form onSubmit={startTeams}><div className="quest-team-drafts">{teamDrafts.map((team, index) => <section key={team.id} className="quest-team-draft" style={{ '--team-color': COLORS[index] } as CSSProperties}><span className="quest-eyebrow">TEAM {index + 1} · {COLOR_NAMES[index]}</span><span className="quest-selected-avatar" aria-hidden="true"><img src={avatar(team.avatar).image} alt="" draggable={false}/></span><strong className="quest-selected-piece-name">{avatar(team.avatar).label}</strong><label htmlFor={`quest-team-${index}`}>Team name<input id={`quest-team-${index}`} value={team.name} onChange={event => setTeamDrafts(values => values.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} maxLength={32} required autoComplete="off"/></label><fieldset><legend>Choose your piece</legend><div>{QUESTION_QUEST_AVATARS.map(icon => <button key={icon.id} type="button" aria-label={`${icon.label} for team ${index + 1}`} aria-pressed={team.avatar === icon.id} className={`quest-avatar-option ${team.avatar === icon.id ? 'is-selected' : ''}`} title={icon.label} onClick={() => setTeamDrafts(values => values.map((value, at) => at === index ? { ...value, avatar: icon.id } : value))}><img src={icon.image} alt="" aria-hidden="true" draggable={false}/></button>)}</div></fieldset></section>)}</div><button className="quest-button quest-button-primary quest-button-large" type="submit">Continue <span aria-hidden="true">→</span></button></form></section>}

      {state.phase === 'first-team-picker' && <section className="quest-first-picker"><div className="quest-center-heading"><span className="quest-eyebrow">03 / FIRST TEAM</span><h2>{first && !busy ? `${first.name} starts.` : 'Choose the first team'}</h2><p>{first && !busy ? 'Turns follow team order, skipping teams that have finished.' : 'The first team is selected at random. Turns then follow team order.'}</p></div><div className={`quest-picker-teams ${busy === 'picker' ? 'is-picking' : ''}`}>{state.teams.map((team, index) => <div key={team.id} className={(busy === 'picker' ? picker === index : state.firstTeamIndex === index) ? 'is-picked' : ''} style={{ '--team-color': COLORS[index], '--pick-index': index } as CSSProperties}><span className="quest-picker-piece" aria-hidden="true"><img src={avatar(team.avatar).image} alt="" draggable={false}/></span><strong>{team.name}</strong><small>{state.firstTeamIndex === index && !busy ? 'FIRST TO PLAY' : COLOR_NAMES[index] + ' TEAM'}</small></div>)}</div><div className="quest-center-actions">{first && !busy ? <button className="quest-button quest-button-primary quest-button-large" onClick={() => { const next = apply(startQuestionQuest); if (next) { setCardOpen(false); setNotice(''); } }}>Start game <span aria-hidden="true">→</span></button> : <button className="quest-button quest-button-primary quest-button-large" disabled={Boolean(busy)} onClick={pickFirst}>{busy ? 'Choosing first team…' : 'Choose first team'}</button>}</div></section>}

      {(display.phase === 'playing' || display.phase === 'results') && <section className="quest-game-layout"><div className="quest-board-wrap"><div className="quest-board"><svg viewBox="0 0 800 800" className="quest-board-art" role="img" aria-label={`10th Grade Health: Drugs & Decision-Making board. ${QUEST_BOARD_LENGTH} spaces to finish. ${display.teams.map(team => `${team.name}: ${display.finishOrder.includes(team.id) ? 'finished' : `${team.position} spaces`}`).join('. ')}`}><defs><pattern id="quest-board-grain" width="13" height="13" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".65" fill="#b5a688" opacity=".22"/></pattern><filter id="quest-token-shadow" x="-60%" y="-60%" width="220%" height="230%"><feDropShadow dx="0" dy="6" stdDeviation="5" floodColor="#1a2636" floodOpacity=".2"/></filter></defs><rect x="14" y="14" width="772" height="772" rx="36" fill="#f5eddd"/><rect x="14" y="14" width="772" height="772" rx="36" fill="url(#quest-board-grain)"/><rect x="44" y="44" width="712" height="712" rx="24" fill="none" stroke="#d9cdb6" strokeWidth="2"/><rect x="137" y="137" width="526" height="526" rx="30" fill="none" stroke="#ddd2bf" strokeDasharray="3 9"/>{TRACK.map(([x, y], index) => { const color = COLORS[Math.floor(index / 7)]; return <g key={index}><rect x={x - 34} y={y - 34} width="68" height="68" rx="15" fill="#fffaf0" stroke={color} strokeOpacity=".4" strokeWidth="2"/><circle cx={x} cy={y} r={index % 7 === 0 ? 9 : 3} fill={color} opacity={index % 7 === 0 ? .6 : .32}/>{index % 7 === 0 && <path d={`M ${x - 4} ${y - 3} l 8 3 -8 3 Z`} fill="#fffaf0"/>}</g>; })}{display.teams.map((team, index) => <g key={team.id}><rect x={HOMES[index][0] - 57} y={HOMES[index][1] - 51} width="114" height="102" rx="24" fill={COLORS[index]} opacity=".12"/><text x={HOMES[index][0]} y={HOMES[index][1] + 34} textAnchor="middle" fill={COLORS[index]} fontSize="12" fontWeight="800" letterSpacing="2">START</text><circle cx={FINISHES[index][0]} cy={FINISHES[index][1]} r="31" fill={COLORS[index]} opacity=".13"/><circle cx={FINISHES[index][0]} cy={FINISHES[index][1]} r="24" fill="none" stroke={COLORS[index]} strokeDasharray="3 5"/><text x={FINISHES[index][0]} y={FINISHES[index][1] + 49} textAnchor="middle" fill={COLORS[index]} fontSize="11" fontWeight="800" letterSpacing="2">FINISH</text></g>)}<image href={SCHOOL_LOGO} x="339" y="157" width="122" height="89" preserveAspectRatio="xMidYMid meet" aria-hidden="true"/><text x="400" y="264" textAnchor="middle" className="quest-board-wordmark">DRUGS &amp;</text><text x="400" y="293" textAnchor="middle" className="quest-board-wordmark quest-board-wordmark-big">DECISIONS</text>{display.teams.map((team, index) => { const location = team.position <= 0 ? HOMES[index] : team.position >= QUEST_BOARD_LENGTH ? FINISHES[index] : TRACK[(index * 7 + team.position - 1) % TRACK.length]; const occupants = display.teams.filter(other => other.position > 0 && other.position < QUEST_BOARD_LENGTH && ((display.teams.indexOf(other) * 7 + other.position - 1) % TRACK.length) === ((index * 7 + team.position - 1) % TRACK.length)); const rank = occupants.findIndex(other => other.id === team.id); const dx = team.position > 0 && team.position < QUEST_BOARD_LENGTH && occupants.length > 1 ? (rank - (occupants.length - 1) / 2) * 21 : 0; return <g key={team.id} data-team-id={team.id} data-position={team.position} className={`quest-token ${activeIndex === index && display.phase === 'playing' ? 'is-current' : ''}`} style={{ transform: `translate(${location[0] + dx}px,${location[1]}px)`, '--team-color': COLORS[index] } as CSSProperties}><circle r="29" fill={COLORS[index]} stroke="#fffdf7" strokeWidth="5" filter="url(#quest-token-shadow)"/><image href={avatar(team.avatar).image} x="-26" y="-26" width="52" height="52" preserveAspectRatio="xMidYMid meet" aria-hidden="true"/>{display.finishOrder.includes(team.id) && <circle cx="22" cy="-22" r="11" fill="#fffaf0" stroke={COLORS[index]} strokeWidth="2"/>}{display.finishOrder.includes(team.id) && <text x="22" y="-18" textAnchor="middle" fontSize="12" fill={COLORS[index]} fontWeight="800">{display.finishOrder.indexOf(team.id) + 1}</text>}</g>; })}</svg><div className="quest-board-center">{display.phase === 'results' ? <div className="quest-center-finished"><strong>All teams finished.</strong><small>Final standings</small></div> : <button ref={deck} className={`quest-card-stack ${busy === 'card' ? 'is-dealing' : ''}`} onClick={() => display.turn.stage === 'draw' ? draw() : setCardOpen(true)} disabled={Boolean(busy)} aria-label={display.turn.stage === 'draw' ? `Draw a question card for ${active?.name}` : 'Open the current question card'}><span className="quest-stack-back"/><span className="quest-stack-mid"/><span className="quest-stack-front"><small>10TH GRADE HEALTH</small><img src={SCHOOL_LOGO} alt="" aria-hidden="true"/><small>DRUG EDUCATION</small></span><span className="quest-stack-prompt">{display.turn.stage === 'draw' ? 'Draw a card' : 'Open your card'} <span aria-hidden="true">↗</span></span></button>}</div></div><div className="quest-board-caption"><span><i aria-hidden="true"/> {QUEST_BOARD_LENGTH} spaces to finish</span><span>Correct answer → +1 point → roll & move</span></div></div><aside className="quest-game-sidebar"><div className="quest-turn-panel" style={{ '--team-color': activeColor } as CSSProperties}><span className="quest-eyebrow">{display.phase === 'results' ? 'GAME COMPLETE' : `TURN ${display.turnNumber} · YOUR MOVE`}</span><h2 id="quest-current-team" tabIndex={-1}>{display.phase === 'results' ? 'Results' : active?.name}</h2>{display.phase === 'results' ? <p>All four teams have finished. Results are listed by finish order.</p> : <><p>{busy === 'dice' ? 'Rolling two dice.' : busy === 'moving' ? `Moving: space ${active?.position} of ${QUEST_BOARD_LENGTH}.` : display.turn.stage === 'draw' ? 'Draw a question to begin this turn.' : display.turn.stage === 'answer' ? 'Select the team’s answer.' : display.turn.stage === 'roll' ? 'Correct answer: +1 point. Roll two dice.' : display.turn.correct ? `Rolled ${display.turn.roll}.` : 'No points or movement. Continue to the next team.'}</p><div className="quest-dice-summary" aria-label={busy === 'dice' ? 'Rolling two dice' : display.turn.dice ? `Dice ${display.turn.dice[0]} and ${display.turn.dice[1]}, total ${display.turn.roll}` : display.turn.roll ? `Previous roll ${display.turn.roll}` : 'Two six-sided dice'}><div aria-hidden="true">{busy === 'dice' ? <><span>?</span><span>?</span></> : display.turn.dice ? display.turn.dice.map((face, index) => <span key={index}>{FACES[face - 1]}</span>) : display.turn.roll ? <span>{FACES[display.turn.roll - 1]}</span> : <><span>{FACES[0]}</span><span>{FACES[0]}</span></>}</div><small>{busy === 'dice' ? 'ROLLING…' : busy === 'moving' ? 'MOVING…' : display.turn.roll ? `${display.turn.roll} SPACES` : 'TWO DICE'}</small></div>{display.turn.stage === 'draw' ? <button className="quest-button quest-button-primary" disabled={Boolean(busy)} onClick={draw}>Draw a question <span aria-hidden="true">↗</span></button> : display.turn.stage === 'roll' ? <button className="quest-button quest-button-primary" disabled={Boolean(busy)} onClick={roll}>Roll two dice →</button> : display.turn.stage === 'complete' ? <button className="quest-button quest-button-primary" disabled={Boolean(busy)} onClick={nextTeam}>Next team <span aria-hidden="true">→</span></button> : <button className="quest-button quest-button-primary" onClick={() => setCardOpen(true)}>Show question <span aria-hidden="true">↗</span></button>}</>}</div><section className="quest-standings" aria-label="Teams, scores and positions"><div className="quest-standings-heading"><h3>Teams</h3><span>POINTS</span></div>{display.teams.map((team, index) => <div key={team.id} className={`quest-team-status ${index === activeIndex && display.phase === 'playing' ? 'is-current' : ''} ${display.finishOrder.includes(team.id) ? 'is-home' : ''}`} style={{ '--team-color': COLORS[index] } as CSSProperties}><span className="quest-team-icon" aria-hidden="true" title={avatar(team.avatar).label}><img src={avatar(team.avatar).image} alt="" draggable={false}/></span><div><strong>{team.name}</strong><span>{display.finishOrder.includes(team.id) ? `${ordinal(display.finishOrder.indexOf(team.id) + 1)} · finished` : `Space ${team.position} / ${QUEST_BOARD_LENGTH}`}</span><i className="quest-progress-track"><i style={{ width: `${team.position / QUEST_BOARD_LENGTH * 100}%` }}/></i></div><b>{team.points}<small>{team.points === 1 ? 'PT' : 'PTS'}</small></b></div>)}</section>{display.finishOrder.length > 0 && <section className="quest-finish-order"><h3>Finish order</h3><ol>{display.finishOrder.map((id, index) => { const team = display.teams.find(value => value.id === id)!; return <li key={id}><b>{ordinal(index + 1)}</b><span className="quest-finisher-team"><img src={avatar(team.avatar).image} alt="" aria-hidden="true" draggable={false}/>{team.name}</span><small>{team.points} pts</small></li>; })}</ol></section>}{display.phase === 'results' && <button className="quest-button quest-button-primary" onClick={() => { const next = apply(rematchQuestionQuest); if (next) { setCardOpen(false); setCelebrate(undefined); previousFinishCount.current = 0; } }}>Rematch →</button>}</aside></section>}
    </>}

    {(error || notice || saveIssue || sourceSaveIssue) && <div className="quest-feedback" aria-live="polite">{error && <p role="alert">{error}</p>}{!storageBlocked && notice && <p>{notice}</p>}{saveIssue && <p role="status">{saveIssue}</p>}{sourceSaveIssue && <p role="status">{sourceSaveIssue}</p>}</div>}
    <footer className="quest-footer"><span>{saveIssue || storageBlocked ? 'Keep this tab open to retain your current progress.' : 'Saved privately in this browser.'}</span><button className="quest-button quest-button-quiet" disabled={Boolean(busy)} onClick={() => setConfirm('new')}>New game</button></footer>

    {cardOpen && view.question && !celebrate && <div className={`quest-modal-backdrop ${busy === 'card' ? 'is-dealing' : ''}`}><div ref={modal} className="quest-question-card" role="dialog" aria-modal="true" aria-labelledby="quest-card-heading" tabIndex={-1} style={{ '--quest-flight-x': `${flight.x}px`, '--quest-flight-y': `${flight.y}px`, '--team-color': activeColor } as CSSProperties} onKeyDown={event => { trapFocus(event); if (event.key === 'Escape' && !busy) { event.stopPropagation(); setCardOpen(false); } }}><header><div className="quest-card-identity"><img src={SCHOOL_LOGO} alt="" aria-hidden="true"/><div><strong>10th Grade Health · Drug Education</strong><span className="quest-eyebrow">{active?.name} · QUESTION CARD</span></div></div><button className="quest-card-close" onClick={() => setCardOpen(false)} disabled={Boolean(busy)} aria-label="Minimize question and show board">×</button></header><div className="quest-question-content"><h2 id="quest-card-heading">{view.question.prompt}</h2><p>{state.turn.stage === 'answer' ? 'Host: select the team’s answer.' : state.turn.correct ? state.turn.stage === 'roll' ? 'Correct. +1 point. Roll two dice.' : 'Correct. +1 point.' : 'Incorrect. No points or movement.'}</p><div className="quest-answer-buttons">{view.question.choices.map((choice, index) => <button key={index} className={answeredQuestion && index === answeredQuestion.correctIndex ? 'is-right' : state.turn.selectedIndex === index ? 'is-wrong' : ''} disabled={state.turn.stage !== 'answer' || Boolean(busy)} onClick={() => apply(value => answerQuestCard(value, index))}><span>{LETTERS[index]}</span><strong>{choice}</strong>{state.turn.selectedIndex === index && <i aria-hidden="true">{state.turn.correct ? '✓' : '×'}</i>}</button>)}</div>{answeredQuestion && <section className="quest-answer-feedback" aria-label="Correct answer and information source" aria-live="polite"><strong>{`Correct answer: ${LETTERS[answeredQuestion.correctIndex]}. ${answeredQuestion.choices[answeredQuestion.correctIndex]}`}</strong>{answerSource ? <>{answerSource.explanation && <p>{answerSource.explanation}</p>}<a href={answerSource.url} target="_blank" rel="noopener noreferrer">Read source ↗</a><p className="quest-apa-citation">{answerSource.citation}</p></> : <p className="quest-missing-source">No information source was supplied for this question.</p>}</section>}{state.turn.stage === 'roll' && <div className="quest-card-outcome"><strong>+1 point</strong><button className="quest-button quest-button-primary quest-button-large" disabled={Boolean(busy)} onClick={roll}>Roll two dice →</button></div>}{state.turn.stage === 'complete' && <div className="quest-card-outcome"><strong>{state.turn.correct ? `Rolled ${state.turn.roll}.` : 'No points or movement.'}</strong><button className="quest-button quest-button-primary quest-button-large" disabled={Boolean(busy)} onClick={nextTeam}>Next team →</button></div>}</div></div></div>}

    {diceOverlay && <div className="quest-modal-backdrop quest-dice-backdrop"><section ref={diceModal} className={`quest-dice-stage ${diceOverlay.settled ? 'is-settled' : 'is-rolling'}`} role="dialog" aria-modal="true" aria-labelledby="quest-dice-heading" tabIndex={-1} onKeyDown={trapFocus} style={{ '--team-color': activeColor, '--dice-speed': `${diceOverlay.cadence}ms` } as CSSProperties}><div className="quest-overlay-identity"><img src={SCHOOL_LOGO} alt="" aria-hidden="true"/><span>10th Grade Health · Drug Education</span></div><span className="quest-eyebrow">{active?.name} · TWO DICE</span><h2 id="quest-dice-heading">{diceOverlay.settled ? 'The roll' : 'Rolling…'}</h2><div className="quest-large-dice" aria-hidden="true">{diceOverlay.faces.map((face, dieIndex) => <div className="quest-rolling-die" key={dieIndex} data-die-face={face}>{Array.from({ length: 9 }, (_, pip) => <i key={pip} className={PIPS[face].includes(pip) ? 'is-visible' : ''}/>)}</div>)}</div><p className="quest-dice-total" role="status" aria-live="polite">{diceOverlay.settled ? <><strong>{diceOverlay.faces[0]} + {diceOverlay.faces[1]} = {diceOverlay.faces[0] + diceOverlay.faces[1]}</strong><span>spaces</span></> : <span>Rolling two six-sided dice</span>}</p></section></div>}

    {champion && <div className="quest-modal-backdrop quest-celebration-backdrop"><div className="quest-celebration" onKeyDown={trapFocus} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="quest-celebration-title"><div className="quest-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--confetti-index': index, '--team-color': COLORS[index % 4] } as CSSProperties}/>)}</div><div className="quest-overlay-identity"><img src={SCHOOL_LOGO} alt="" aria-hidden="true"/><span>10th Grade Health · Drug Education</span></div><span className="quest-eyebrow">TEAM COMPETITION · WINNER</span><span className="quest-winner-icon" aria-hidden="true"><img src={avatar(champion.avatar).image} alt="" draggable={false}/></span><h2 id="quest-celebration-title">{champion.name} wins</h2><p>Play continues until all teams finish.</p><button autoFocus className="quest-button quest-button-primary quest-button-large" onClick={() => setCelebrate(undefined)}>Continue game →</button></div></div>}
    {confirm && <div className="quest-modal-backdrop"><section className="quest-confirm" onKeyDown={trapFocus} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="quest-confirm-title"><span className="quest-eyebrow">NEW GAME</span><h2 id="quest-confirm-title">Start a new game?</h2><p>Your current questions, teams and progress will be replaced in this browser. A previous copy is kept here when browser storage is available.</p><div className="quest-actions"><button className="quest-button quest-button-primary" onClick={newGame}>Start new game</button><button autoFocus className="quest-button quest-button-outline-dark" onClick={() => setConfirm(undefined)}>Cancel</button></div></section></div>}
  </main>;
}

export default QuestionQuest;
