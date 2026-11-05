import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUESTION_QUEST_AVATARS, QUESTION_QUEST_STORAGE_KEY, QUEST_BOARD_LENGTH, QuestionQuestError,
  answerQuestCard, configureQuestTeams, createQuestionQuest, drawQuestCard, editQuestQuestions, editQuestTeams,
  finishQuestQuestions, loadQuestionQuest, nextQuestTeam, parseQuestionQuest, pickFirstQuestTeam,
  projectQuestionQuest, readQuestionQuest, rematchQuestionQuest, removeQuestQuestion, rollQuestDie,
  saveQuestionQuest, serializeQuestionQuest, startQuestionQuest, upsertQuestQuestion,
  type QuestQuestion, type QuestState, type QuestTeamSetup,
} from '../src/lib/question-quest';

const card = (id = 'card-1'): QuestQuestion => ({ id, prompt: `Question ${id}?`, choices: ['Correct choice', 'Wrong choice'], correctIndex: 0 });
const setups = (): QuestTeamSetup[] => QUESTION_QUEST_AVATARS.slice(0, 4).map((avatar, i) => ({ id: `team-${i + 1}`, name: `Crew ${i + 1}`, avatar: avatar.id }));
function bank(count = 1): QuestState { let s = createQuestionQuest('quest-1'); for (let i = 0; i < count; i++) s = upsertQuestQuestion(s, card(`card-${i + 1}`)); return s; }
const picker = (count = 1) => configureQuestTeams(finishQuestQuestions(bank(count)), setups());
const playing = (count = 1, first = 0) => startQuestionQuest(pickFirstQuestTeam(picker(count), () => (first + 0.5) / 4));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const part of Object.values(value)) freeze(part); } return value; }
const reject = (value: unknown) => assert.throws(() => parseQuestionQuest(value), QuestionQuestError);
function store(initial?: string) { const data = new Map<string, string>(initial === undefined ? [] : [[QUESTION_QUEST_STORAGE_KEY, initial]]); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; }
function wrongTurn(state: QuestState) { return answerQuestCard(drawQuestCard(state, () => 0), 1); }
function legacyComplete(roll = 6): QuestState {
  const state = answerQuestCard(drawQuestCard(playing(), () => 0), 0);
  state.teams[0].position = roll;
  state.turn = { stage: 'complete', questionId: 'card-1', selectedIndex: 0, correct: true, roll };
  return state;
}
function faces(...values: number[]) { let at = 0; return () => { assert.ok(at < values.length, 'only the supplied independent dice samples are consumed'); return (values[at++] - 0.5) / 6; }; }

test('new games have four stable teams, an empty private bank, and a fixed 28-space track', () => {
  const s = createQuestionQuest('stable-quest_1'); assert.equal(s.phase, 'questions'); assert.equal(s.id, 'stable-quest_1'); assert.equal(s.version, 1);
  assert.deepEqual(s.teams.map(t => t.id), ['team-1', 'team-2', 'team-3', 'team-4']); assert.ok(s.teams.every(t => t.position === 0 && t.points === 0));
  assert.equal(QUEST_BOARD_LENGTH, 28); assert.equal(projectQuestionQuest(s).boardLength, 28); assert.deepEqual(parseQuestionQuest(s), s);
  for (const id of ['', ' space ', 'x'.repeat(65), 'x/y', '__proto__']) assert.throws(() => createQuestionQuest(id), QuestionQuestError);
});

test('question authoring normalizes text, preserves stable IDs, updates in place, and removes cards', () => {
  const original = freeze(bank(2)); const s = upsertQuestQuestion(original, { id: 'card-1', prompt: '  Cafe\u0301?  ', choices: ['  Oui  ', 'Non'], correctIndex: 1 });
  assert.deepEqual(s.questions.map(q => q.id), ['card-1', 'card-2']); assert.equal(s.questions[0].prompt, 'Café?'); assert.deepEqual(s.questions[0].choices, ['Oui', 'Non']); assert.equal(s.questions[0].correctIndex, 1);
  assert.equal(original.questions[0].prompt, 'Question card-1?'); assert.deepEqual(removeQuestQuestion(s, 'card-1').questions.map(q => q.id), ['card-2']);
  assert.throws(() => removeQuestQuestion(s, 'missing'), QuestionQuestError); assert.throws(() => finishQuestQuestions(createQuestionQuest('empty')), /at least one/);
});

test('question limits accept the exact maximum, including Unicode code points, and reject overflows', () => {
  const max = { id: 'max', prompt: '🐸'.repeat(300), choices: ['a'.repeat(120), 'b'.repeat(120), 'c', 'd'], correctIndex: 3 };
  assert.equal(upsertQuestQuestion(bank(), max).questions[1].prompt, max.prompt);
  for (const bad of [{ ...max, prompt: 'x'.repeat(301) }, { ...max, choices: ['x'.repeat(121), 'b'] }, { ...max, choices: ['one'] }, { ...max, choices: ['a', 'b', 'c', 'd', 'e'] }, { ...max, correctIndex: 4 }, { ...max, correctIndex: -1 }, { ...max, correctIndex: 0.5 }, { ...max, prompt: '   ' }, { ...max, prompt: 'a\u202eb' }, { ...max, choices: ['Same', ' same '] }, { ...max, id: 'bad id' }]) assert.throws(() => upsertQuestQuestion(bank(), bad), QuestionQuestError);
  const hundred = bank(100); assert.equal(hundred.questions.length, 100); assert.equal(upsertQuestQuestion(hundred, card('card-1')).questions.length, 100);
  assert.throws(() => upsertQuestQuestion(hundred, card('card-101')), /100 questions/);
});

test('team setup requires exactly four stable identities and bounded distinct names and valid avatars', () => {
  const base = finishQuestQuestions(bank()); const teams = setups(); teams[0].name = '  Café 🦊  ';
  const ready = configureQuestTeams(freeze(base), teams); assert.equal(ready.phase, 'first-team-picker'); assert.equal(ready.teams[0].name, 'Café 🦊');
  const max = setups(); max[0].name = '🐸'.repeat(32); assert.equal(configureQuestTeams(base, max).teams[0].name, max[0].name);
  for (const invalid of [setups().slice(0, 3), [...setups(), setups()[0]], setups().map((t, i) => i === 0 ? { ...t, id: 'replacement' } : t), setups().map((t, i) => i === 0 ? { ...t, avatar: 'unknown' as any } : t), setups().map((t, i) => i === 0 ? { ...t, name: 'x'.repeat(33) } : t), setups().map((t, i) => i === 1 ? { ...t, name: 'crew 1' } : t)]) assert.throws(() => configureQuestTeams(base, invalid), QuestionQuestError);
});

test('the first team is picked once, with separate explicit start and validated injected randomness', () => {
  const base = freeze(picker()); assert.equal(pickFirstQuestTeam(base, () => 0).firstTeamIndex, 0); assert.equal(pickFirstQuestTeam(base, () => 1 - Number.EPSILON).firstTeamIndex, 3);
  for (let i = 0; i < 4; i++) { const chosen = pickFirstQuestTeam(base, () => (i + 0.5) / 4); assert.equal(chosen.phase, 'first-team-picker'); assert.equal(chosen.currentTeamIndex, i); assert.equal(startQuestionQuest(chosen).currentTeamIndex, i); assert.throws(() => pickFirstQuestTeam(chosen, () => 0), /once/); }
  assert.throws(() => startQuestionQuest(base), /Pick the first/); assert.equal(base.firstTeamIndex, null);
  for (const invalid of [NaN, Infinity, -0.1, 1, 5, '0.5']) assert.throws(() => pickFirstQuestTeam(base, () => invalid as number), /invalid value/);
  assert.throws(() => pickFirstQuestTeam(base, undefined as any), /source is required/);
});

test('a wrong answer can be submitted only once, scores nothing, and permits no die roll', () => {
  const start = freeze(playing()), drawn = drawQuestCard(start, () => 0), answered = answerQuestCard(freeze(drawn), 1);
  assert.equal(drawn.turn.stage, 'answer'); assert.equal(answered.turn.stage, 'complete'); assert.equal(answered.turn.correct, false); assert.equal(answered.turn.roll, null); assert.equal(answered.teams[0].points, 0); assert.equal(answered.teams[0].position, 0);
  assert.throws(() => answerQuestCard(answered, 0), /only once/); assert.throws(() => rollQuestDie(answered, () => 0), /correct answer/); assert.throws(() => drawQuestCard(answered, () => 0), /Finish the current/);
  assert.throws(() => nextQuestTeam(drawn), /finish its allowed roll/); assert.equal(nextQuestTeam(answered).currentTeamIndex, 1); assert.equal(start.turn.stage, 'draw');
});

test('a correct answer adds one point and permits exactly one roll before the turn can pass', () => {
  const drawn = drawQuestCard(playing(), () => 0), answered = answerQuestCard(drawn, 0); assert.equal(answered.turn.stage, 'roll'); assert.equal(answered.teams[0].points, 1); assert.equal(answered.teams[0].position, 0);
  assert.throws(() => nextQuestTeam(answered), /finish its allowed roll/); assert.throws(() => answerQuestCard(answered, 1), /only once/);
  const moved = rollQuestDie(freeze(answered), faces(2, 6)); assert.deepEqual(moved.turn.dice, [2, 6]); assert.equal(moved.turn.roll, 8); assert.equal(moved.teams[0].position, 8); assert.equal(moved.teams[0].points, 1); assert.equal(moved.turn.stage, 'complete');
  assert.throws(() => rollQuestDie(moved, () => 0), /exactly one/); assert.equal(answered.teams[0].position, 0); assert.equal(nextQuestTeam(moved).turn.stage, 'draw');
});

test('both dice independently cover all six faces and their 36 outcomes produce the expected sum distribution', () => {
  const ready = freeze(answerQuestCard(drawQuestCard(playing(), () => 0), 0));
  const counts = Array<number>(11).fill(0);
  for (let first = 1; first <= 6; first++) for (let second = 1; second <= 6; second++) {
    const moved = rollQuestDie(ready, faces(first, second)); assert.deepEqual(moved.turn.dice, [first, second]); assert.equal(moved.turn.roll, first + second); assert.equal(moved.teams[0].position, first + second); assert.equal(moved.teams[0].points, 1); counts[moved.turn.roll! - 2]++;
  }
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
  for (let face = 1; face <= 6; face++) { const rolled = rollQuestDie(ready, () => (face - 1) / 6); assert.deepEqual(rolled.turn.dice, [face, face]); assert.equal(rolled.turn.roll, face * 2); }
  assert.deepEqual(rollQuestDie(ready, () => 0).turn.dice, [1, 1]); assert.equal(rollQuestDie(ready, () => 0).turn.roll, 2);
  assert.deepEqual(rollQuestDie(ready, () => 1 - Number.EPSILON).turn.dice, [6, 6]); assert.equal(rollQuestDie(ready, () => 1 - Number.EPSILON).turn.roll, 12);
  for (const value of [NaN, Infinity, -1, 1]) assert.throws(() => rollQuestDie(ready, () => value), QuestionQuestError);
  for (const choice of [-1, 2, 0.5, NaN, '0']) assert.throws(() => answerQuestCard(drawQuestCard(playing(), () => 0), choice as number), QuestionQuestError);
});

test('an invalid second random sample leaves the saved answer and its point untouched', () => {
  const ready = freeze(answerQuestCard(drawQuestCard(playing(), () => 0), 0)), raw = serializeQuestionQuest(ready);
  let calls = 0; assert.throws(() => rollQuestDie(ready, () => ++calls === 1 ? 0.5 : NaN), QuestionQuestError); assert.equal(calls, 2); assert.equal(serializeQuestionQuest(ready), raw); assert.equal(ready.teams[0].points, 1); assert.equal(ready.teams[0].position, 0); assert.equal(ready.turn.dice, undefined);
});

test('legacy version-one single-die results load and save exactly without inventing faces or permitting a reroll', () => {
  for (let total = 1; total <= 6; total++) {
    const old = freeze(legacyComplete(total)), raw = JSON.stringify(old), saved = store(raw), loaded = readQuestionQuest(saved)!;
    assert.equal(loaded.turn.roll, total); assert.equal(Object.hasOwn(loaded.turn, 'dice'), false); assert.equal(loaded.teams[0].position, total); assert.equal(loaded.teams[0].points, 1); assert.equal(serializeQuestionQuest(loaded), raw); assert.equal(loadQuestionQuest(saved).status, 'ready');
    let samples = 0; assert.throws(() => rollQuestDie(loaded, () => { samples++; return 0; }), /exactly one/); assert.equal(samples, 0);
    const projected = projectQuestionQuest(loaded); assert.equal(Object.hasOwn(projected.turn, 'dice'), false); assert.equal(projected.turn.roll, total);
  }
});

test('continuing a legacy save uses two dice only for the next allowed roll and preserves prior movement', () => {
  const old = readQuestionQuest(store(JSON.stringify(legacyComplete(5))))!;
  const next = rollQuestDie(answerQuestCard(drawQuestCard(nextQuestTeam(old), () => 0), 0), faces(2, 6));
  assert.deepEqual(next.turn.dice, [2, 6]); assert.equal(next.turn.roll, 8); assert.equal(next.teams[0].position, 5); assert.equal(next.teams[0].points, 1); assert.equal(next.teams[1].position, 8); assert.equal(next.teams[1].points, 1);
  assert.deepEqual(readQuestionQuest(store(serializeQuestionQuest(next))), next); const passed = nextQuestTeam(next); assert.equal(Object.hasOwn(passed.turn, 'dice'), false); assert.equal(passed.teams[1].position, 8);
});

test('legacy completed matches retain all positions and points and rematch without a schema migration', () => {
  const old = legacyComplete(1); old.phase = 'results'; old.currentTeamIndex = 3; old.turnNumber = 112; old.finishOrder = old.teams.map(team => team.id); old.teams = old.teams.map(team => ({ ...team, position: 28, points: 28 }));
  const raw = JSON.stringify(old), loaded = readQuestionQuest(store(raw))!; assert.equal(serializeQuestionQuest(loaded), raw); assert.equal(loaded.version, 1); assert.equal(loaded.turn.roll, 1); assert.equal(Object.hasOwn(loaded.turn, 'dice'), false);
  const reset = rematchQuestionQuest(loaded); assert.equal(reset.phase, 'first-team-picker'); assert.ok(reset.teams.every(team => team.position === 0 && team.points === 0)); assert.equal(Object.hasOwn(reset.turn, 'dice'), false);
});

test('two-dice parsing rejects forged faces, totals, stages, and movement instead of silently treating them as legacy', () => {
  const completed = rollQuestDie(answerQuestCard(drawQuestCard(playing(), () => 0), 0), faces(2, 6));
  for (const dice of [undefined, null, [], [2], [2, 6, 1], ['2', 6], [0, 6], [7, 1], [2.5, 5.5], [NaN, 6], { 0: 2, 1: 6, length: 2 }]) reject({ ...completed, turn: { ...completed.turn, dice } });
  const extra = [2, 6] as number[] & { extra?: boolean }; extra.extra = true; reject({ ...completed, turn: { ...completed.turn, dice: extra } });
  for (const total of [null, 0, 1, 7, 9, 13, 8.5]) reject({ ...completed, turn: { ...completed.turn, roll: total } });
  const absent = clone(completed); delete absent.turn.dice; reject(absent);
  for (const phase of [playing(), drawQuestCard(playing(), () => 0), answerQuestCard(drawQuestCard(playing(), () => 0), 0), wrongTurn(playing()), createQuestionQuest('setup')]) reject({ ...phase, turn: { ...phase.turn, dice: [1, 1] } });
  for (const position of [7, 9, 28]) reject({ ...completed, teams: completed.teams.map((team, index) => index === 0 ? { ...team, position } : team) });
});

test('new dice tuples round-trip by value and cannot mutate the private save through parsing or projection', () => {
  const completed = freeze(rollQuestDie(answerQuestCard(drawQuestCard(playing(), () => 0), 0), faces(1, 6))), raw = serializeQuestionQuest(completed), parsed = parseQuestionQuest(completed), publicState = projectQuestionQuest(completed);
  parsed.turn.dice![0] = 6; publicState.turn.dice![1] = 1; assert.deepEqual(completed.turn.dice, [1, 6]); assert.equal(completed.turn.roll, 7); assert.equal(serializeQuestionQuest(completed), raw); assert.deepEqual(readQuestionQuest(store(raw)), completed);
});

test('turn order rotates strictly from any chosen first team', () => {
  let s = playing(1, 2); const order: number[] = [];
  for (let i = 0; i < 9; i++) { order.push(s.currentTeamIndex!); s = nextQuestTeam(wrongTurn(s)); }
  assert.deepEqual(order, [2, 3, 0, 1, 2, 3, 0, 1, 2]); assert.equal(s.turnNumber, 10); assert.ok(s.teams.every(t => !t.points && !t.position));
});

test('shuffled cards are used exactly once per cycle and do not repeat across cycle boundaries', () => {
  let s = playing(3); const seen: string[] = [];
  for (let i = 0; i < 12; i++) { s = drawQuestCard(s, () => 0); seen.push(s.turn.questionId!); s = nextQuestTeam(answerQuestCard(s, 1)); }
  for (let i = 0; i < seen.length; i += 3) assert.deepEqual(new Set(seen.slice(i, i + 3)), new Set(['card-1', 'card-2', 'card-3']));
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i - 1], seen[i]);
});

test('the two-card refill avoids repeating its predecessor even when the shuffle would choose it', () => {
  let s = playing(2); const first = drawQuestCard(s, () => 0); s = nextQuestTeam(answerQuestCard(first, 1)); const second = drawQuestCard(s, () => 0); s = nextQuestTeam(answerQuestCard(second, 1));
  // The next Fisher–Yates draw keeps the initial order, placing card-2 on top again.
  const next = drawQuestCard(s, () => 0.99); assert.notEqual(next.turn.questionId, second.turn.questionId); assert.equal(next.usedQuestionIds.length, 1); assert.equal(next.deck.length, 1);
});

test('a single authored card repeats safely and never requires an artificial second question', () => {
  let s = playing(); for (let i = 0; i < 5; i++) { s = drawQuestCard(s, () => 0); assert.equal(s.turn.questionId, 'card-1'); assert.deepEqual(s.usedQuestionIds, ['card-1']); s = nextQuestTeam(answerQuestCard(s, 1)); }
});

test('shuffle randomness is injected and invalid randomness cannot mutate the input', () => {
  const input = freeze(playing(3)), before = serializeQuestionQuest(input); assert.notDeepEqual(drawQuestCard(input, () => 0).deck, drawQuestCard(input, () => 0.99).deck);
  assert.throws(() => drawQuestCard(input, () => 1), /invalid value/); assert.equal(serializeQuestionQuest(input), before);
});

test('a complete legal match caps movement, celebrates the first winner, skips finishers, and finishes all four', () => {
  let s = playing(), firstWinner: string | null = null, turns = 0;
  while (s.phase !== 'results') {
    assert.ok(++turns <= 100); const i = s.currentTeamIndex!, before = s.teams[i].position;
    assert.ok(before < 28); s = rollQuestDie(answerQuestCard(drawQuestCard(s, () => 0), 0), () => i === 0 ? 0.99 : 0);
    assert.equal(s.teams[i].position, Math.min(28, before + (i === 0 ? 12 : 2)));
    if (s.finishOrder.length) { firstWinner ??= s.finishOrder[0]; assert.equal(projectQuestionQuest(s).winnerTeamId, firstWinner); }
    if (s.phase !== 'results') { s = nextQuestTeam(s); assert.ok(s.teams[s.currentTeamIndex!].position < 28); }
  }
  assert.equal(turns, 45); assert.equal(firstWinner, 'team-1'); assert.deepEqual(s.finishOrder, ['team-1', 'team-2', 'team-3', 'team-4']); assert.deepEqual(s.teams.map(t => t.points), [3, 14, 14, 14]); assert.ok(s.teams.every(t => t.position === 28));
  assert.throws(() => nextQuestTeam(s), QuestionQuestError); assert.throws(() => drawQuestCard(s, () => 0), QuestionQuestError);
  const rematch = rematchQuestionQuest(freeze(s)); assert.equal(rematch.phase, 'first-team-picker'); assert.equal(rematch.firstTeamIndex, null); assert.deepEqual(rematch.questions, s.questions); assert.deepEqual(rematch.teams.map(t => [t.id, t.name, t.avatar]), s.teams.map(t => [t.id, t.name, t.avatar])); assert.ok(rematch.teams.every(t => !t.position && !t.points)); assert.deepEqual(rematch.finishOrder, []); assert.equal(startQuestionQuest(pickFirstQuestTeam(rematch, () => 0)).turnNumber, 1);
});

test('authoring is locked during play while setup can deliberately return to prior steps', () => {
  const chosen = pickFirstQuestTeam(picker(), () => 0.5); const questions = editQuestQuestions(chosen), teams = editQuestTeams(chosen);
  assert.equal(questions.phase, 'questions'); assert.equal(questions.firstTeamIndex, null); assert.equal(teams.phase, 'teams'); assert.equal(teams.currentTeamIndex, null); assert.deepEqual(questions.questions, chosen.questions);
  const active = playing(); for (const change of [() => editQuestQuestions(active), () => editQuestTeams(active), () => upsertQuestQuestion(active, card('new')), () => removeQuestQuestion(active, 'card-1'), () => configureQuestTeams(active, setups()), () => rematchQuestionQuest(active)]) assert.throws(change, QuestionQuestError);
});

test('public projections reveal no private question bank, answer key, or shuffled order in any setup phase', () => {
  const initial = bank(2), teams = finishQuestQuestions(initial), ready = configureQuestTeams(teams, setups()), chosen = pickFirstQuestTeam(ready, () => 0);
  for (const state of [initial, teams, ready, chosen, startQuestionQuest(chosen)]) {
    const publicState = projectQuestionQuest(state), raw = JSON.stringify(publicState);
    assert.equal(publicState.question, null); for (const hidden of ['questions', 'deck', 'usedQuestionIds']) assert.equal(hidden in publicState, false, hidden);
    for (const hidden of ['correctIndex', 'Correct choice', 'Question card-']) assert.equal(raw.includes(hidden), false, hidden);
    assert.equal(publicState.teams.length, 4);
  }
});

test('an active card projection exposes only its prompt and choices and cannot mutate private state', () => {
  const state = freeze(drawQuestCard(playing(2), () => 0)), view = projectQuestionQuest(state); assert.ok(view.question); assert.deepEqual(Object.keys(view.question!).sort(), ['choices', 'id', 'prompt']); assert.equal(JSON.stringify(view).includes('correctIndex'), false); assert.equal('questions' in view, false);
  view.question!.choices[0] = 'Changed'; view.teams[0].name = 'Changed'; view.finishOrder.push('team-4'); view.turn.stage = 'complete'; assert.equal(state.teams[0].name, 'Crew 1'); assert.notEqual(state.questions.find(q => q.id === view.question!.id)!.choices[0], 'Changed'); assert.equal(state.turn.stage, 'answer'); assert.deepEqual(state.finishOrder, []);
});

test('saved games round-trip every turn stage without losing stable identities or private answers', () => {
  const draw = playing(3), answer = drawQuestCard(draw, () => 0), roll = answerQuestCard(answer, 0), complete = rollQuestDie(roll, () => 0.5);
  for (const state of [bank(), finishQuestQuestions(bank()), picker(), draw, answer, roll, complete, nextQuestTeam(complete)]) assert.deepEqual(parseQuestionQuest(JSON.parse(serializeQuestionQuest(freeze(state)))), state);
});

test('strict parsing accepts reordered JSON properties but rejects unknown schema fields', () => {
  const state = createQuestionQuest('order-independent'); const reordered = { ...state, turn: { roll: null, correct: null, selectedIndex: null, questionId: null, stage: 'draw' } }; assert.deepEqual(parseQuestionQuest(reordered), state);
  reject({ ...state, surprise: true }); reject({ ...state, version: 2 }); reject({ ...state, phase: 'unknown' }); reject({ ...state, turn: { ...state.turn, answer: 0 } }); reject({ ...state, teams: state.teams.map((t, i) => i ? t : { ...t, secret: 1 }) });
});

test('strict parsing rejects malformed deck partitions, duplicate card identities, and out-of-range state', () => {
  const s = drawQuestCard(playing(3), () => 0);
  for (const mutate of [
    (c: any) => { c.questions.push(clone(c.questions[0])); }, (c: any) => { c.deck.push(c.usedQuestionIds[0]); }, (c: any) => { c.deck.pop(); }, (c: any) => { c.usedQuestionIds = ['missing']; },
    (c: any) => { c.teams[0].position = 29; }, (c: any) => { c.teams[0].points = -1; }, (c: any) => { c.teams[0].id = 'team-4'; }, (c: any) => { c.currentTeamIndex = 4; }, (c: any) => { c.firstTeamIndex = null; }, (c: any) => { c.turnNumber = 0; }, (c: any) => { c.questions[0].prompt = '  noncanonical  '; },
  ]) { const corrupted = clone(s); mutate(corrupted); reject(corrupted); }
});

test('strict parsing rejects impossible answer, roll, score, and finish correlations', () => {
  const answer = drawQuestCard(playing(), () => 0), roll = answerQuestCard(answer, 0), complete = rollQuestDie(roll, () => 0.5);
  const changes: [QuestState, (s: any) => void][] = [
    [answer, s => { s.turn.selectedIndex = 0; }], [answer, s => { s.turn.questionId = null; }], [roll, s => { s.turn.correct = false; }], [roll, s => { s.teams[0].points = 0; }],
    [complete, s => { s.turn.roll = 0; }], [complete, s => { s.turn.selectedIndex = 1; }], [complete, s => { s.teams[0].points = 2; }], [complete, s => { s.teams[1].position = 6; }],
    [complete, s => { s.finishOrder = ['team-1']; }], [complete, s => { s.teams[0].position = 28; }], [complete, s => { s.phase = 'results'; }],
  ];
  for (const [base, mutate] of changes) { const corrupted = clone(base); mutate(corrupted); reject(corrupted); }
  const before = createQuestionQuest('preplay'); reject({ ...before, firstTeamIndex: 0 }); reject({ ...before, deck: ['missing'] }); reject({ ...before, turnNumber: 1 });
});

test('bounded loaders preserve missing, malformed, oversized, and inaccessible stored copies', () => {
  const missing = store(); assert.deepEqual(loadQuestionQuest(missing), { status: 'empty', state: undefined }); assert.equal(readQuestionQuest(missing), undefined);
  for (const raw of ['{broken', JSON.stringify({ version: 1 }), 'x'.repeat(256001)]) { const saved = store(raw); const result = loadQuestionQuest(saved); assert.equal(result.status, 'invalid'); assert.match(result.error!, /kept/); assert.equal(saved.data.get(QUESTION_QUEST_STORAGE_KEY), raw); assert.throws(() => readQuestionQuest(saved), QuestionQuestError); }
  const unavailable = { getItem() { throw new Error('storage blocked'); } }; assert.equal(loadQuestionQuest(unavailable).status, 'unavailable'); assert.throws(() => readQuestionQuest(unavailable), /storage blocked/);
});

test('saving validates before writing, supports a scoped key, and never discards in-memory progress on quota failure', () => {
  const s = freeze(answerQuestCard(drawQuestCard(playing(), () => 0), 0)), saved = store(); saveQuestionQuest(s, saved); assert.deepEqual(readQuestionQuest(saved), s); assert.equal(loadQuestionQuest(saved).status, 'ready');
  saveQuestionQuest(s, saved, 'custom-key'); assert.deepEqual(readQuestionQuest(saved, 'custom-key'), s);
  let writes = 0; assert.throws(() => saveQuestionQuest({ ...s, version: 2 } as any, { setItem() { writes++; } }), QuestionQuestError); assert.equal(writes, 0);
  assert.throws(() => saveQuestionQuest(s, { setItem() { throw new Error('quota reached'); } }), /quota reached/); assert.equal(s.turn.stage, 'roll'); assert.equal(s.teams[0].points, 1);
});
