export const QUEST_BOARD_LENGTH = 28;
export const QUESTION_QUEST_STORAGE_KEY = 'game-studio-question-quest-v1';
export const QUESTION_QUEST_AVATARS = [
  { id: 'fox', label: 'Fox', emoji: '🦊' }, { id: 'panda', label: 'Panda', emoji: '🐼' },
  { id: 'frog', label: 'Frog', emoji: '🐸' }, { id: 'owl', label: 'Owl', emoji: '🦉' },
  { id: 'dragon', label: 'Dragon', emoji: '🐲' }, { id: 'penguin', label: 'Penguin', emoji: '🐧' },
  { id: 'robot', label: 'Robot', emoji: '🤖' }, { id: 'unicorn', label: 'Unicorn', emoji: '🦄' },
] as const;
export type QuestAvatar = typeof QUESTION_QUEST_AVATARS[number]['id'];
export type QuestQuestion = { id: string; prompt: string; choices: string[]; correctIndex: number };
export type QuestTeamSetup = { id: string; name: string; avatar: QuestAvatar };
export type QuestTeam = QuestTeamSetup & { position: number; points: number };
export type QuestTurn = { stage: 'draw' | 'answer' | 'roll' | 'complete'; questionId: string | null; selectedIndex: number | null; correct: boolean | null; roll: number | null };
export type QuestState = {
  version: 1; id: string; phase: 'questions' | 'teams' | 'first-team-picker' | 'playing' | 'results';
  questions: QuestQuestion[]; teams: QuestTeam[]; firstTeamIndex: number | null; currentTeamIndex: number | null;
  deck: string[]; usedQuestionIds: string[]; turn: QuestTurn; finishOrder: string[]; turnNumber: number;
};
export type QuestPublicQuestion = Pick<QuestQuestion, 'id' | 'prompt' | 'choices'>;
export type QuestPublicState = Omit<QuestState, 'questions' | 'deck' | 'usedQuestionIds'> & { question: QuestPublicQuestion | null; winnerTeamId: string | null; boardLength: number };
export type QuestRandom = () => number;
const TEAM_IDS = ['team-1', 'team-2', 'team-3', 'team-4'];
const MAX_STORED_LENGTH = 256000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AVATARS = new Set<string>(QUESTION_QUEST_AVATARS.map(avatar => avatar.id));
const PHASES = ['questions', 'teams', 'first-team-picker', 'playing', 'results'];
const STAGES = ['draw', 'answer', 'roll', 'complete'];
export class QuestionQuestError extends Error { constructor(message: string) { super(message); this.name = 'QuestionQuestError'; } }
function fail(message = 'The saved game is invalid. Keep the saved copy and start a new game when ready.'): never { throw new QuestionQuestError(message); }
const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : fail();
function exact(value: Record<string, any>, keys: string[]) { if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail(); }
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
function identifier(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) fail('Use a valid stable game, team or question identifier.'); return value; }
function text(value: unknown, limit: number, description: string): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value)) fail(`${description} needs 1–${limit} printable characters.`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || [...normalized].length > limit || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized)) fail(`${description} needs 1–${limit} printable characters.`);
  return normalized;
}
function question(value: unknown, canonical = false): QuestQuestion {
  const q = object(value); exact(q, ['id', 'prompt', 'choices', 'correctIndex']);
  const prompt = text(q.prompt, 300, 'The question');
  if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 4 || !integer(q.correctIndex, 0, q.choices.length - 1)) fail('Add 2–4 choices and choose one correct answer.');
  const choices = q.choices.map((choice: unknown) => text(choice, 120, 'Each choice'));
  if (new Set(choices.map((choice: string) => choice.toLowerCase())).size !== choices.length) fail('Give every answer choice different text.');
  if (canonical && (prompt !== q.prompt || choices.some((choice: string, index: number) => choice !== q.choices[index]))) fail();
  return { id: identifier(q.id), prompt, choices, correctIndex: q.correctIndex };
}
const emptyTurn = (): QuestTurn => ({ stage: 'draw', questionId: null, selectedIndex: null, correct: null, roll: null });
const isEmptyTurn = (turn: Record<string, any>): boolean => turn.stage === 'draw' && turn.questionId === null && turn.selectedIndex === null && turn.correct === null && turn.roll === null;
function resetProgress(state: QuestState): QuestState {
  return { ...state, teams: state.teams.map(team => ({ ...team, position: 0, points: 0 })), firstTeamIndex: null, currentTeamIndex: null, deck: [], usedQuestionIds: [], turn: emptyTurn(), finishOrder: [], turnNumber: 0 };
}

/** Validate and copy private local state. Unknown fields and inconsistent turns fail closed. */
export function parseQuestionQuest(value: unknown): QuestState {
  const s = object(value); exact(s, ['version', 'id', 'phase', 'questions', 'teams', 'firstTeamIndex', 'currentTeamIndex', 'deck', 'usedQuestionIds', 'turn', 'finishOrder', 'turnNumber']);
  if (s.version !== 1 || !PHASES.includes(s.phase) || !Array.isArray(s.questions) || s.questions.length > 100 || !Array.isArray(s.teams) || s.teams.length !== 4 || !integer(s.turnNumber, 0, 1000000)) fail();
  const questions = s.questions.map((value: unknown) => question(value, true)), ids = new Set<string>(questions.map((q: QuestQuestion) => q.id));
  if (ids.size !== questions.length || s.phase !== 'questions' && !questions.length) fail();
  const teams: QuestTeam[] = s.teams.map((value: unknown, index: number) => {
    const team = object(value); exact(team, ['id', 'name', 'avatar', 'position', 'points']);
    const name = text(team.name, 32, 'Each team name');
    if (team.id !== TEAM_IDS[index] || name !== team.name || !AVATARS.has(team.avatar) || !integer(team.position, 0, QUEST_BOARD_LENGTH) || !integer(team.points, 0, QUEST_BOARD_LENGTH)) fail();
    return { id: team.id, name, avatar: team.avatar, position: team.position, points: team.points };
  });
  if (new Set(teams.map(team => team.name.toLowerCase())).size !== 4) fail('Give all four teams different names.');
  for (const name of ['firstTeamIndex', 'currentTeamIndex']) if (!(s[name] === null || integer(s[name], 0, 3))) fail();
  if (!Array.isArray(s.deck) || !Array.isArray(s.usedQuestionIds) || s.deck.length > questions.length || s.usedQuestionIds.length > questions.length || !Array.isArray(s.finishOrder) || s.finishOrder.length > 4) fail();
  const deck: string[] = s.deck.map(identifier), usedQuestionIds: string[] = s.usedQuestionIds.map(identifier), finishOrder: string[] = s.finishOrder.map(identifier);
  const combined = [...deck, ...usedQuestionIds];
  if (new Set(combined).size !== combined.length || combined.some(id => !ids.has(id)) || new Set(finishOrder).size !== finishOrder.length || finishOrder.some(id => !TEAM_IDS.includes(id))) fail();
  const turn = object(s.turn); exact(turn, ['stage', 'questionId', 'selectedIndex', 'correct', 'roll']);
  if (!STAGES.includes(turn.stage) || !(turn.questionId === null || typeof turn.questionId === 'string' && ids.has(turn.questionId)) || !(turn.selectedIndex === null || integer(turn.selectedIndex, 0, 3)) || !(turn.correct === null || typeof turn.correct === 'boolean') || !(turn.roll === null || integer(turn.roll, 1, 6))) fail();
  const playing = s.phase === 'playing' || s.phase === 'results';
  if (!playing) {
    if (teams.some(team => team.position || team.points) || finishOrder.length || deck.length || usedQuestionIds.length || s.turnNumber || !isEmptyTurn(turn)) fail();
    if (s.phase === 'first-team-picker') { if (s.firstTeamIndex !== s.currentTeamIndex) fail(); }
    else if (s.firstTeamIndex !== null || s.currentTeamIndex !== null) fail();
  } else {
    if (s.firstTeamIndex === null || s.currentTeamIndex === null || s.turnNumber < 1 || combined.length !== questions.length && !(s.turnNumber === 1 && !combined.length && turn.stage === 'draw')) fail();
    const active = teams[s.currentTeamIndex];
    if (turn.stage === 'draw') { if (turn.questionId !== null || turn.selectedIndex !== null || turn.correct !== null || turn.roll !== null) fail(); }
    else {
      const card = questions.find((q: QuestQuestion) => q.id === turn.questionId);
      if (!card || usedQuestionIds.at(-1) !== card.id || deck.includes(card.id)) fail();
      if (turn.stage === 'answer') { if (turn.selectedIndex !== null || turn.correct !== null || turn.roll !== null) fail(); }
      else {
        if (!integer(turn.selectedIndex, 0, card.choices.length - 1) || turn.correct !== (turn.selectedIndex === card.correctIndex)) fail();
        if (turn.stage === 'roll' ? turn.correct !== true || turn.roll !== null : turn.correct ? !integer(turn.roll, 1, 6) : turn.roll !== null) fail();
      }
    }
    if (teams.some((team, index) => team.points < Math.ceil(team.position / 6) || team.points > team.position + (index === s.currentTeamIndex && turn.stage === 'roll' ? 1 : 0))) fail();
    if (turn.stage === 'roll' && active.points < Math.ceil(active.position / 6) + 1 || teams.reduce((sum, team) => sum + team.points, 0) > s.turnNumber) fail();
    if (active.position === QUEST_BOARD_LENGTH && !(turn.stage === 'complete' && turn.correct && turn.roll !== null && finishOrder.at(-1) === active.id)) fail();
    if (s.phase === 'results' ? finishOrder.length !== 4 || turn.stage !== 'complete' : finishOrder.length === 4) fail();
  }
  if (teams.some(team => (team.position === QUEST_BOARD_LENGTH) !== finishOrder.includes(team.id))) fail();
  return { version: 1, id: identifier(s.id), phase: s.phase, questions, teams, firstTeamIndex: s.firstTeamIndex, currentTeamIndex: s.currentTeamIndex, deck, usedQuestionIds, turn: { stage: turn.stage, questionId: turn.questionId, selectedIndex: turn.selectedIndex, correct: turn.correct, roll: turn.roll }, finishOrder, turnNumber: s.turnNumber };
}

export function createQuestionQuest(id: string): QuestState {
  return { version: 1, id: identifier(id), phase: 'questions', questions: [], teams: TEAM_IDS.map((id, index) => ({ id, name: `Team ${index + 1}`, avatar: QUESTION_QUEST_AVATARS[index].id, position: 0, points: 0 })), firstTeamIndex: null, currentTeamIndex: null, deck: [], usedQuestionIds: [], turn: emptyTurn(), finishOrder: [], turnNumber: 0 };
}
export function upsertQuestQuestion(value: QuestState, input: QuestQuestion): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'questions') fail('Return to question setup before editing the cards.');
  const card = question(input), index = state.questions.findIndex(q => q.id === card.id);
  if (index < 0) { if (state.questions.length >= 100) fail('A game can contain up to 100 questions.'); state.questions.push(card); }
  else state.questions[index] = card;
  return parseQuestionQuest(state);
}
export function removeQuestQuestion(value: QuestState, id: string): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'questions') fail('Return to question setup before removing a card.');
  identifier(id); if (!state.questions.some(q => q.id === id)) fail('That question is no longer in this game.');
  state.questions = state.questions.filter(q => q.id !== id); return parseQuestionQuest(state);
}
export function finishQuestQuestions(value: QuestState): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'questions' || !state.questions.length) fail('Add at least one complete question before continuing.');
  return { ...state, phase: 'teams' };
}
export function configureQuestTeams(value: QuestState, inputs: QuestTeamSetup[]): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'teams' || !Array.isArray(inputs) || inputs.length !== 4) fail('Set up exactly four teams.');
  state.teams = inputs.map((value, index) => {
    const team = object(value); exact(team, ['id', 'name', 'avatar']);
    if (team.id !== TEAM_IDS[index] || !AVATARS.has(team.avatar)) fail('Choose a name and avatar for each of the four teams.');
    return { id: team.id, name: text(team.name, 32, 'Each team name'), avatar: team.avatar, position: 0, points: 0 };
  });
  return parseQuestionQuest({ ...state, phase: 'first-team-picker' });
}
function random(rng: QuestRandom): number {
  if (typeof rng !== 'function') fail('A random-number source is required.');
  const value = rng(); if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) fail('The random-number source returned an invalid value.'); return value;
}
export function pickFirstQuestTeam(value: QuestState, rng: QuestRandom): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'first-team-picker' || state.firstTeamIndex !== null) fail('The first team can be picked once before starting.');
  const index = Math.floor(random(rng) * 4); return { ...state, firstTeamIndex: index, currentTeamIndex: index };
}
export function startQuestionQuest(value: QuestState): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'first-team-picker' || state.firstTeamIndex === null) fail('Pick the first team before starting.');
  return parseQuestionQuest({ ...state, phase: 'playing', turnNumber: 1 });
}
export function drawQuestCard(value: QuestState, rng: QuestRandom): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'playing' || state.turn.stage !== 'draw') fail('Finish the current card and pass the turn before drawing again.');
  if (typeof rng !== 'function') fail('A random-number source is required.');
  if (!state.deck.length) {
    const previousId = state.usedQuestionIds.at(-1);
    state.deck = state.questions.map(q => q.id); state.usedQuestionIds = [];
    for (let i = state.deck.length - 1; i > 0; i--) { const j = Math.floor(random(rng) * (i + 1)); [state.deck[i], state.deck[j]] = [state.deck[j], state.deck[i]]; }
    if (state.deck.length > 1 && state.deck.at(-1) === previousId) {
      const swap = Math.floor(random(rng) * (state.deck.length - 1)), last = state.deck.length - 1;
      [state.deck[swap], state.deck[last]] = [state.deck[last], state.deck[swap]];
    }
  }
  const id = state.deck.pop()!; state.usedQuestionIds.push(id);
  state.turn = { ...emptyTurn(), stage: 'answer', questionId: id }; return parseQuestionQuest(state);
}
export function answerQuestCard(value: QuestState, choice: number): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'playing' || state.turn.stage !== 'answer') fail('Each card can be answered only once.');
  const card = state.questions.find(q => q.id === state.turn.questionId)!;
  if (!integer(choice, 0, card.choices.length - 1)) fail('Choose one of this card’s answers.');
  const correct = choice === card.correctIndex;
  if (correct) state.teams[state.currentTeamIndex!].points++;
  state.turn = { ...state.turn, selectedIndex: choice, correct, stage: correct ? 'roll' : 'complete' }; return parseQuestionQuest(state);
}
export function rollQuestDie(value: QuestState, rng: QuestRandom): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'playing' || state.turn.stage !== 'roll') fail('A correct answer permits exactly one die roll.');
  const roll = 1 + Math.floor(random(rng) * 6), team = state.teams[state.currentTeamIndex!];
  team.position = Math.min(QUEST_BOARD_LENGTH, team.position + roll);
  if (team.position === QUEST_BOARD_LENGTH) state.finishOrder.push(team.id);
  state.turn = { ...state.turn, stage: 'complete', roll };
  if (state.finishOrder.length === 4) state.phase = 'results';
  return parseQuestionQuest(state);
}
export function nextQuestTeam(value: QuestState): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'playing' || state.turn.stage !== 'complete') fail('Answer the card and finish its allowed roll before passing the turn.');
  if (state.turnNumber >= 1000000) fail('Start a fresh game after this many turns.');
  for (let step = 1; step <= 4; step++) {
    const index = (state.currentTeamIndex! + step) % 4;
    if (state.teams[index].position < QUEST_BOARD_LENGTH) return parseQuestionQuest({ ...state, currentTeamIndex: index, turnNumber: state.turnNumber + 1, turn: emptyTurn() });
  }
  fail('All four teams have finished.');
}
export function rematchQuestionQuest(value: QuestState): QuestState {
  const state = parseQuestionQuest(value); if (state.phase !== 'results') fail('Finish this game before starting a rematch.');
  return { ...resetProgress(state), phase: 'first-team-picker' };
}
export function editQuestQuestions(value: QuestState): QuestState {
  const state = parseQuestionQuest(value); if (!['questions', 'teams', 'first-team-picker'].includes(state.phase)) fail('Question setup is locked during play.');
  return { ...resetProgress(state), phase: 'questions' };
}
export function editQuestTeams(value: QuestState): QuestState {
  const state = parseQuestionQuest(value); if (!['teams', 'first-team-picker'].includes(state.phase)) fail('Team setup is locked during play.');
  return { ...resetProgress(state), phase: 'teams' };
}
/** This projection is safe to render after authoring; no answer key or card bank. */
export function projectQuestionQuest(value: QuestState): QuestPublicState {
  const state = parseQuestionQuest(value), { questions, deck: _deck, usedQuestionIds: _used, ...publicState } = state;
  const active = state.phase === 'playing' && state.turn.questionId ? questions.find(q => q.id === state.turn.questionId) : undefined;
  return { ...publicState, boardLength: QUEST_BOARD_LENGTH, winnerTeamId: state.finishOrder[0] ?? null, question: active ? { id: active.id, prompt: active.prompt, choices: [...active.choices] } : null };
}
export function serializeQuestionQuest(value: QuestState): string {
  const raw = JSON.stringify(parseQuestionQuest(value)); if (raw.length > MAX_STORED_LENGTH) fail('This game is too large to save.'); return raw;
}
export function readQuestionQuest(storage: Pick<Storage, 'getItem'>, key = QUESTION_QUEST_STORAGE_KEY): QuestState | undefined {
  const raw = storage.getItem(key); if (raw === null) return;
  if (raw.length > MAX_STORED_LENGTH) fail();
  try { return parseQuestionQuest(JSON.parse(raw)); } catch { fail(); }
}
export type QuestLoadResult = { status: 'ready'; state: QuestState; error?: undefined } | { status: 'empty' | 'invalid' | 'unavailable'; state: undefined; error?: string };
export function loadQuestionQuest(storage: Pick<Storage, 'getItem'>, key = QUESTION_QUEST_STORAGE_KEY): QuestLoadResult {
  let raw: string | null; try { raw = storage.getItem(key); } catch { return { status: 'unavailable', state: undefined, error: 'This browser could not open the saved game. Keep this page open while playing.' }; }
  if (raw === null) return { status: 'empty', state: undefined };
  try { if (raw.length > MAX_STORED_LENGTH) fail(); return { status: 'ready', state: parseQuestionQuest(JSON.parse(raw)) }; }
  catch { return { status: 'invalid', state: undefined, error: 'The saved game could not be restored. Its stored copy has been kept; start a new game only when ready.' }; }
}
export function saveQuestionQuest(value: QuestState, storage: Pick<Storage, 'setItem'>, key = QUESTION_QUEST_STORAGE_KEY): void { storage.setItem(key, serializeQuestionQuest(value)); }
