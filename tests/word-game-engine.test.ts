import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWordGameEngine } from '../src/lib/word-game-engine.ts';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';
import { validateGameSpec } from '../src/lib/game-design.ts';
import type { CrosswordSpec, WordSearchSpec } from '../src/lib/game-types.ts';

const engine = createWordGameEngine();
test('crosswords preserve every clue and word, cross perpendicularly, and have no side adjacency', () => {
  for (const topic of ['nature', 'space', 'animals', 'garden', 'science']) for (const seed of [1, 17031, 2147483647]) {
    const spec = defaultWordGameSpec('crossword', topic) as CrosswordSpec; spec.puzzle.seed = seed;
    const layout = engine.crossword(spec); assert.deepEqual(layout, engine.crossword(spec)); assert.equal(layout.size, 25);
    assert.deepEqual(layout.entries.map(({ answer, clue }) => ({ answer, clue })), spec.puzzle.entries);
    const cells = new Map<string, { letter: string; directions: string[] }>();
    for (const entry of layout.entries) {
      assert.ok(entry.row >= 0 && entry.col >= 0); assert.ok(entry.row + (entry.direction === 'down' ? entry.answer.length : 1) <= 25); assert.ok(entry.col + (entry.direction === 'across' ? entry.answer.length : 1) <= 25);
      [...entry.answer].forEach((letter, k) => { const r = entry.row + (entry.direction === 'down' ? k : 0), c = entry.col + (entry.direction === 'across' ? k : 0), key = `${r},${c}`, previous = cells.get(key); if (previous) { assert.equal(previous.letter, letter); assert.ok(!previous.directions.includes(entry.direction)); previous.directions.push(entry.direction); } else cells.set(key, { letter, directions: [entry.direction] }); assert.equal(layout.grid[r][c], letter); });
    }
    assert.ok([...cells.values()].some(cell => cell.directions.length === 2));
    const visited = new Set<number>([0]);
    while (true) { const previousSize = visited.size; layout.entries.forEach((entry, index) => { if ([...visited].some(otherIndex => { const other = layout.entries[otherIndex]; return entry.direction !== other.direction && [...entry.answer].some((_, k) => { const r = entry.row + (entry.direction === 'down' ? k : 0), c = entry.col + (entry.direction === 'across' ? k : 0); return other.direction === 'across' ? r === other.row && c >= other.col && c < other.col + other.answer.length : c === other.col && r >= other.row && r < other.row + other.answer.length; }); })) visited.add(index); }); if (visited.size === previousSize) break; }
    assert.equal(visited.size, layout.entries.length);
    for (const entry of layout.entries) [...entry.answer].forEach((_, k) => {
      const r = entry.row + (entry.direction === 'down' ? k : 0), c = entry.col + (entry.direction === 'across' ? k : 0), cell = cells.get(`${r},${c}`)!;
      if (cell.directions.length === 1) for (const offset of [-1, 1]) assert.equal(cells.has(`${r + (entry.direction === 'across' ? offset : 0)},${c + (entry.direction === 'down' ? offset : 0)}`), false);
    });
  }
});
test('impossible vocabulary, duplicate answers, excess letters, and authored executable fields are rejected', () => {
  const spec = defaultWordGameSpec('crossword') as CrosswordSpec;
  for (const entries of [[{ answer: 'AAA', clue: 'One' }, { answer: 'BBB', clue: 'Two' }, { answer: 'CCC', clue: 'Three' }], [...spec.puzzle.entries, spec.puzzle.entries[0]], [{ answer: 'lowercase', clue: 'Wrong case' }, ...spec.puzzle.entries]]) assert.throws(() => engine.validate({ ...spec, puzzle: { ...spec.puzzle, entries } }));
  for (const value of [{ ...spec, script: 'hi' }, { ...spec, title: '<script>bad</script>' }, { ...spec, description: 'https://example.com' }, { ...spec, description: 'ftp://example.com' }, { ...spec, instructions: 'mailto:a@example.com' }, { ...spec, title: '\ud800' }, { ...spec, puzzle: { ...spec.puzzle, seed: true } }, { ...spec, puzzle: { ...spec.puzzle, entries: spec.puzzle.entries.map(entry => ({ ...entry, extra: 1 })) } }]) assert.throws(() => validateGameSpec(value));
  assert.doesNotThrow(() => validateGameSpec({ ...spec, title: 'Nature 🌱 puzzle' }));
});
test('bounded word search placement and fallback preserve all words across dense grids and seeds', () => {
  const words = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZABCD', 'EFGHIJKLMN', 'OPQRSTUVWX', 'YZABCDEFGH', 'IJKLMNOPQR', 'STUVWXYZAB', 'CDEFGHIJKL', 'MNOPQRSTUV'];
  for (const seed of [1, 2, 17031, 2147483647]) for (const allowBackwards of [false, true]) {
    const spec = engine.validate({ ...defaultWordGameSpec('word-search'), puzzle: { seed, size: 10, allowBackwards, words } }) as WordSearchSpec, layout = engine.wordSearch(spec);
    assert.deepEqual(layout, engine.wordSearch(spec)); assert.equal(layout.placements.length, words.length); assert.ok(layout.grid.every(row => row.length === 10 && row.every(letter => /^[A-Z]$/u.test(letter))));
    for (const p of layout.placements) assert.equal([...p.word].map((_, k) => layout.grid[p.row + p.dr * k][p.col + p.dc * k]).join(''), p.word);
  }
  assert.throws(() => engine.validate({ ...defaultWordGameSpec('word-search'), puzzle: { seed: 1, size: 10, allowBackwards: false, words: [...words, 'EXTRA'] } }));
});
test('Mad Libs validates all declarations and repeated tokens and renders only plain entered values', () => {
  const spec = defaultWordGameSpec('mad-libs'); assert.equal(spec.genre, 'mad-libs'); if (spec.genre !== 'mad-libs') return;
  const result = engine.story(spec, { 'blank-1': 'silly', 'blank-2': 'pencil', 'blank-3': 'dance' }); assert.equal((result.match(/silly/gu) || []).length, 2); assert.doesNotMatch(result, /\{\{/u);
  for (const template of ['No tokens here.', '{{blank-12}}', '{{blank-1}} {{evil}}', '{{blank-1}}']) assert.throws(() => engine.validate({ ...spec, puzzle: { ...spec.puzzle, template } }));
  for (const answer of ['', '<img>', 'https://example.com', 'fetch(secret)', '\udfff']) assert.throws(() => engine.story(spec, { 'blank-1': answer, 'blank-2': 'pencil', 'blank-3': 'dance' }));
});
test('crossword work is globally bounded even when a nearly complete vocabulary cannot finish', () => {
  const words = ['APPLE', 'PEAR', 'GRAPE', 'ORANGE', 'MELON', 'PLUM', 'PEACH', 'LEMON', 'LIME', 'MANGO', 'PAPAYA', 'CHERRY', 'BANANA', 'APRICOT', 'COCONUT', 'ZZ'];
  assert.equal(engine.crosswordWorkLimit, 2000000);
  const spec = { ...defaultWordGameSpec('crossword'), puzzle: { seed: 1, entries: words.map(answer => ({ answer, clue: 'Test' })) } };
  assert.throws(() => engine.validate(spec), /reached its work limit/u);
  spec.puzzle.entries[15].answer = 'DATE'; assert.equal((engine.validate(spec) as CrosswordSpec).puzzle.entries.length, 16);
});
