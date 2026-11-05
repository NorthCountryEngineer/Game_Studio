import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as quest from '../src/lib/question-quest';
import * as questionImport from '../src/lib/question-quest-import';

type Element = { type: unknown; props: Record<string, any> };
function elements(value: any): Element[] { if (Array.isArray(value)) return value.flatMap(elements); return value && typeof value === 'object' && 'type' in value ? [value, ...elements(value.props?.children)] : []; }
function content(value: any): string { if (Array.isArray(value)) return value.map(content).join(' '); if (value === null || value === undefined || typeof value === 'boolean') return ''; if (typeof value !== 'object') return String(value); return content(value.props?.children); }
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
function authored(count = 1): quest.QuestState {
  let s = quest.createQuestionQuest('ui-quest');
  for (let i = 0; i < count; i++) s = quest.upsertQuestQuestion(s, { id: `card-${i + 1}`, prompt: `Hidden host question ${i + 1}?`, choices: ['Right option', 'Wrong option'], correctIndex: 0 });
  return s;
}
function active(): quest.QuestState { const q = quest.finishQuestQuestions(authored()); return quest.startQuestionQuest(quest.pickFirstQuestTeam(quest.configureQuestTeams(q, q.teams.map(({ id, name, avatar }) => ({ id, name, avatar }))), () => 0)); }
function nearHome(): quest.QuestState {
  let s = active();
  for (let i = 0; i < 52; i++) s = quest.nextQuestTeam(quest.rollQuestDie(quest.answerQuestCard(quest.drawQuestCard(s, () => 0), 0), () => 0));
  return s;
}
function mount(options: { state?: quest.QuestState; raw?: string; readFails?: boolean; saveFails?: boolean; reducedMotion?: boolean } = {}) {
  const data = new Map<string, string>(); if (options.state) data.set(quest.QUESTION_QUEST_STORAGE_KEY, quest.serializeQuestionQuest(options.state)); if (options.raw !== undefined) data.set(quest.QUESTION_QUEST_STORAGE_KEY, options.raw);
  const writes: { key: string; value: string }[] = [];
  const storage = { getItem(key: string) { if (options.readFails) throw new Error('unreadable storage'); return data.get(key) ?? null; }, setItem(key: string, value: string) { if (options.saveFails) throw new Error('quota exceeded'); writes.push({ key, value }); data.set(key, value); } };
  const hooks: any[] = [], effects: any[] = []; let cursor = 0, dirty = true, tree: Element, unmounted = false, lateSetters = 0, now = 0, timerId = 0, random = 0, uuid = 0, randomCalls = 0;
  const timers = new Map<number, { at: number; callback: () => void }>(), windowListeners = new Map<string, () => void>(), docListeners = new Map<string, () => void>();
  const fakeReact = {
    useState(initial: any) { const at = cursor++; if (!hooks[at]) hooks[at] = { value: typeof initial === 'function' ? initial() : initial }; const hook = hooks[at]; return [hook.value, (next: any) => { if (unmounted) { lateSetters++; return; } const value = typeof next === 'function' ? next(hook.value) : next; if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; } }]; },
    useRef(initial: any) { const at = cursor++; if (!hooks[at]) hooks[at] = { current: initial }; return hooks[at]; },
    useEffect(setup: () => void | (() => void), deps?: unknown[]) { const at = cursor++, old = hooks[at]; if (!old || !deps || deps.length !== old.deps?.length || deps.some((value, i) => !Object.is(value, old.deps[i]))) { const effect = { deps, setup, cleanup: old?.cleanup }; hooks[at] = effect; effects.push(effect); } },
  };
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const window = { localStorage: storage, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: options.reducedMotion ?? false, addEventListener() {}, removeEventListener() {} }), addEventListener(type: string, fn: () => void) { windowListeners.set(type, fn); }, removeEventListener(type: string) { windowListeners.delete(type); } };
  const document = { activeElement: { focus() {} }, fullscreenElement: undefined, getElementById: () => ({ focus() {} }), addEventListener(type: string, fn: () => void) { docListeners.set(type, fn); }, removeEventListener(type: string) { docListeners.delete(type); } };
  const exported: Record<string, any> = {}, navigated: string[] = [];
  const source = ts.transpileModule(readFileSync(new URL('../src/components/QuestionQuest.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  vm.runInNewContext(source, { exports: exported, require(name: string) { if (name === 'react') return fakeReact; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }; if (name === '../lib/question-quest') return quest; if (name === '../lib/question-quest-import') return questionImport; if (name === '../question-quest.css') return {}; throw new Error(`Unexpected dependency ${name}`); }, window, document, Uint32Array, Uint8Array, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`, getRandomValues(value: Uint32Array) { randomCalls++; value[0] = Math.floor(random * 4294967296); return value; } }, setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; }, clearTimeout(id: number) { timers.delete(id); }, Error, Math, Object, Array, Number, Boolean, String, Set, Map, Promise });
  function flush() { let rounds = 0; while (dirty && !unmounted) { assert.ok(++rounds < 50, 'finite render/effect settling'); dirty = false; cursor = 0; effects.length = 0; tree = exported.QuestionQuest({ navigate: (path: string) => { navigated.push(path); } }); for (const effect of [...effects]) { effect.cleanup?.(); effect.cleanup = effect.setup(); } } }
  function all() { return elements(tree); }
  const label = (button: Element) => clean(button.props['aria-label'] ?? content(button.props.children));
  function button(text: string) { return all().find(e => e.type === 'button' && label(e) === text); }
  function click(text: string) { const found = button(text); assert.ok(found, `button: ${text}`); assert.equal(found.props.disabled ?? false, false, `enabled: ${text}`); found.props.onClick(); flush(); }
  function field(id: string) { return all().find(e => e.props.id === id || e.props['aria-label'] === id || e.props.placeholder === id); }
  function change(id: string, value: string) { const input = field(id); assert.ok(input, `field: ${id}`); all().find(element => element.type === 'form')?.props.onChangeCapture?.(); input.props.onChange({ target: { value } }); flush(); }
  function submit() { const form = all().find(e => e.type === 'form'); assert.ok(form, 'form'); form.props.onSubmit({ preventDefault() {} }); flush(); }
  function advance(ms: number) { const target = now + ms; for (;;) { const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].callback(); flush(); } now = target; }
  function state(): quest.QuestState { const found = hooks.find(hook => hook.value?.version === 1 && Array.isArray(hook.value?.questions)); assert.ok(found); return found.value; }
  function invoke(callback: () => void) { callback(); flush(); }
  function unmount() { for (const hook of hooks) hook.cleanup?.(); unmounted = true; }
  function selectFile(file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }) { const input = field('quest-question-file'); assert.ok(input); assert.equal(input.props.disabled, false); const target = { files: [file], value: file.name }; input.props.onChange({ currentTarget: target }); assert.equal(target.value, ''); flush(); }
  async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush(); } }
  flush(); return { button, click, change, submit, advance, state, invoke, all, field, selectFile, settle, text: () => clean(content(tree)), data, writes, navigated, unmount, timers, random: (value: number) => { random = value; }, randomCalls: () => randomCalls, lateSetters: () => lateSetters };
}

test('host authors a question, hides its answer key, names four teams, picks once, and starts a playable game', () => {
  const view = mount(); assert.equal(view.button('Set up teams →')!.props.disabled, true);
  view.change('quest-question-prompt', 'Which planet is red?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'Mars'); view.change('Answer B', 'Venus'); view.submit();
  assert.equal(view.state().questions.length, 1); assert.match(view.text(), /Which planet is red/); assert.equal(view.state().questions[0].correctIndex, 0);
  view.click('Set up teams →'); assert.equal(view.state().phase, 'teams'); assert.doesNotMatch(view.text(), /Which planet is red|Mars|Venus/);
  view.change('quest-team-0', 'Comets'); view.click('Side Eye for team 1'); view.submit(); assert.equal(view.state().phase, 'first-team-picker'); assert.equal(view.state().teams[0].avatar, 'penguin'); assert.equal(view.state().teams[0].name, 'Comets');
  const pick = view.button('Choose first team')!.props.onClick; view.invoke(pick); view.invoke(pick); assert.equal(view.randomCalls(), 1); assert.equal(view.state().firstTeamIndex, 0); assert.match(view.text(), /Choosing first team/); assert.equal(view.button('Start game →'), undefined);
  view.advance(1000); assert.equal(view.state().firstTeamIndex, 0); view.click('Start game →'); assert.equal(view.state().phase, 'playing'); assert.equal(view.state().currentTeamIndex, 0); assert.ok(view.button('Draw a question ↗')); view.unmount();
});

test('card and die animation locks prevent double draws, double answers, duplicate rolls, and skipped turns', () => {
  const view = mount({ state: active() }), draw = view.button('Draw a question ↗')!.props.onClick;
  view.invoke(draw); view.invoke(draw); assert.equal(view.state().usedQuestionIds.length, 1); assert.equal(view.state().turn.stage, 'answer');
  const answer = view.all().find(e => e.type === 'button' && clean(content(e.props.children)) === 'A Right option'); assert.ok(answer); assert.equal(answer.props.disabled, true); view.invoke(answer.props.onClick); assert.equal(view.state().teams[0].points, 0);
  view.advance(700); const choose = view.all().find(e => e.type === 'button' && clean(content(e.props.children)) === 'A Right option')!.props.onClick;
  view.invoke(choose); view.invoke(choose); assert.equal(view.state().teams[0].points, 1); assert.equal(view.state().turn.stage, 'roll');
  view.random(0.99); const roll = view.button('Roll two dice →')!.props.onClick; view.invoke(roll); view.invoke(roll); assert.equal(view.state().teams[0].position, 12); assert.equal(view.randomCalls(), 2); assert.equal(view.button('Next team →')!.props.disabled, true);
  view.advance(3800); assert.equal(view.state().teams[0].position, 12); assert.equal(view.state().teams[0].points, 1); assert.equal(view.state().turn.roll, 12); assert.deepEqual(view.state().turn.dice, [6, 6]);
  const next = view.button('Next team →')!.props.onClick; view.invoke(next); view.invoke(next); assert.equal(view.state().currentTeamIndex, 1); assert.equal(view.state().turnNumber, 2); view.unmount();
});

test('the question editor stores the chosen answer, keeps IDs on edit, and confirms removal', () => {
  const view = mount(); view.change('quest-question-prompt', 'Which planet has rings?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'Mars'); view.change('Answer B', 'Saturn'); view.change('Choice B is correct', ''); view.submit();
  const id = view.state().questions[0].id; assert.equal(view.state().questions[0].correctIndex, 1); view.click('Edit'); view.change('quest-question-prompt', 'Which planet has bright rings?'); view.submit(); assert.equal(view.state().questions.length, 1); assert.equal(view.state().questions[0].id, id); assert.equal(view.state().questions[0].correctIndex, 1);
  view.click('Remove'); assert.equal(view.state().questions.length, 1); view.click('Keep'); assert.equal(view.state().questions.length, 1); view.click('Remove'); view.click('Confirm remove'); assert.equal(view.state().questions.length, 0); assert.equal(view.button('Set up teams →')!.props.disabled, true); view.unmount();
});

test('random picker and die results are saved before their animations so reopening cannot reroll them', () => {
  const setup = quest.finishQuestQuestions(authored()), picker = quest.configureQuestTeams(setup, setup.teams.map(({ id, name, avatar }) => ({ id, name, avatar })));
  const pickView = mount({ state: picker }); pickView.random(0.8); pickView.click('Choose first team'); const savedPick = quest.parseQuestionQuest(JSON.parse(pickView.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!)); assert.equal(savedPick.firstTeamIndex, 3);
  const reopenedPick = mount({ state: savedPick }); assert.equal(reopenedPick.button('Choose first team'), undefined); assert.ok(reopenedPick.button('Start game →')); pickView.unmount(); reopenedPick.unmount();
  const rollView = mount({ state: quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0) }); rollView.random(0.99); rollView.click('Roll two dice →'); const savedRoll = quest.parseQuestionQuest(JSON.parse(rollView.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!)); assert.equal(savedRoll.turn.roll, 12); assert.deepEqual(savedRoll.turn.dice, [6, 6]); assert.equal(savedRoll.teams[0].position, 12);
  const reopenedRoll = mount({ state: savedRoll }); assert.equal(reopenedRoll.button('Roll two dice →'), undefined); assert.ok(reopenedRoll.button('Next team →')); assert.equal(reopenedRoll.state().teams[0].points, 1); rollView.unmount(); reopenedRoll.unmount();
});

test('old answer and next-team callbacks cannot act on a later turn even when the same single card repeats', () => {
  const view = mount({ state: active() }); view.click('Draw a question ↗'); view.advance(700);
  const previousAnswer = view.all().find(e => e.type === 'button' && clean(content(e.props.children)) === 'A Right option')!.props.onClick;
  view.invoke(view.all().find(e => e.type === 'button' && clean(content(e.props.children)) === 'B Wrong option')!.props.onClick);
  const previousNext = view.button('Next team →')!.props.onClick; view.invoke(previousNext); view.click('Draw a question ↗'); view.advance(700);
  view.invoke(previousAnswer); assert.equal(view.state().turn.stage, 'answer'); assert.equal(view.state().teams[1].points, 0);
  view.invoke(view.all().find(e => e.type === 'button' && clean(content(e.props.children)) === 'B Wrong option')!.props.onClick);
  view.invoke(previousNext); assert.equal(view.state().currentTeamIndex, 1); assert.equal(view.state().turnNumber, 2); view.click('Next team →'); assert.equal(view.state().currentTeamIndex, 2); view.unmount();
});

test('save failures warn clearly while authored questions and active play remain in memory', () => {
  const view = mount({ saveFails: true }); assert.match(view.text(), /can’t save changes/);
  view.change('quest-question-prompt', 'Still playable?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'Yes'); view.change('Answer B', 'No'); view.submit(); view.click('Set up teams →'); view.submit(); view.click('Choose first team'); view.advance(1000); view.click('Start game →');
  assert.equal(view.state().phase, 'playing'); assert.equal(view.state().questions[0].prompt, 'Still playable?'); assert.equal(view.data.size, 0); assert.match(view.text(), /Keep this tab open/); view.click('Draw a question ↗'); view.advance(700); assert.match(view.text(), /Still playable/); view.unmount();
});

test('a corrupt saved copy is untouched until the host explicitly confirms a fresh game', () => {
  const original = '{broken save'; const view = mount({ raw: original }); assert.match(view.text(), /saved data has not been changed/); assert.equal(view.writes.length, 0); assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), original);
  view.click('New game'); view.click('Cancel'); assert.equal(view.writes.length, 0); view.click('New game'); view.click('Start new game');
  assert.equal(view.state().phase, 'questions'); assert.equal(view.data.get(`${quest.QUESTION_QUEST_STORAGE_KEY}:previous`), original); assert.equal(JSON.parse(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!).version, 1); view.unmount();
});

test('unreadable saved data can be bypassed explicitly for a fresh memory-only game without overwriting it', () => {
  const original = quest.serializeQuestionQuest(active()); const view = mount({ raw: original, readFails: true }); assert.equal(view.writes.length, 0); view.click('New game'); view.click('Start new game');
  assert.match(view.text(), /Create the question bank/); assert.equal(view.state().phase, 'questions'); assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), original); assert.equal(view.writes.length, 0);
  view.change('quest-question-prompt', 'New in memory?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'Yes'); view.change('Answer B', 'No'); view.submit(); assert.equal(view.state().questions.length, 1); assert.match(view.text(), /Keep this tab open/); assert.equal(view.writes.length, 0); view.unmount();
});

test('the first finisher celebrates while the remaining teams continue to the complete results and rematch', () => {
  const view = mount({ state: nearHome() });
  for (let i = 0; i < 4; i++) {
    assert.equal(view.state().currentTeamIndex, i); view.click('Draw a question ↗'); view.advance(700); view.invoke(view.all().find(e => e.type === 'button' && clean(content(e.props.children)) === 'A Right option')!.props.onClick); view.click('Roll two dice →'); view.advance(3800);
    assert.equal(view.state().teams[i].position, 28); assert.equal(view.state().finishOrder[0], 'team-1');
    if (i === 0) { assert.match(view.text(), /Play continues until all teams finish/); assert.equal(view.state().phase, 'playing'); view.click('Continue game →'); }
    if (i < 3) view.click('Next team →');
  }
  assert.equal(view.state().phase, 'results'); assert.match(view.text(), /All teams finished/); assert.deepEqual(view.state().finishOrder, ['team-1', 'team-2', 'team-3', 'team-4']); assert.doesNotMatch(view.text(), /Hidden host question|Right option|Wrong option/);
  view.click('Rematch →'); assert.equal(view.state().phase, 'first-team-picker'); assert.ok(view.state().teams.every(t => t.position === 0 && t.points === 0)); assert.equal(view.state().questions.length, 1); view.unmount();
});

test('unmounting cancels pending animations and prevents late state writes', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0); const view = mount({ state: pending }); view.click('Roll two dice →'); assert.ok(view.timers.size > 1); const writes = view.writes.length; view.unmount(); assert.equal(view.timers.size, 0); view.advance(5000); assert.equal(view.lateSetters(), 0); assert.equal(view.writes.length, writes);
});

test('a delayed new-bank click cannot let a completed old die animation overwrite a fresh game', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0); const view = mount({ state: pending }); const newBank = view.button('New game')!.props.onClick; view.click('Roll two dice →'); view.invoke(newBank);
  const startNew = view.button('Start new game');
  if (startNew) { view.click('Start new game'); const id = view.state().id; view.advance(5000); assert.equal(view.state().id, id); assert.equal(view.state().phase, 'questions'); }
  else { assert.equal(view.state().turn.stage, 'complete'); view.advance(3800); assert.equal(view.state().turn.stage, 'complete'); }
  view.unmount();
});

const presentedPosition = (view: ReturnType<typeof mount>, teamId = 'team-1') => view.all().find(element => element.props['data-team-id'] === teamId)!.props['data-position'];
const shownDice = (view: ReturnType<typeof mount>) => view.all().filter(element => element.props['data-die-face'] !== undefined).map(element => element.props['data-die-face']);
const diceDialog = (view: ReturnType<typeof mount>) => view.all().find(element => element.props['aria-labelledby'] === 'quest-dice-heading');

test('two dice replace the question, slow down, stop on saved faces, and close before space-by-space movement', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pending });
  view.random(.99); view.click('Roll two dice →');
  assert.equal(view.randomCalls(), 2); assert.equal(view.state().turn.roll, 12); assert.deepEqual(view.state().turn.dice, [6, 6]);
  const saved = quest.parseQuestionQuest(JSON.parse(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!)); assert.equal(saved.teams[0].position, 12);
  assert.ok(diceDialog(view)); assert.doesNotMatch(view.text(), /Hidden host question|Right option|Wrong option/); assert.equal(presentedPosition(view), 0);
  const faces = new Set<number>(), intervals: number[] = [];
  for (const [index, at] of [50, 110, 180, 260, 355, 465, 595, 750, 935, 1155, 1415, 1720, 2070].entries()) {
    const before = index ? [50, 110, 180, 260, 355, 465, 595, 750, 935, 1155, 1415, 1720, 2070][index - 1] : 0;
    view.advance(at - before); shownDice(view).forEach(face => faces.add(face));
    intervals.push(Number.parseInt(diceDialog(view)!.props.style['--dice-speed'])); assert.equal(presentedPosition(view), 0);
  }
  assert.equal(faces.size, 6); assert.ok(intervals.every((interval, index) => !index || interval >= intervals[index - 1]));
  view.advance(170); assert.deepEqual(shownDice(view), [6, 6]); assert.match(view.text(), /6 \+ 6 = 12/); assert.equal(presentedPosition(view), 0);
  view.advance(359); assert.ok(diceDialog(view)); view.advance(1); assert.equal(diceDialog(view), undefined); assert.equal(presentedPosition(view), 0);
  const positions: number[] = [];
  for (let step = 1; step <= 12; step++) { view.advance(85); positions.push(presentedPosition(view)); assert.equal(view.button('Next team →')!.props.disabled, true); }
  assert.deepEqual(positions, Array.from({ length: 12 }, (_, index) => index + 1));
  view.advance(85); assert.equal(presentedPosition(view), 12); assert.equal(view.button('Next team →')!.props.disabled, false); assert.equal(view.randomCalls(), 2); view.unmount();
});

test('a finishing roll keeps winner, finish badges, and final results hidden until the piece settles', () => {
  const view = mount({ state: nearHome() }); view.click('Draw a question ↗'); view.advance(700);
  view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === 'A Right option')!.props.onClick);
  view.click('Roll two dice →'); assert.equal(view.state().finishOrder.length, 1); assert.equal(presentedPosition(view), 26);
  assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(2685); assert.equal(presentedPosition(view), 27); assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(85); assert.equal(presentedPosition(view), 28); assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(85); assert.ok(view.button('Continue game →')); assert.match(view.text(), /1st · finished/); view.unmount();
});

test('reduced motion skips face cycling and travel animation without rerolling or changing the saved result', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pending, reducedMotion: true });
  view.random(.99); view.click('Roll two dice →'); assert.deepEqual(shownDice(view), [6, 6]); assert.equal(view.randomCalls(), 2);
  view.advance(159); assert.equal(presentedPosition(view), 0); view.advance(1); assert.equal(diceDialog(view), undefined); assert.equal(presentedPosition(view), 12);
  assert.equal(view.button('Next team →')!.props.disabled, false); assert.equal(view.state().turn.roll, 12); view.unmount();
});

test('restored legacy single-die turns stay readable and never fabricate a pair or replay an animation', () => {
  const legacy = quest.rollQuestDie(quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), () => .4);
  delete legacy.turn.dice;
  const view = mount({ state: legacy }); assert.equal(view.state().turn.roll, 6); assert.equal(view.state().turn.dice, undefined);
  assert.equal(presentedPosition(view), 6); assert.equal(diceDialog(view), undefined); assert.equal(view.randomCalls(), 0); assert.equal(view.timers.size, 0);
  assert.ok(view.all().find(element => element.props['aria-label'] === 'Previous roll 6')); assert.doesNotMatch(view.text(), /undefined|NaN/); view.click('Next team →'); assert.equal(view.state().currentTeamIndex, 1); view.unmount();
});

test('the last team reaches the finish before final standings and rematch become visible', () => {
  let lastTurn = nearHome();
  for (let team = 0; team < 3; team++) lastTurn = quest.nextQuestTeam(quest.rollQuestDie(quest.answerQuestCard(quest.drawQuestCard(lastTurn, () => 0), 0), () => 0));
  const view = mount({ state: lastTurn }); view.click('Draw a question ↗'); view.advance(700);
  view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === 'A Right option')!.props.onClick);
  view.click('Roll two dice →'); assert.equal(view.state().phase, 'results'); assert.equal(presentedPosition(view, 'team-4'), 26);
  assert.equal(view.button('Rematch →'), undefined); assert.doesNotMatch(view.text(), /All teams finished\.|4th · finished/);
  view.advance(2770); assert.equal(presentedPosition(view, 'team-4'), 28); assert.equal(view.button('Rematch →'), undefined);
  assert.doesNotMatch(view.text(), /All teams finished\.|4th · finished/);
  view.advance(85); assert.ok(view.button('Rematch →')); assert.match(view.text(), /All teams finished\.|4th · finished/); view.unmount();
});

test('movement remains locked and a reset cancels even retained callbacks from the old roll', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pending });
  const newGame = view.button('New game')!.props.onClick; view.random(.99); view.click('Roll two dice →');
  const oldCallbacks = [...view.timers.values()].map(timer => timer.callback);
  view.advance(2685); assert.equal(presentedPosition(view), 1);
  const next = view.button('Next team →')!; assert.equal(next.props.disabled, true); view.invoke(next.props.onClick); assert.equal(view.state().currentTeamIndex, 0);
  view.invoke(newGame); view.click('Start new game'); const freshId = view.state().id;
  oldCallbacks.forEach(callback => view.invoke(callback)); view.advance(5000);
  assert.equal(view.state().id, freshId); assert.equal(view.state().phase, 'questions'); assert.equal(diceDialog(view), undefined); assert.equal(view.timers.size, 0); view.unmount();
});

const importText = (label = 'Imported question') => `Q: ${label}?\nA: First choice\nB: Second choice\nANSWER: B`;
function localFile(text: string, name = 'questions.txt') { const bytes = new TextEncoder().encode(text); return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer as ArrayBuffer }; }
function delayedFile(name = 'questions.txt') { let resolve!: (value: ArrayBuffer) => void; const data = new Promise<ArrayBuffer>(done => { resolve = done; }); return { file: { name, size: 100, arrayBuffer: () => data }, resolve(text: string) { resolve(new TextEncoder().encode(text).buffer as ArrayBuffer); } }; }

test('a local file previews every answer, appends once without replacing existing cards, and leaves manual entry available', async () => {
  const view = mount({ state: authored() }), original = quest.serializeQuestionQuest(view.state());
  assert.ok(view.all().find(element => element.type === 'a' && element.props.href === '/templates/quiz-circuit-questions.txt'));
  view.selectFile(localFile(`${importText('First imported')}\n---\n${importText('Second imported')}`, 'private-bank-name.txt')); await view.settle();
  assert.equal(quest.serializeQuestionQuest(view.state()), original); assert.match(view.text(), /First imported|Second imported/); assert.match(view.text(), /Correct answer/);
  const confirm = view.button('Import 2 questions')!.props.onClick; view.invoke(confirm); view.invoke(confirm);
  assert.equal(view.state().questions.length, 3); assert.equal(view.state().questions[0].id, 'card-1'); assert.equal(new Set(view.state().questions.map(card => card.id)).size, 3);
  assert.deepEqual(view.state().questions.slice(1).map(card => card.correctIndex), [1, 1]); assert.doesNotMatch(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!, /private-bank-name/);
  view.change('quest-question-prompt', 'Manual question after upload?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'Yes'); view.change('Answer B', 'No'); view.submit();
  assert.equal(view.state().questions.length, 4); view.click('Set up teams →'); assert.doesNotMatch(view.text(), /First imported|Second imported|First choice|Second choice|Correct answer|Manual question after upload/); view.unmount();
});

test('canceling a preview prevents even a retained confirmation from changing the bank', async () => {
  const view = mount({ state: authored() }), original = quest.serializeQuestionQuest(view.state());
  view.selectFile(localFile(importText())); await view.settle(); const confirm = view.button('Import 1 question')!.props.onClick;
  view.click('Cancel import'); view.invoke(confirm); assert.equal(quest.serializeQuestionQuest(view.state()), original); assert.equal(view.button('Import 1 question'), undefined); view.unmount();
});

test('a newly selected file wins over an older pending read and a manual draft invalidates its preview', async () => {
  const view = mount(), old = delayedFile(); view.selectFile(old.file); assert.match(view.text(), /Reading question file/);
  view.selectFile(localFile(importText('New selection'))); await view.settle(); old.resolve(importText('Obsolete selection')); await view.settle();
  assert.match(view.text(), /New selection/); assert.doesNotMatch(view.text(), /Obsolete selection/);
  const confirm = view.button('Import 1 question')!.props.onClick;
  view.change('quest-question-prompt', 'Unsaved manual question?'); view.invoke(confirm);
  assert.equal(view.state().questions.length, 0); assert.equal(view.field('quest-question-file')!.props.disabled, true); assert.equal(view.field('quest-question-prompt')!.props.value, 'Unsaved manual question?');
  view.click('Clear draft'); assert.equal(view.field('quest-question-file')!.props.disabled, false); view.unmount();
});

test('pending file reads cannot survive a draft change, accepted setup transition, reset, navigation, or unmount', async () => {
  for (const mode of ['draft', 'teams', 'reset', 'navigate', 'unmount']) {
    const view = mount({ state: authored() }), pending = delayedFile(), next = view.button('Set up teams →')!.props.onClick;
    view.selectFile(pending.file);
    if (mode === 'draft') view.change('quest-question-prompt', 'Still editing?');
    if (mode === 'teams') view.invoke(next);
    if (mode === 'reset') { view.click('New game'); view.click('Start new game'); }
    if (mode === 'navigate') view.click('← Party games');
    if (mode === 'unmount') view.unmount();
    const saved = quest.serializeQuestionQuest(view.state()), writes = view.writes.length;
    pending.resolve(importText('Late file result')); await view.settle();
    assert.equal(quest.serializeQuestionQuest(view.state()), saved, mode); assert.equal(view.writes.length, writes, mode); assert.equal(view.button('Import 1 question'), undefined, mode); assert.equal(view.lateSetters(), 0, mode);
    if (mode !== 'unmount') view.unmount();
  }
});

test('unsupported, oversized, unreadable, malformed and invalid UTF-8 files leave the existing bank unchanged', async () => {
  const view = mount({ state: authored() }), original = quest.serializeQuestionQuest(view.state()); let readCalls = 0;
  const badFiles = [
    { name: 'questions.csv', size: 20, arrayBuffer: async () => { readCalls++; return new ArrayBuffer(0); } },
    { name: 'questions.txt', size: questionImport.QUEST_IMPORT_MAX_BYTES + 1, arrayBuffer: async () => { readCalls++; return new ArrayBuffer(0); } },
    { name: 'questions.txt', size: 20, arrayBuffer: async () => { throw new Error('Synthetic file read failed.'); } },
    localFile('Q: Missing answer\nA: One\nB: Two'),
    { name: 'questions.txt', size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer as ArrayBuffer },
    localFile('{"version":1,"questions":[]}', 'questions.json'),
  ];
  for (const file of badFiles) { view.selectFile(file); await view.settle(); assert.ok(view.all().some(element => element.props.role === 'alert')); assert.equal(quest.serializeQuestionQuest(view.state()), original); assert.equal(view.button('Import 1 question'), undefined); }
  assert.equal(readCalls, 0); view.unmount();
});

test('capacity is checked against existing questions and only an explicit import can fill the final slot', async () => {
  const view = mount({ state: authored(99) }); view.selectFile(localFile(`${importText('One')}\n---\n${importText('Two')}`)); await view.settle();
  const tooMany = view.button('Import 2 questions')!; assert.equal(tooMany.props.disabled, true); view.invoke(tooMany.props.onClick); assert.equal(view.state().questions.length, 99); assert.match(view.text(), /101 questions|limit of 100/);
  view.selectFile(localFile(JSON.stringify({ version: 1, questions: [{ question: 'Last slot?', choices: ['One', 'Two'], answer: 'A' }] }), 'questions.json')); await view.settle();
  view.click('Import 1 question'); assert.equal(view.state().questions.length, 100); assert.equal(view.field('quest-question-file')!.props.disabled, true); assert.equal(view.state().questions[99].prompt, 'Last slot?'); view.unmount();
});
