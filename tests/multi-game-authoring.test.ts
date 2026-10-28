import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MultiGameEditor, multiGamePalette, multiGameStarter, moveMultiStep, copyLibraryGameSpec, eligibleLibraryGame } from '../src/components/MultiGameEditor';
import { gameFormatStarters, formatCreationPrompt } from '../src/components/WordGameEditor';
import { defaultMultiGameSpec, validateMultiGameSpec } from '../src/lib/multi-game';
import { defaultWordGameSpec } from '../src/lib/word-game-design';
import { createPlatformerSpec } from '../src/lib/game-flow';
import { isEndlessAsteroids, type Game, type MultiGameStep } from '../src/lib/game-types';

const render = (spec = defaultMultiGameSpec()) => renderToStaticMarkup(createElement(MultiGameEditor, { spec, library: [], disabled: false, dirty: false, revision: 0, onChange() {}, save() {} }));
test('multi-game is a neutral distinct starter and every palette game creates a valid journey', () => {
  const starter = gameFormatStarters.find(item => item.id === 'multi-game'); assert.ok(starter);
  assert.equal(starter.label, 'Multi-game'); assert.match(formatCreationPrompt(starter.id, starter.example), /^Create a multi-game journey\./);
  assert.doesNotMatch(starter.description + starter.example, /educat|teacher|lesson|student|assign|learn|class/i);
  for (const item of multiGamePalette.filter(item => !['content', 'video', 'interactive'].includes(item.type))) {
    const child = multiGameStarter(item.type as Parameters<typeof multiGameStarter>[0]), spec = defaultMultiGameSpec();
    spec.steps.push(item.type === 'free-play' ? { id: 'step-3', type: 'free-play', spec: child as any } : { id: 'step-3', type: 'game', spec: child });
    validateMultiGameSpec(spec);
    assert.equal(isEndlessAsteroids(child), item.type === 'free-play');
  }
});

test('the stack editor exposes object hooks, independent copy, keyboard ordering, and completion before free play', () => {
  const markup = render();
  for (const expected of ['Your multi-game journey.', 'Ordered multi-game journey', 'Client object', 'Interactive object', 'Free play ending', 'Copy an existing game', 'Add independent copy', 'Move step 1 later', 'Save multi-game journey', 'The journey completes after the finite steps', 'Free play points stay separate']) assert.ok(markup.includes(expected), expected);
  assert.match(markup, /draggable="true"/); assert.doesNotMatch(markup, /assignment|teacher|student|lesson|NCAcademy|educational/i);
  const spec = defaultMultiGameSpec(); spec.steps[0] = { id: 'step-1', type: 'game', spec: createPlatformerSpec() };
  const platformMarkup = render(spec);
  assert.ok(platformMarkup.includes('Your game flow.')); assert.ok(platformMarkup.includes('Client object')); assert.doesNotMatch(platformMarkup, /assignment|teacher|student|lesson|NCAcademy|educational/i);
});

test('free play cannot move before completion or be crossed by other reordered steps', () => {
  const spec = defaultMultiGameSpec(), ending: MultiGameStep = { id: 'step-4', type: 'free-play', spec: multiGameStarter('free-play') as any };
  const material: MultiGameStep = { id: 'step-3', type: 'material', title: 'Client content', kind: 'content', reference: 'client:object-3', required: true };
  const steps = [...spec.steps, material, ending], before = structuredClone(steps);
  assert.deepEqual(moveMultiStep(steps, ending.id, 0), before);
  const moved = moveMultiStep(steps, steps[0].id, 99);
  assert.equal(moved.at(-1)?.id, ending.id); assert.equal(moved.at(-2)?.id, steps[0].id);
  assert.deepEqual(steps, before); validateMultiGameSpec({ ...spec, steps: moved });
  const first = moveMultiStep(steps, material.id, 0); assert.equal(first[0].id, material.id); assert.deepEqual(first.at(-1), ending);
});

test('library insertion deeply copies authored puzzles and level flows without changing source games', () => {
  const source = createPlatformerSpec(); source.flow = { version: 1, nodes: source.levels!.map((level, index) => ({ id: `step-${index + 1}`, type: 'level', levelId: level.id })) };
  const before = structuredClone(source), one = copyLibraryGameSpec(source), two = copyLibraryGameSpec(source);
  assert.equal(one.version, 7); if (one.version === 3 || two.version === 3) throw new Error('Arcade expected');
  one.levels![0].title = 'Only this journey copy'; one.flow!.nodes.reverse();
  assert.deepEqual(source, before); assert.deepEqual(two, before);
  const puzzle = defaultWordGameSpec(), copied = copyLibraryGameSpec(puzzle); if (puzzle.genre !== 'crossword' || copied.version !== 3 || copied.genre !== 'crossword') throw new Error('Crossword expected');
  copied.puzzle.entries[0].clue = 'Changed clue'; assert.notEqual(puzzle.puzzle.entries[0].clue, copied.puzzle.entries[0].clue);
  assert.equal(eligibleLibraryGame(defaultMultiGameSpec()), false); assert.throws(() => copyLibraryGameSpec(defaultMultiGameSpec()));
  const endless = multiGameStarter('free-play'); assert.equal(eligibleLibraryGame(endless), false); assert.equal(eligibleLibraryGame(endless, true), true); assert.throws(() => copyLibraryGameSpec(endless));
  assert.throws(() => copyLibraryGameSpec(puzzle, true));
});

test('incomplete selected-step fields stay editable while explicit save rejects them', () => {
  const spec = defaultMultiGameSpec(); spec.title = ''; spec.steps.unshift({ id: 'step-3', type: 'material', title: '', kind: 'video', reference: '', required: true });
  assert.throws(() => validateMultiGameSpec(spec)); assert.doesNotThrow(() => render(spec));
});


test('advanced Asteroids keeps its supported shooting mechanic while the outer builder locks continuous mode', () => {
  const spec = defaultMultiGameSpec(); spec.steps[0] = { id: 'step-1', type: 'game', spec: multiGameStarter('asteroids') };
  const markup = render(spec);
  assert.match(markup, /disabled=""[^>]*checked=""[^>]*\/>Shoot asteroids/);
  assert.doesNotMatch(markup, /Endless survival<\/label>/);
  assert.ok(markup.includes('This step stays finite.'));
});
