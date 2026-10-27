import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WordGameEditor, formatCreationPrompt, gameFormatStarters, wordGameSummary } from '../src/components/WordGameEditor.tsx';
import { defaultWordGameSpec, designWordGame } from '../src/lib/word-game-design.ts';
import type { WordGenre } from '../src/lib/game-types.ts';

const render = (genre: WordGenre, disabled = false, dirty = true) => renderToStaticMarkup(createElement(WordGameEditor, { spec: defaultWordGameSpec(genre, 'space'), disabled, dirty, revision: 2, change: () => {}, save: () => {} }));

test('explicit format starters preserve field-based conversation input on separate lines', () => {
  assert.deepEqual(gameFormatStarters.map(format => format.id), ['arcade', 'crossword', 'word-search', 'mad-libs']);
  const idea = 'Entries: MOON | A natural satellite; MARS | The red planet; STAR | A glowing ball of gas';
  const message = formatCreationPrompt('crossword', idea);
  assert.match(message, /^Create a Crossword game\.\nEntries:/u);
  const designed = designWordGame(message).spec;
  assert.equal(designed.genre, 'crossword');
  if (designed.genre === 'crossword') assert.deepEqual(designed.puzzle.entries.map(entry => entry.answer), ['MOON', 'MARS', 'STAR']);
  assert.equal(formatCreationPrompt('arcade', '  A pond adventure  '), 'A pond adventure');
});

test('crossword editing exposes authored answers, clues and repeatable layout only', () => {
  const html = render('crossword');
  assert.match(html, /Answers &amp; clues/u); assert.match(html, /Answer 1/u); assert.match(html, /Clue 1/u);
  assert.match(html, /Layout seed/u); assert.match(html, /Shuffle puzzle layout/u); assert.match(html, /Save puzzle changes/u);
  for (const arcadeControl of ['Player color', 'Movement speed', 'Time limit', 'Lives', 'High scores', 'Add a level']) assert.ok(!html.includes(arcadeControl), arcadeControl);
});

test('word search editing exposes exact grid bounds and backwards selection', () => {
  const html = render('word-search');
  assert.match(html, /Grid size/u); assert.match(html, /Allow backwards words/u); assert.match(html, /Word 1/u);
  assert.match(html, /value="10"/u); assert.match(html, /value="24"/u); assert.doesNotMatch(html, /value="25"/u);
  assert.match(wordGameSummary(defaultWordGameSpec('word-search')), /words · 12 × 12/u);
});

test('Mad Libs editor supports template tokens and named prompts without a grid or arcade fields', () => {
  const html = render('mad-libs');
  assert.match(html, /Story text/u); assert.match(html, /Prompt 1/u); assert.match(html, /\{\{blank-1\}\}/u);
  assert.match(html, /Insert in story/u); assert.match(html, /Add word prompt/u);
  for (const unrelated of ['Layout seed', 'Grid size', 'Movement speed', 'Lives', 'Time limit']) assert.ok(!html.includes(unrelated), unrelated);
});

test('creation pause disables direct puzzle editing and save; saved drafts cannot save unchanged content', () => {
  assert.match(render('crossword', true), /<fieldset disabled=""/u);
  assert.match(render('crossword', true), /<button class="button secondary" disabled="">Save puzzle changes/u);
  assert.match(render('mad-libs', false, false), /<button class="button secondary" disabled="">Save puzzle changes/u);
});
