import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { designGame } from '../src/lib/game-design.ts';
import { defaultWordGameSpec, designWordGame, parseCrosswordEntries, parseMadLibBlanks, parseWordList } from '../src/lib/word-game-design.ts';
import { createWordGameEngine } from '../src/lib/word-game-engine.ts';
import type { WordGameSpec } from '../src/lib/game-types.ts';

test('free guided creation supports disclosed starters and explicit editable content', () => {
  for (const message of ['A crossword about space', 'Word search about plants', 'Mad Libs about animals']) { const result = designGame(message); assert.equal(result.spec.version, 3); assert.match(result.reply, /curated/u); assert.match(result.reply, /calls no AI model/u); }
  const unknown = designWordGame('A crossword about medieval pottery'); assert.match(unknown.reply, /arbitrary-topic content is not generated/u);
  assert.deepEqual(parseWordList('water, river; Rain'), ['WATER', 'RIVER', 'RAIN']);
  assert.deepEqual(parseCrosswordEntries('water | Wet stuff\nrain: From clouds'), [{ answer: 'WATER', clue: 'Wet stuff' }, { answer: 'RAIN', clue: 'From clouds' }]);
  assert.deepEqual(parseMadLibBlanks('blank-1 | adjective; blank-2: noun'), [{ id: 'blank-1', label: 'adjective' }, { id: 'blank-2', label: 'noun' }]);
  assert.throws(() => parseCrosswordEntries('missing clue'));
  const edited = designWordGame('Title: River hunt\nWords: WATER, RIVER, RAIN\nSize: 10\nBackwards: on', defaultWordGameSpec('word-search')).spec;
  assert.equal(edited.title, 'River hunt'); assert.equal(edited.genre, 'word-search'); if (edited.genre === 'word-search') { assert.equal(edited.puzzle.allowBackwards, true); assert.equal(edited.puzzle.size, 10); }
});
test('authored field values never switch genre or reset the saved topic', () => {
  const current = defaultWordGameSpec('word-search', 'space');
  const title = designGame('Title: Crossword hunt', current).spec; assert.equal(title.genre, 'word-search'); assert.equal(title.title, 'Crossword hunt'); assert.deepEqual(title.puzzle, current.puzzle);
  const described = designWordGame('Description: A crossword about garden plants', current).spec; assert.equal(described.genre, current.genre); assert.deepEqual(described.puzzle, current.puzzle);
  const configured = createWordGameEngine().validate({ ...current, puzzle: { ...current.puzzle, size: 18, allowBackwards: true } });
  for (const message of ['Title: Size 10 treasure hunt', 'Description: Backwards off in the title', 'Instructions: Find words on a grid 10 with no backwards surprises']) assert.deepEqual(designWordGame(message, configured).spec.puzzle, configured.puzzle);
  const story = designWordGame('Template: A crossword about garden plants made the {{blank-1}} carry a {{blank-2}} and {{blank-3}}.', defaultWordGameSpec('mad-libs', 'space')).spec; assert.equal(story.genre, 'mad-libs'); assert.equal(story.title, 'Space Mad Libs');
  const continued = designWordGame('Entries:\nWATER | A crossword about garden plants\nRIVER | A flowing stream\nRAIN | Falls from clouds', defaultWordGameSpec('crossword', 'space')).spec; assert.equal(continued.title, 'Space Crossword');
});
const python = `import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('word_parity',Path.cwd()/'backend/nce_api/word_games.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
data=json.load(sys.stdin)
out=[]
for c in data:
 try:
  if c['op']=='design': result=m.design_game(c['message'],c.get('current'))
  elif c['op']=='validate': result=m.validate_spec(c['spec'])
  elif c['op']=='crossword': result=m.crossword(c['spec'])
  else: result=m.word_search(c['spec'])
  out.append({'ok':result})
 except m.WordGameError as e: out.append({'error':str(e)})
print(json.dumps(out,ensure_ascii=False))`;
test('actual TypeScript and Python validators, layouts and guided edits have strict parity', () => {
  const engine = createWordGameEngine(), cases: Record<string, unknown>[] = [];
  for (const genre of ['crossword', 'word-search', 'mad-libs'] as const) for (const topic of ['nature', 'space', 'animals', 'garden', 'science']) {
    const spec = defaultWordGameSpec(genre, topic); cases.push({ op: 'validate', spec });
    if (spec.genre !== 'mad-libs') for (const seed of [1, 17031, 2147483647]) cases.push({ op: spec.genre === 'crossword' ? 'crossword' : 'wordSearch', spec: { ...spec, puzzle: { ...spec.puzzle, seed } } });
  }
  for (const message of ['\ud800', 'A crossword about space', 'Word search about medieval pottery', 'Mad Libs about animals', 'Title: Nature 🌱', 'Size: 24\nBackwards: true\nWords: WATER, RIVER, RAIN', 'Entries: WATER | Wet liquid; RIVER | Water flows here; RAIN | Falls from clouds', 'Template: The {{blank-1}} saw {{blank-2}}.\nBlanks: blank-1 | noun; blank-2 | animal']) cases.push({ op: 'design', message, current: message.startsWith('Size:') ? defaultWordGameSpec('word-search') : message.startsWith('Template:') ? defaultWordGameSpec('mad-libs') : undefined });
  for (const entry of [
    { message: 'Title: Crossword hunt', current: defaultWordGameSpec('word-search', 'space') },
    { message: 'Description: A crossword about garden plants', current: defaultWordGameSpec('word-search', 'space') },
    ...['Title: Size 10 treasure hunt', 'Description: Backwards off in the title', 'Instructions: Find words on a grid 10 with no backwards surprises'].map(message => ({ message, current: { ...defaultWordGameSpec('word-search', 'space'), puzzle: { seed: 17031, size: 18, allowBackwards: true, words: ['PLANET', 'STAR', 'ORBIT', 'MOON', 'COMET'] } } })),
    { message: 'Template: A crossword about garden plants made the {{blank-1}} carry a {{blank-2}} and {{blank-3}}.', current: defaultWordGameSpec('mad-libs', 'space') },
    { message: 'Entries:\nWATER | A crossword about garden plants\nRIVER | A flowing stream\nRAIN | Falls from clouds', current: defaultWordGameSpec('crossword', 'space') },
  ]) cases.push({ op: 'design', ...entry });
  const base = defaultWordGameSpec('crossword');
  for (const title of ['\ud800', '<script>', 'fetch(secret)', 'https://example.com', 'ftp://example.com', 'mailto:a@example.com', 'custom+tool://host', ' leading', 'x'.repeat(81), 'javaſcript:', 'data\ufeff:', 'fetch\u00a0(', '🌱'.repeat(41)]) cases.push({ op: 'validate', spec: { ...base, title } });
  cases.push({ op: 'validate', spec: { ...base, puzzle: { seed: 1, entries: [{ answer: 'AAA', clue: 'a' }, { answer: 'BBB', clue: 'b' }, { answer: 'CCC', clue: 'c' }] } } });
  cases.push({ op: 'validate', spec: { ...base, puzzle: { seed: 1, entries: ['APPLE', 'PEAR', 'GRAPE', 'ORANGE', 'MELON', 'PLUM', 'PEACH', 'LEMON', 'LIME', 'MANGO', 'PAPAYA', 'CHERRY', 'BANANA', 'APRICOT', 'COCONUT', 'ZZ'].map(answer => ({ answer, clue: 'Test' })) } } });
  for (const allowBackwards of [false, true]) cases.push({ op: 'wordSearch', spec: { ...defaultWordGameSpec('word-search'), puzzle: { seed: 1, size: 10, allowBackwards, words: ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZABCD', 'EFGHIJKLMN', 'OPQRSTUVWX', 'YZABCDEFGH', 'IJKLMNOPQR', 'STUVWXYZAB', 'CDEFGHIJKL', 'MNOPQRSTUV'] } } });
  const expected = cases.map(c => { try { const spec = c.spec as WordGameSpec; return { ok: c.op === 'design' ? designWordGame(c.message as string, c.current as WordGameSpec | undefined) : c.op === 'validate' ? engine.validate(spec) : c.op === 'crossword' && spec.genre === 'crossword' ? engine.crossword(spec) : spec.genre === 'word-search' ? engine.wordSearch(spec) : undefined }; } catch (error) { return { error: (error as Error).message }; } });
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
  cases.forEach((c, i) => assert.deepEqual(actual[i], expected[i], JSON.stringify(c)));
});
