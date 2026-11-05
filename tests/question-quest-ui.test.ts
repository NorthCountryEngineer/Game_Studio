import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as quest from '../src/lib/question-quest';
import * as questionImport from '../src/lib/question-quest-import';
import * as questionSources from '../src/lib/question-quest-sources';
import * as gracieQuestions from '../src/lib/gracie-questions';
import * as gameBackup from '../src/lib/question-quest-backup';
import * as questId from '../src/lib/question-quest-id';

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
function mount(options: { state?: quest.QuestState; raw?: string; readFails?: boolean; saveFails?: boolean; reducedMotion?: boolean; sources?: questionSources.QuestQuestionSources; sidecarRaw?: string; sourceSaveFails?: boolean; storageAccessFails?: boolean; standalone?: boolean; resolveAsset?: (path: string) => string; noRandomUUID?: boolean } = {}) {
  const data = new Map<string, string>(); if (options.state) data.set(quest.QUESTION_QUEST_STORAGE_KEY, quest.serializeQuestionQuest(options.state)); if (options.raw !== undefined) data.set(quest.QUESTION_QUEST_STORAGE_KEY, options.raw);
  if (options.sources && options.state) questionSources.saveQuestQuestionSources({ setItem: (key, value) => data.set(key, value) }, options.state, options.sources);
  if (options.sidecarRaw !== undefined) data.set(questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY, options.sidecarRaw);
  const writes: { key: string; value: string }[] = [], exportedBackups: { filename: string; contents: string }[] = [];
  const storage = { getItem(key: string) { if (options.readFails) throw new Error('unreadable storage'); return data.get(key) ?? null; }, setItem(key: string, value: string) { if (options.saveFails || options.sourceSaveFails && key === questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY) throw new Error('quota exceeded'); writes.push({ key, value }); data.set(key, value); }, removeItem(key: string) { if (options.saveFails) throw new Error('quota exceeded'); data.delete(key); } };
  const hooks: any[] = [], effects: any[] = []; let cursor = 0, dirty = true, tree: Element, unmounted = false, lateSetters = 0, now = 0, timerId = 0, random = 0, uuid = 0, randomCalls = 0;
  const timers = new Map<number, { at: number; callback: () => void }>(), windowListeners = new Map<string, () => void>(), docListeners = new Map<string, () => void>();
  const fakeReact = {
    useState(initial: any) { const at = cursor++; if (!hooks[at]) hooks[at] = { value: typeof initial === 'function' ? initial() : initial }; const hook = hooks[at]; return [hook.value, (next: any) => { if (unmounted) { lateSetters++; return; } const value = typeof next === 'function' ? next(hook.value) : next; if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; } }]; },
    useRef(initial: any) { const at = cursor++; if (!hooks[at]) hooks[at] = { current: initial }; return hooks[at]; },
    useEffect(setup: () => void | (() => void), deps?: unknown[]) { const at = cursor++, old = hooks[at]; if (!old || !deps || deps.length !== old.deps?.length || deps.some((value, i) => !Object.is(value, old.deps[i]))) { const effect = { deps, setup, cleanup: old?.cleanup }; hooks[at] = effect; effects.push(effect); } },
  };
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const window = { localStorage: storage, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: options.reducedMotion ?? false, addEventListener() {}, removeEventListener() {} }), addEventListener(type: string, fn: () => void) { windowListeners.set(type, fn); }, removeEventListener(type: string) { windowListeners.delete(type); } };
  if (options.storageAccessFails) Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage access blocked'); } });
  const document = { activeElement: { focus() {} }, fullscreenElement: undefined, getElementById: () => ({ focus() {} }), addEventListener(type: string, fn: () => void) { docListeners.set(type, fn); }, removeEventListener(type: string) { docListeners.delete(type); } };
  const exported: Record<string, any> = {}, navigated: string[] = [];
  const source = ts.transpileModule(readFileSync(new URL('../src/components/QuestionQuest.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  vm.runInNewContext(source, { exports: exported, require(name: string) { if (name === 'react') return fakeReact; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'FRAGMENT' }; if (name === '../lib/question-quest') return quest; if (name === '../lib/question-quest-import') return questionImport; if (name === '../lib/question-quest-sources') return questionSources; if (name === '../lib/gracie-questions') return gracieQuestions; if (name === '../lib/question-quest-backup') return gameBackup; if (name === '../lib/question-quest-id') return questId; if (name === '../question-quest.css') return {}; throw new Error(`Unexpected dependency ${name}`); }, window, document, Uint32Array, Uint8Array, crypto: { randomUUID: options.noRandomUUID ? undefined : () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`, getRandomValues(value: Uint32Array | Uint8Array) { if (value instanceof Uint8Array) { value.fill(0); value[15] = ++uuid; return value; } randomCalls++; value[0] = Math.floor(random * 4294967296); return value; } }, setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; }, clearTimeout(id: number) { timers.delete(id); }, Error, Math, Object, Array, Number, Boolean, String, Set, Map, Promise, TextEncoder });
  function flush() { let rounds = 0; while (dirty && !unmounted) { assert.ok(++rounds < 50, 'finite render/effect settling'); dirty = false; cursor = 0; effects.length = 0; tree = exported.QuestionQuest({ navigate: (path: string) => { navigated.push(path); }, standalone: options.standalone, resolveAsset: options.resolveAsset, saveBackup: (filename: string, contents: string) => exportedBackups.push({ filename, contents }) }); for (const effect of [...effects]) { effect.cleanup?.(); effect.cleanup = effect.setup(); } } }
  function all() { return elements(tree); }
  const label = (button: Element) => clean(button.props['aria-label'] ?? content(button.props.children));
  function button(text: string) { return all().find(e => e.type === 'button' && label(e) === text); }
  function click(text: string) { const found = button(text); assert.ok(found, `button: ${text}`); assert.equal(found.props.disabled ?? false, false, `enabled: ${text}`); found.props.onClick(); flush(); }
  function field(id: string) { return all().find(e => e.props.id === id || e.props['aria-label'] === id || e.props.placeholder === id); }
  function change(id: string, value: string) { const input = field(id); assert.ok(input, `field: ${id}`); all().find(element => element.type === 'form')?.props.onChangeCapture?.(); input.props.onChange({ target: { value } }); flush(); }
  function submit() { const form = all().find(e => e.type === 'form'); assert.ok(form, 'form'); form.props.onSubmit({ preventDefault() {} }); flush(); }
  function advance(ms: number) { const target = now + ms; for (;;) { const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].callback(); flush(); } now = target; }
  function stall(ms: number) { now += ms; for (;;) { const next = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); next[1].callback(); flush(); } }
  function state(): quest.QuestState { const found = hooks.find(hook => hook.value?.version === 1 && Array.isArray(hook.value?.questions)); assert.ok(found); return found.value; }
  function invoke(callback: () => void) { callback(); flush(); }
  function unmount() { for (const hook of hooks) hook.cleanup?.(); unmounted = true; }
  function selectFile(file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }, id = 'quest-question-file') { const input = field(id); assert.ok(input); assert.equal(input.props.disabled, false); const target = { files: [file], value: file.name }; input.props.onChange({ currentTarget: target }); assert.equal(target.value, ''); flush(); }
  async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush(); } }
  flush(); return { button, click, change, submit, advance, stall, state, invoke, all, field, selectFile, settle, text: () => clean(content(tree)), data, writes, exportedBackups, navigated, unmount, timers, random: (value: number) => { random = value; }, randomCalls: () => randomCalls, lateSetters: () => lateSetters };
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
  view.advance(6000); assert.equal(view.state().teams[0].position, 12); assert.equal(view.state().teams[0].points, 1); assert.equal(view.state().turn.roll, 12); assert.deepEqual(view.state().turn.dice, [6, 6]);
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
    assert.equal(view.state().currentTeamIndex, i); view.click('Draw a question ↗'); view.advance(700); view.invoke(view.all().find(e => e.type === 'button' && clean(content(e.props.children)) === 'A Right option')!.props.onClick); view.click('Roll two dice →'); view.advance(6000);
    assert.equal(view.state().teams[i].position, 28); assert.equal(view.state().finishOrder[0], 'team-1');
    if (i === 0) { assert.match(view.text(), /Play continues until all teams finish/); assert.equal(view.state().phase, 'playing'); view.click('Continue game →'); }
    if (i < 3) view.click('Next team →');
  }
  assert.equal(view.state().phase, 'results'); assert.match(view.text(), /All teams finished/); assert.deepEqual(view.state().finishOrder, ['team-1', 'team-2', 'team-3', 'team-4']); assert.doesNotMatch(view.text(), /Hidden host question|Right option|Wrong option/);
  view.click('Rematch →'); assert.equal(view.state().phase, 'first-team-picker'); assert.ok(view.state().teams.every(t => t.position === 0 && t.points === 0)); assert.equal(view.state().questions.length, 1); view.unmount();
});

test('unmounting cancels pending animations and prevents late state writes', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0); const view = mount({ state: pending }); view.click('Roll two dice →'); assert.ok(view.timers.size > 1); const writes = view.writes.length; view.unmount(); assert.equal(view.timers.size, 0); view.advance(6000); assert.equal(view.lateSetters(), 0); assert.equal(view.writes.length, writes);
});

test('a delayed new-bank click cannot let a completed old die animation overwrite a fresh game', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0); const view = mount({ state: pending }); const newBank = view.button('New game')!.props.onClick; view.click('Roll two dice →'); view.invoke(newBank);
  const startNew = view.button('Start new game');
  if (startNew) { view.click('Start new game'); const id = view.state().id; view.advance(6000); assert.equal(view.state().id, id); assert.equal(view.state().phase, 'questions'); }
  else { assert.equal(view.state().turn.stage, 'complete'); view.advance(6000); assert.equal(view.state().turn.stage, 'complete'); }
  view.unmount();
});

const presentedPosition = (view: ReturnType<typeof mount>, teamId = 'team-1') => view.all().find(element => element.props['data-team-id'] === teamId)!.props['data-position'];
const shownDice = (view: ReturnType<typeof mount>) => view.all().filter(element => element.props['data-die-face'] !== undefined).map(element => element.props['data-die-face']);
const diceDialog = (view: ReturnType<typeof mount>) => view.all().find(element => element.props['aria-labelledby'] === 'quest-dice-heading');

test('two dice cycle, hold a readable settled result, and close before slower space-by-space movement', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pending });
  view.random(.99); view.click('Roll two dice →');
  assert.equal(view.randomCalls(), 2); assert.equal(view.state().turn.roll, 12); assert.deepEqual(view.state().turn.dice, [6, 6]);
  const saved = quest.parseQuestionQuest(JSON.parse(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!)); assert.equal(saved.teams[0].position, 12);
  assert.ok(diceDialog(view)); assert.doesNotMatch(view.text(), /Hidden host question|Right option|Wrong option/); assert.equal(presentedPosition(view), 0);
  const faces = new Set<number>(), intervals: number[] = [], frameTimes = [30, 70, 115, 170, 235, 310, 400, 505, 630, 780, 960, 1170, 1390];
  for (const [index, at] of frameTimes.entries()) {
    view.advance(at - (frameTimes[index - 1] ?? 0)); shownDice(view).forEach(face => faces.add(face));
    intervals.push(Number.parseInt(diceDialog(view)!.props.style['--dice-speed'])); assert.equal(presentedPosition(view), 0);
  }
  assert.equal(faces.size, 6); assert.ok(intervals.every((interval, index) => !index || interval >= intervals[index - 1]));
  view.advance(259); assert.match(diceDialog(view)!.props.className, /is-rolling/);
  view.advance(1); assert.deepEqual(shownDice(view), [6, 6]); assert.match(diceDialog(view)!.props.className, /is-settled/); assert.match(view.text(), /6 \+ 6 = 12/); assert.equal(presentedPosition(view), 0);
  // The 150 ms pose transition completes by 1.8 s; the result then remains
  // fully still for another 1.2 s, within the original three-second overlay.
  view.advance(150); assert.deepEqual(shownDice(view), [6, 6]); assert.equal(presentedPosition(view), 0);
  view.advance(1199); assert.ok(diceDialog(view)); assert.deepEqual(shownDice(view), [6, 6]); assert.equal(presentedPosition(view), 0);
  const next = view.button('Next team →')!; assert.equal(next.props.disabled, true); view.invoke(next.props.onClick); assert.equal(view.state().currentTeamIndex, 0);
  view.advance(1); assert.equal(diceDialog(view), undefined); assert.equal(presentedPosition(view), 0);
  const positions: number[] = [];
  for (let step = 1; step <= 12; step++) {
    view.advance(219); assert.equal(presentedPosition(view), step - 1); assert.equal(view.button('Next team →')!.props.disabled, true);
    view.advance(1); positions.push(presentedPosition(view)); assert.equal(view.button('Next team →')!.props.disabled, true);
  }
  assert.deepEqual(positions, Array.from({ length: 12 }, (_, index) => index + 1));
  // The final 200 ms CSS travel finishes before the last 220 ms guard ends.
  view.advance(219); assert.equal(presentedPosition(view), 12); assert.equal(view.button('Next team →')!.props.disabled, true);
  view.advance(1); assert.equal(presentedPosition(view), 12); assert.equal(view.button('Next team →')!.props.disabled, false); assert.equal(view.randomCalls(), 2); view.unmount();
});

test('delayed browser callbacks preserve the result pause and do not collapse remaining board steps', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pending });
  view.random(.99); view.click('Roll two dice →');
  view.stall(6000); assert.deepEqual(shownDice(view), [6, 6]); assert.match(diceDialog(view)!.props.className, /is-settled/); assert.equal(presentedPosition(view), 0);
  view.advance(1349); assert.ok(diceDialog(view)); assert.equal(presentedPosition(view), 0); assert.equal(view.button('Next team →')!.props.disabled, true);
  view.advance(1); assert.equal(diceDialog(view), undefined); assert.equal(presentedPosition(view), 0);
  view.stall(2000); assert.equal(presentedPosition(view), 1); assert.equal(view.button('Next team →')!.props.disabled, true);
  view.advance(219); assert.equal(presentedPosition(view), 1); view.advance(1); assert.equal(presentedPosition(view), 2);
  view.advance(2420); assert.equal(presentedPosition(view), 12); assert.equal(view.button('Next team →')!.props.disabled, false);
  assert.equal(view.state().turn.roll, 12); assert.deepEqual(view.state().turn.dice, [6, 6]); assert.equal(view.randomCalls(), 2); view.unmount();
});

test('a finishing roll keeps winner, finish badges, and final results hidden until the slower piece settles', () => {
  const view = mount({ state: nearHome() }); view.click('Draw a question ↗'); view.advance(700);
  view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === 'A Right option')!.props.onClick);
  view.click('Roll two dice →'); assert.equal(view.state().finishOrder.length, 1); assert.equal(presentedPosition(view), 26);
  assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(3219); assert.equal(presentedPosition(view), 26); assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(1); assert.equal(presentedPosition(view), 27); assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(220); assert.equal(presentedPosition(view), 28); assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(219); assert.doesNotMatch(view.text(), /Continue game|1st · finished/);
  view.advance(1); assert.ok(view.button('Continue game →')); assert.match(view.text(), /1st · finished/); view.unmount();
});

test('reduced motion holds the static result for 1.2 seconds without cycling, travel or rerolling', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pending, reducedMotion: true });
  view.random(.99); view.click('Roll two dice →'); assert.deepEqual(shownDice(view), [6, 6]); assert.equal(view.randomCalls(), 2); assert.match(diceDialog(view)!.props.className, /is-settled/);
  view.advance(1199); assert.ok(diceDialog(view)); assert.deepEqual(shownDice(view), [6, 6]); assert.equal(presentedPosition(view), 0);
  const next = view.button('Next team →')!; assert.equal(next.props.disabled, true); view.invoke(next.props.onClick); assert.equal(view.state().currentTeamIndex, 0);
  view.advance(1); assert.equal(diceDialog(view), undefined); assert.equal(presentedPosition(view), 12);
  assert.equal(view.button('Next team →')!.props.disabled, false); assert.equal(view.state().turn.roll, 12); assert.equal(view.randomCalls(), 2); assert.equal(view.timers.size, 0); view.unmount();
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
  view.advance(3440); assert.equal(presentedPosition(view, 'team-4'), 28); assert.equal(view.button('Rematch →'), undefined);
  assert.doesNotMatch(view.text(), /All teams finished\.|4th · finished/);
  view.advance(219); assert.equal(view.button('Rematch →'), undefined); view.advance(1); assert.ok(view.button('Rematch →')); assert.match(view.text(), /All teams finished\.|4th · finished/); view.unmount();
});

test('movement remains locked and a reset cancels even retained callbacks from the old roll', () => {
  const pending = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pending });
  const newGame = view.button('New game')!.props.onClick; view.random(.99); view.click('Roll two dice →');
  const oldCallbacks = [...view.timers.values()].map(timer => timer.callback);
  view.advance(3220); assert.equal(presentedPosition(view), 1); oldCallbacks.push(...[...view.timers.values()].map(timer => timer.callback));
  const next = view.button('Next team →')!; assert.equal(next.props.disabled, true); view.invoke(next.props.onClick); assert.equal(view.state().currentTeamIndex, 0);
  view.invoke(newGame); view.click('Start new game'); const freshId = view.state().id;
  oldCallbacks.forEach(callback => view.invoke(callback)); view.advance(6000);
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

const citationFixture: questionSources.QuestQuestionSource = {
  url: 'https://www.cdc.gov/cannabis/health-effects/index.html',
  citation: 'Centers for Disease Control and Prevention. (2024). Synthetic classroom source.',
  explanation: 'Synthetic explanation visible after the team answers.',
};
function sourceMapFor(state: quest.QuestState) { return { [questionSources.questionSourceKey(state.questions[0])]: citationFixture }; }
function questionSourceLinks(view: ReturnType<typeof mount>) { return view.all().filter(element => element.type === 'a' && element.props.href === citationFixture.url); }

test('Gracie preset appends reviewed cards and sources once while preserving existing authored cards', () => {
  const view = mount({ state: authored() }), original = structuredClone(view.state().questions[0]), teams = structuredClone(view.state().teams), count = gracieQuestions.GRACIE_QUESTION_PRESET.questions.length;
  const load = view.button("Use Gracie's Questions")!.props.onClick;
  view.invoke(load); view.invoke(load);
  assert.equal(view.state().questions.length, count + 1); assert.deepEqual(view.state().questions[0], original); assert.deepEqual(view.state().teams, teams);
  assert.equal(view.state().phase, 'questions'); assert.equal(new Set(view.state().questions.map(card => card.id)).size, count + 1);
  const saved = quest.parseQuestionQuest(JSON.parse(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!));
  assert.ok(saved.questions.every(card => !Object.hasOwn(card, 'source')));
  const sources = questionSources.loadQuestQuestionSources({ getItem: key => view.data.get(key) ?? null }, saved);
  assert.equal(sources.status, 'ready'); assert.equal(Object.keys(sources.sources).length, count);
  view.click("Use Gracie's Questions"); assert.equal(view.state().questions.length, count + 1); assert.match(view.text(), /already in this bank/);
  const reopened = mount({ state: saved, sources: sources.sources }); reopened.click("Use Gracie's Questions"); assert.equal(reopened.state().questions.length, count + 1); assert.deepEqual(reopened.state().questions.map(card => card.id), saved.questions.map(card => card.id));
  view.unmount(); reopened.unmount();
});

test('a retained preset callback cannot bypass a later manual draft, navigation or unmount', () => {
  for (const mode of ['draft', 'source-draft', 'navigate', 'unmount']) {
    const view = mount(), load = view.button("Use Gracie's Questions")!.props.onClick;
    if (mode === 'draft') view.change('quest-question-prompt', 'Keep this unfinished question?');
    if (mode === 'source-draft') view.change('quest-source-url', citationFixture.url);
    if (mode === 'navigate') view.click('← Party games');
    if (mode === 'unmount') view.unmount();
    const writes = view.writes.length; view.invoke(load);
    assert.equal(view.state().questions.length, 0, mode); assert.equal(view.writes.length, writes, mode); assert.equal(view.lateSetters(), 0, mode);
    if (mode === 'draft' || mode === 'source-draft') assert.equal(view.button("Use Gracie's Questions")!.props.disabled, true);
    if (mode !== 'unmount') view.unmount();
  }
});

test('loading Gracie questions cancels pending reads and retained file confirmations', async () => {
  for (const mode of ['reading', 'preview']) {
    const view = mount({ state: authored() }), pending = delayedFile(); let oldConfirm: (() => void) | undefined;
    if (mode === 'reading') view.selectFile(pending.file);
    else { view.selectFile(localFile(importText('Obsolete file'))); await view.settle(); oldConfirm = view.button('Import 1 question')!.props.onClick; }
    view.click("Use Gracie's Questions"); const expected = quest.serializeQuestionQuest(view.state());
    if (mode === 'reading') pending.resolve(importText('Late imported question'));
    else view.invoke(oldConfirm!);
    await view.settle(); assert.equal(quest.serializeQuestionQuest(view.state()), expected); assert.equal(view.button('Import 1 question'), undefined); assert.doesNotMatch(view.text(), /Late imported question|Obsolete file/); view.unmount();
  }
});

test('Gracie preset capacity is atomic and counts only missing cards', () => {
  const count = gracieQuestions.GRACIE_QUESTION_PRESET.questions.length;
  const full = mount({ state: authored(100 - count) }); full.click("Use Gracie's Questions"); assert.equal(full.state().questions.length, 100); full.click("Use Gracie's Questions"); assert.equal(full.state().questions.length, 100); assert.match(full.text(), /already in this bank/); full.unmount();
  const tooSmall = mount({ state: authored(101 - count) }), before = quest.serializeQuestionQuest(tooSmall.state()); tooSmall.click("Use Gracie's Questions"); assert.equal(quest.serializeQuestionQuest(tooSmall.state()), before); assert.match(tooSmall.text(), /No questions were added/); tooSmall.unmount();
});

test('manual citations validate before saving, reopen for editing and remain outside the legacy game record', () => {
  const view = mount(); view.change('quest-question-prompt', 'A sourced manual question?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'Yes'); view.change('Answer B', 'No');
  view.change('quest-source-url', citationFixture.url); view.submit(); assert.equal(view.state().questions.length, 0);
  view.change('quest-source-citation', citationFixture.citation); view.change('quest-source-explanation', citationFixture.explanation!); view.submit();
  const card = view.state().questions[0], raw = view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!;
  assert.ok(card); assert.doesNotMatch(raw, /Synthetic classroom source|Synthetic explanation/);
  let loaded = questionSources.loadQuestQuestionSources({ getItem: key => view.data.get(key) ?? null }, view.state()); assert.deepEqual(loaded.sources[questionSources.questionSourceKey(card)], citationFixture);
  const reopened = mount({ state: view.state(), sources: loaded.sources }); reopened.click('Edit');
  assert.equal(reopened.field('quest-source-url')!.props.value, citationFixture.url); assert.equal(reopened.field('quest-source-citation')!.props.value, citationFixture.citation);
  reopened.change('quest-question-prompt', 'A revised sourced manual question?'); reopened.submit();
  loaded = questionSources.loadQuestQuestionSources({ getItem: key => reopened.data.get(key) ?? null }, reopened.state()); assert.equal(loaded.sources[questionSources.questionSourceKey(card)], undefined); assert.deepEqual(loaded.sources[questionSources.questionSourceKey(reopened.state().questions[0])], citationFixture);
  reopened.click('Edit'); reopened.change('quest-source-url', ''); reopened.change('quest-source-citation', ''); reopened.change('quest-source-explanation', ''); reopened.submit();
  loaded = questionSources.loadQuestQuestionSources({ getItem: key => reopened.data.get(key) ?? null }, reopened.state()); assert.equal(Object.keys(loaded.sources).length, 0);
  reopened.click('Set up teams →'); assert.doesNotMatch(reopened.text(), /Synthetic classroom source|Synthetic explanation|A revised sourced manual question/); view.unmount(); reopened.unmount();
});

test('retained manual save callbacks cannot attach a stale citation after the draft changes', () => {
  const view = mount(); view.change('quest-question-prompt', 'Current draft?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'One'); view.change('Answer B', 'Two');
  view.change('quest-source-url', citationFixture.url); view.change('quest-source-citation', citationFixture.citation);
  const save = view.all().find(element => element.type === 'form')!.props.onSubmit;
  view.change('quest-source-citation', 'New citation chosen by the host.'); view.invoke(() => save({ preventDefault() {} }));
  assert.equal(view.state().questions.length, 0); assert.equal(view.field('quest-source-citation')!.props.value, 'New citation chosen by the host.'); view.submit(); assert.equal(view.state().questions.length, 1); view.unmount();
});

test('both correct and incorrect answers reveal the correct choice, explanation, source link and citation only after answering', () => {
  for (const selected of [0, 1]) {
    const state = active(), view = mount({ state, sources: sourceMapFor(state) });
    assert.equal(questionSourceLinks(view).length, 0); assert.doesNotMatch(view.text(), /Synthetic explanation|Synthetic classroom source/);
    view.click('Draw a question ↗'); view.advance(700);
    assert.equal(questionSourceLinks(view).length, 0); assert.doesNotMatch(view.text(), /Correct answer: A\.|Synthetic explanation|Synthetic classroom source/);
    view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === (selected ? 'B Wrong option' : 'A Right option'))!.props.onClick);
    assert.match(view.text(), /Correct answer: A\. Right option/); assert.match(view.text(), /Synthetic explanation visible after the team answers/); assert.match(view.text(), /Synthetic classroom source/);
    const link = questionSourceLinks(view)[0]; assert.ok(link); assert.equal(link.props.target, '_blank'); assert.equal(link.props.rel, 'noopener noreferrer');
    assert.equal(view.all().find(element => element.type === 'button' && clean(content(element.props.children)).startsWith('A Right option'))!.props.className, 'is-right');
    assert.equal(view.state().teams[0].points, selected ? 0 : 1); assert.equal(view.state().turn.stage, selected ? 'complete' : 'roll'); view.unmount();
  }
});

test('matching legacy and imported preset text receives its reviewed source without changing the v1 saved format', () => {
  const input = gracieQuestions.GRACIE_QUESTION_PRESET.questions[0]; let s = quest.appendQuestQuestions(quest.createQuestionQuest('matched-legacy'), [input], () => 'legacy-matched-card');
  s = quest.finishQuestQuestions(s); s = quest.configureQuestTeams(s, s.teams.map(({ id, name, avatar }) => ({ id, name, avatar }))); s = quest.startQuestionQuest(quest.pickFirstQuestTeam(s, () => 0));
  const view = mount({ state: s }); view.click('Draw a question ↗'); view.advance(700);
  const before = view.all().find(element => element.props['aria-label'] === 'Correct answer and information source'); assert.equal(before, undefined);
  const correctChoice = input.choices[input.correctIndex]; view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === `${String.fromCharCode(65 + input.correctIndex)} ${correctChoice}`)!.props.onClick);
  const source = gracieQuestions.sourceForGracieQuestion(input)!; assert.ok(source); assert.match(view.text(), new RegExp(source.citation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(view.all().some(element => element.type === 'a' && element.props.href === source.url)); assert.equal(Object.hasOwn(view.state().questions[0], 'source'), false); view.unmount();
});

test('a sourced file previews its citation and persists it separately while team setup hides all private material', async () => {
  const view = mount({ state: authored() });
  view.selectFile(localFile(JSON.stringify({ version: 1, questions: [{ question: 'Imported sourced question?', choices: ['One', 'Two'], answer: 'B', source: citationFixture }] }), 'sourced.json')); await view.settle();
  assert.match(view.text(), /Synthetic classroom source|Synthetic explanation/); assert.equal(view.state().questions.length, 1); view.click('Import 1 question');
  const loaded = questionSources.loadQuestQuestionSources({ getItem: key => view.data.get(key) ?? null }, view.state()), imported = view.state().questions[1]; assert.deepEqual(loaded.sources[questionSources.questionSourceKey(imported)], citationFixture);
  view.click('Set up teams →'); assert.doesNotMatch(view.text(), /Imported sourced question|Synthetic classroom source|Synthetic explanation|Correct answer/); assert.equal(questionSourceLinks(view).length, 0); view.unmount();
});

test('unknown legacy cards reveal their answer honestly without fabricating a source and corrupt citation storage leaves the game readable', () => {
  const original = active(), sidecar = '{malformed citations', view = mount({ state: original, sidecarRaw: sidecar });
  assert.match(view.text(), /Saved citations could not be opened/); assert.equal(view.data.get(questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY), sidecar);
  view.click('Draw a question ↗'); view.advance(700); view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === 'B Wrong option')!.props.onClick);
  assert.match(view.text(), /Correct answer: A\. Right option/); assert.match(view.text(), /No information source was supplied/); assert.equal(view.all().filter(element => element.type === 'a').length, 0); assert.equal(view.state().teams[0].points, 0); view.unmount();
});

test('citation-only storage failures retain both the saved question and its in-memory answer feedback', () => {
  const view = mount({ sourceSaveFails: true }); view.change('quest-question-prompt', 'Source storage failure?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'Yes'); view.change('Answer B', 'No'); view.change('quest-source-url', citationFixture.url); view.change('quest-source-citation', citationFixture.citation); view.change('quest-source-explanation', citationFixture.explanation!); view.submit();
  assert.equal(view.state().questions.length, 1); assert.equal(JSON.parse(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!).questions.length, 1); assert.equal(view.data.get(questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY), undefined); assert.match(view.text(), /can’t save citations/);
  view.click('Set up teams →'); view.submit(); view.click('Choose first team'); view.advance(1000); view.click('Start game →'); view.click('Draw a question ↗'); view.advance(700);
  view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === 'B No')!.props.onClick);
  assert.match(view.text(), /Correct answer: A\. Yes/); assert.match(view.text(), /Synthetic explanation visible/); assert.match(view.text(), /Synthetic classroom source/); view.unmount();
});

test('mutating a bank with damaged citation storage preserves the unreadable raw sidecar before replacement', () => {
  const original = '{broken citation save', view = mount({ state: authored(), sidecarRaw: original });
  view.change('quest-question-prompt', 'New manual card?'); view.change('Number of answer choices', '2'); view.change('Answer A', 'One'); view.change('Answer B', 'Two'); view.submit();
  assert.equal(view.state().questions.length, 2); assert.equal(view.data.get(`${questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY}:previous`), original); assert.equal(questionSources.loadQuestQuestionSources({ getItem: key => view.data.get(key) ?? null }, view.state()).status, 'ready'); view.unmount();
});

test('a browser that blocks the localStorage property itself still opens recovery and preserves prior saves', () => {
  const original = quest.serializeQuestionQuest(active()), view = mount({ raw: original, storageAccessFails: true });
  assert.match(view.text(), /Saved game unavailable/); assert.match(view.text(), /saved data has not been changed/); assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), original); assert.equal(view.writes.length, 0);
  view.click('New game'); view.click('Start new game'); assert.equal(view.state().phase, 'questions'); assert.match(view.text(), /Keep this tab open/); assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), original); assert.equal(view.writes.length, 0); view.unmount();
});

function offlineBackupFixture() {
  let state = quest.upsertQuestQuestion(quest.createQuestionQuest('offline-restored-game'), { id: 'restored-secret-card', prompt: 'Restored private question?', choices: ['Restored wrong choice', 'Restored right choice'], correctIndex: 1 });
  state = quest.finishQuestQuestions(state); state = quest.configureQuestTeams(state, state.teams.map(({ id, avatar }, index) => ({ id, avatar, name: `Recovered team ${index + 1}` }))); state = quest.startQuestionQuest(quest.pickFirstQuestTeam(state, () => .3)); state = quest.rollQuestDie(quest.answerQuestCard(quest.drawQuestCard(state, () => 0), 1), () => .4);
  return { state, sources: sourceMapFor(state) };
}
const backupFile = (backup = offlineBackupFixture()) => localFile(gameBackup.serializeQuestGameBackup(backup.state, backup.sources), 'health-game-backup.json');
const restorePreview = (view: ReturnType<typeof mount>) => view.all().find(element => element.props['aria-labelledby'] === 'quest-backup-confirm-title');

test('standalone mode resolves every board asset and hides party navigation while defaults keep ordinary web URLs', () => {
  const paths = new Set<string>(), view = mount({ standalone: true, resolveAsset: path => { paths.add(path); return `data:application/octet-stream;base64,aW5saW5l#${path}`; } });
  assert.equal(view.button('← Party games'), undefined); assert.ok(view.button('Save game backup ↓'));
  const assertEmbedded = () => { for (const element of view.all()) for (const name of ['src', 'href']) { const value = element.props[name]; if (typeof value === 'string') assert.doesNotMatch(value, /^\/(?:pieces|branding|templates)\//); } };
  assertEmbedded(); view.click("Use Gracie's Questions"); view.click('Set up teams →'); assertEmbedded(); view.submit(); view.click('Choose first team'); view.advance(1000); view.click('Start game →'); assertEmbedded(); view.click('Draw a question ↗'); view.advance(700);
  const card = view.state().questions.find(question => question.id === view.state().turn.questionId)!; view.invoke(view.all().find(element => element.type === 'button' && clean(content(element.props.children)) === `${String.fromCharCode(65 + card.correctIndex)} ${card.choices[card.correctIndex]}`)!.props.onClick);
  assert.match(view.text(), /Read source \(requires internet\)/); assertEmbedded(); assert.ok(paths.has('/branding/health-school-logo.png')); assert.ok(paths.has('/templates/quiz-circuit-questions.txt')); assert.ok(paths.has('/templates/quiz-circuit-questions.json')); for (const avatar of quest.QUESTION_QUEST_AVATARS) assert.ok(paths.has(avatar.image)); view.unmount();
  const normal = mount(); assert.ok(normal.button('← Party games')); assert.equal(normal.button('Save game backup ↓'), undefined); assert.ok(normal.all().some(element => element.props.src === '/branding/health-school-logo.png')); assert.ok(normal.all().some(element => element.props.href === '/templates/quiz-circuit-questions.txt')); normal.unmount();
});

test('standalone exports the complete current match and sources through an explicit save action', () => {
  const backup = offlineBackupFixture(), view = mount({ ...backup, standalone: true });
  view.click('Minimize question and show board'); view.click('Save game backup ↓'); assert.equal(view.exportedBackups.length, 1);
  assert.equal(view.exportedBackups[0].filename, 'health-game-backup.json'); assert.deepEqual(gameBackup.parseQuestGameBackup(new TextEncoder().encode(view.exportedBackups[0].contents)), backup); assert.equal(view.randomCalls(), 0); view.unmount();
});

test('standalone backup restore previews metadata only and explicitly restores exact progress without rerolling', async () => {
  const original = authored(), originalSources = sourceMapFor(original), backup = offlineBackupFixture(), view = mount({ state: original, sources: originalSources, standalone: true });
  const originalRaw = view.data.get(quest.QUESTION_QUEST_STORAGE_KEY)!, sourceRaw = view.data.get(questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY)!;
  view.selectFile(backupFile(backup), 'quest-game-backup-file'); await view.settle();
  assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), originalRaw); const preview = restorePreview(view); assert.ok(preview); assert.match(clean(content(preview)), /Recovered team 2|Game in progress|Question cards/); assert.doesNotMatch(clean(content(preview)), /Restored private question|Restored right choice|Synthetic classroom source|Synthetic explanation/);
  view.click('Restore this game'); assert.deepEqual(view.state(), backup.state); assert.equal(view.randomCalls(), 0); assert.equal(view.timers.size, 0); assert.equal(view.data.get(`${quest.QUESTION_QUEST_STORAGE_KEY}:previous`), originalRaw); assert.equal(view.data.get(`${questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY}:previous`), sourceRaw);
  assert.deepEqual(questionSources.loadQuestQuestionSources({ getItem: key => view.data.get(key) ?? null }, view.state()).sources, backup.sources);
  view.click('Minimize question and show board'); view.click('Save previous game backup ↓'); assert.equal(view.exportedBackups.length, 1); assert.deepEqual(gameBackup.parseQuestGameBackup(new TextEncoder().encode(view.exportedBackups[0].contents)), { state: original, sources: originalSources }); view.unmount();
});

test('canceling or invalidating a restore preview prevents retained confirmations from replacing the game', async () => {
  for (const mode of ['cancel', 'draft', 'teams']) {
    const view = mount({ state: authored(), standalone: true }); view.selectFile(backupFile(), 'quest-game-backup-file'); await view.settle(); const restore = view.button('Restore this game')!.props.onClick;
    if (mode === 'cancel') view.click('Cancel restore');
    if (mode === 'draft') view.change('quest-question-prompt', 'Keep this unsaved card?');
    if (mode === 'teams') view.click('Set up teams →');
    const before = quest.serializeQuestionQuest(view.state()); view.invoke(restore); assert.equal(quest.serializeQuestionQuest(view.state()), before); assert.equal(restorePreview(view), undefined); view.unmount();
  }
});

test('backup reads cannot survive newer files, manual drafts, state changes, reset or unmount', async () => {
  for (const mode of ['file', 'draft', 'teams', 'preset', 'reset', 'unmount']) {
    const view = mount({ state: authored(), standalone: true }), pending = delayedFile('older-game.json'); view.selectFile(pending.file, 'quest-game-backup-file');
    if (mode === 'file') { const newer = offlineBackupFixture(); newer.state.id = 'newer-game'; view.selectFile(backupFile(newer), 'quest-game-backup-file'); await view.settle(); }
    if (mode === 'draft') view.change('quest-source-url', citationFixture.url);
    if (mode === 'teams') view.click('Set up teams →');
    if (mode === 'preset') view.click("Use Gracie's Questions");
    if (mode === 'reset') { view.click('New game'); view.click('Start new game'); }
    if (mode === 'unmount') view.unmount();
    const before = quest.serializeQuestionQuest(view.state()), writes = view.writes.length; pending.resolve(gameBackup.serializeQuestGameBackup(offlineBackupFixture().state, offlineBackupFixture().sources)); await view.settle();
    assert.equal(quest.serializeQuestionQuest(view.state()), before, mode); assert.equal(view.writes.length, writes, mode); assert.equal(view.lateSetters(), 0, mode);
    if (mode === 'file') { assert.ok(restorePreview(view)); view.click('Restore this game'); assert.equal(view.state().id, 'newer-game'); } else assert.equal(restorePreview(view), undefined, mode);
    if (mode !== 'unmount') view.unmount();
  }
});

test('a restore cannot replace a roll after reading begins or while an animation is locked', async () => {
  for (const mode of ['reading', 'preview']) {
    const pendingTurn = quest.answerQuestCard(quest.drawQuestCard(active(), () => 0), 0), view = mount({ state: pendingTurn, standalone: true }), pendingFile = delayedFile('restored-game.json');
    let retainedRestore: (() => void) | undefined;
    if (mode === 'reading') view.selectFile(pendingFile.file, 'quest-game-backup-file');
    else { view.selectFile(backupFile(), 'quest-game-backup-file'); await view.settle(); retainedRestore = view.button('Restore this game')!.props.onClick; }
    view.click('Roll two dice →'); const acceptedRoll = quest.serializeQuestionQuest(view.state());
    if (mode === 'reading') pendingFile.resolve(gameBackup.serializeQuestGameBackup(offlineBackupFixture().state, offlineBackupFixture().sources)); else view.invoke(retainedRestore!);
    await view.settle(); assert.equal(quest.serializeQuestionQuest(view.state()), acceptedRoll); assert.equal(restorePreview(view), undefined); assert.equal(view.field('quest-game-backup-file')!.props.disabled, true); view.advance(6000); assert.equal(view.state().id, pendingTurn.id); view.unmount();
  }
});

test('invalid and oversized game backup files never change the current match or its sources', async () => {
  const original = authored(), view = mount({ state: original, sources: sourceMapFor(original), standalone: true }), before = view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), sourcesBefore = view.data.get(questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY); let readCalls = 0;
  for (const file of [localFile('{broken', 'bad.json'), localFile(importText(), 'questions.txt'), { name: 'huge.json', size: gameBackup.QUEST_GAME_BACKUP_MAX_BYTES + 1, arrayBuffer: async () => { readCalls++; return new ArrayBuffer(0); } }]) {
    view.selectFile(file, 'quest-game-backup-file'); await view.settle(); assert.equal(restorePreview(view), undefined); assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), before); assert.equal(view.data.get(questionSources.QUEST_QUESTION_SOURCES_STORAGE_KEY), sourcesBefore); assert.ok(view.all().some(element => element.props.role === 'alert'));
  }
  assert.equal(readCalls, 0); view.unmount();
});

test('standalone starts playable without browser storage and can load, restore and export while preserving inaccessible saves', async () => {
  for (const mode of ['readFails', 'storageAccessFails'] as const) {
    const original = quest.serializeQuestionQuest(active()), view = mount({ raw: original, standalone: true, [mode]: true });
    assert.doesNotMatch(view.text(), /Saved game unavailable/); assert.match(view.text(), /Create the question bank|Browser saving is unavailable/); assert.equal(view.button("Use Gracie's Questions")!.props.disabled, false);
    view.click("Use Gracie's Questions"); assert.equal(view.state().questions.length, gracieQuestions.GRACIE_QUESTION_PRESET.questions.length); assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), original); assert.equal(view.writes.length, 0);
    view.click('Save game backup ↓'); assert.equal(gameBackup.parseQuestGameBackup(new TextEncoder().encode(view.exportedBackups[0].contents)).state.questions.length, gracieQuestions.GRACIE_QUESTION_PRESET.questions.length);
    const backup = offlineBackupFixture(); view.selectFile(backupFile(backup), 'quest-game-backup-file'); await view.settle(); view.click('Restore this game'); assert.deepEqual(view.state(), backup.state); assert.match(view.text(), /This browser could not save it|Save a game backup before closing/); assert.equal(view.data.get(quest.QUESTION_QUEST_STORAGE_KEY), original); assert.equal(view.writes.length, 0); view.unmount();
  }
});

test('standalone uses secure UUID fallback when file pages do not expose randomUUID', () => {
  const view = mount({ standalone: true, noRandomUUID: true }); view.click("Use Gracie's Questions"); assert.equal(view.state().questions.length, gracieQuestions.GRACIE_QUESTION_PRESET.questions.length); assert.equal(new Set(view.state().questions.map(question => question.id)).size, view.state().questions.length); assert.ok(view.state().questions.every(question => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(question.id))); view.unmount();
});
