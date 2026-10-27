import type { CrosswordSpec, MadLibsSpec, WordGameSpec, WordSearchSpec } from './game-types';

export type CrosswordPlacement = { answer: string; clue: string; row: number; col: number; direction: 'across' | 'down'; number: number };
export type CrosswordLayout = { size: number; grid: string[][]; entries: CrosswordPlacement[] };
export type WordSearchPlacement = { word: string; row: number; col: number; dr: number; dc: number };
export type WordSearchLayout = { size: number; grid: string[][]; placements: WordSearchPlacement[] };

/** Pure, bounded, self-contained factory. The sandbox runs this exact tested code. */
export function createWordGameEngine() {
  function object(input: unknown, keys: string[], label: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error(`${label} must be an object.`);
    const value = input as Record<string, unknown>;
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} has missing or unexpected fields.`);
    return value;
  }
  function text(input: unknown, max: number, label: string, empty = false): string {
    if (typeof input !== 'string' || (!empty && !input.trim()) || input !== input.trim() || input.length > max || /[\uD800-\uDFFF]/u.test(input) || /[\u0000-\u001f\u007f-\u009f]/u.test(input) || /[<>]|(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:javascript|data|vbscript|mailto|file|tel)\s*:)|\b(?:eval|fetch|import)\s*\(/iu.test(input)) throw new Error(`${label} must be plain text up to ${max} characters, without links or code.`);
    return input;
  }
  function integer(input: unknown, min: number, max: number, label: string): number {
    if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    return input;
  }
  function word(input: unknown): string {
    if (typeof input !== 'string' || !/^[A-Z]{2,18}$/u.test(input)) throw new Error('Words must use 2 to 18 uppercase ASCII letters.');
    return input;
  }
  function crossword(spec: CrosswordSpec): CrosswordLayout {
    const size = 25, grid = Array.from({ length: size }, () => Array<string>(size).fill('')), masks = Array.from({ length: size }, () => Array<number>(size).fill(0));
    type Place = Omit<CrosswordPlacement, 'number'> & { index: number; crossings: number; rank: number };
    const placed: Place[] = [], entries = spec.puzzle.entries;
    const root = entries.map((_, index) => index).sort((a, b) => entries[b].answer.length - entries[a].answer.length || a - b)[0];
    let nodes = 0, work = 0;
    function tick() { if (++work > 2000000) throw new Error('Crossword layout search reached its work limit. Edit the vocabulary or seed; every word must fit.'); }
    const inside = (r: number, c: number) => r >= 0 && r < size && c >= 0 && c < size;
    const occupied = (r: number, c: number) => inside(r, c) && Boolean(grid[r][c]);
    function candidate(index: number, row: number, col: number, direction: 'across' | 'down'): Place | undefined {
      const { answer, clue } = entries[index], dr = direction === 'down' ? 1 : 0, dc = 1 - dr, bit = dr ? 2 : 1;
      if (!inside(row, col) || !inside(row + dr * (answer.length - 1), col + dc * (answer.length - 1)) || occupied(row - dr, col - dc) || occupied(row + dr * answer.length, col + dc * answer.length)) return;
      let crossings = 0;
      for (let k = 0; k < answer.length; k++) {
        tick();
        const r = row + dr * k, c = col + dc * k;
        if (grid[r][c]) { if (grid[r][c] !== answer[k] || masks[r][c] & bit) return; crossings++; }
        else if (occupied(r - dc, c - dr) || occupied(r + dc, c + dr)) return;
      }
      if (placed.length && !crossings) return;
      const rank = (spec.puzzle.seed ^ Math.imul(row + 1, 73856093) ^ Math.imul(col + 1, 19349663) ^ Math.imul(index + 1, 83492791) ^ (dr ? 2654435761 : 0)) >>> 0;
      return { answer, clue, row, col, direction, index, crossings, rank };
    }
    function apply(p: Place, remove = false) {
      const dr = p.direction === 'down' ? 1 : 0, dc = 1 - dr, bit = dr ? 2 : 1;
      for (let k = 0; k < p.answer.length; k++) {
        const r = p.row + dr * k, c = p.col + dc * k;
        masks[r][c] = remove ? masks[r][c] & ~bit : masks[r][c] | bit;
        grid[r][c] = masks[r][c] ? p.answer[k] : '';
      }
    }
    function candidates(index: number): Place[] {
      const list: Place[] = [], seen = new Set<string>(), answer = entries[index].answer;
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        tick();
        if (!grid[r][c]) continue;
        for (let k = 0; k < answer.length; k++) {
          tick();
          if (answer[k] !== grid[r][c]) continue;
          for (const direction of ['across', 'down'] as const) {
          const row = r - (direction === 'down' ? k : 0), col = c - (direction === 'across' ? k : 0), key = `${row},${col},${direction}`;
          if (seen.has(key)) continue;
          seen.add(key); const p = candidate(index, row, col, direction); if (p) list.push(p);
          }
        }
      }
      return list.sort((a, b) => b.crossings - a.crossings || a.rank - b.rank || a.row - b.row || a.col - b.col || (a.direction === b.direction ? 0 : a.direction === 'across' ? -1 : 1)).slice(0, 48);
    }
    function search(): boolean {
      if (placed.length === entries.length) return true;
      if (nodes >= 2000) return false;
      const choices = entries.map((_, index) => ({ index, list: placed.some(p => p.index === index) ? [] : candidates(index) })).filter(choice => choice.list.length).sort((a, b) => a.list.length - b.list.length || entries[b.index].answer.length - entries[a.index].answer.length || a.index - b.index);
      for (const choice of choices) for (const p of choice.list) {
        if (++nodes > 2000) return false;
        apply(p); placed.push(p);
        if (search()) return true;
        placed.pop(); apply(p, true);
      }
      return false;
    }
    const first = candidate(root, 12, Math.floor((size - entries[root].answer.length) / 2), 'across')!;
    apply(first); placed.push(first);
    if (!search()) throw new Error('These words could not form a connected crossword within the fixed 25 by 25 layout. Edit the vocabulary or seed; every word must fit.');
    const starts = [...new Set(placed.map(p => p.row * size + p.col))].sort((a, b) => a - b);
    return { size, grid, entries: placed.slice().sort((a, b) => a.index - b.index).map(p => ({ answer: p.answer, clue: p.clue, row: p.row, col: p.col, direction: p.direction, number: starts.indexOf(p.row * size + p.col) + 1 })) };
  }
  function wordSearch(spec: WordSearchSpec): WordSearchLayout {
    const { size, words, allowBackwards } = spec.puzzle;
    let seed = spec.puzzle.seed >>> 0, grid = Array.from({ length: size }, () => Array<string>(size).fill('')), placements: WordSearchPlacement[] = [];
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const dirs = [[0, 1], [1, 0], [1, 1], [-1, 1], ...(allowBackwards ? [[0, -1], [-1, 0], [-1, -1], [1, -1]] : [])];
    const ordered = words.map((word, index) => ({ word, index })).sort((a, b) => b.word.length - a.word.length || a.index - b.index);
    for (const { word } of ordered) {
      let found = false;
      for (let attempt = 0; attempt < 240; attempt++) {
        const [dr, dc] = dirs[Math.floor(random() * dirs.length)], row = Math.floor(random() * size), col = Math.floor(random() * size);
        if (row + dr * (word.length - 1) < 0 || row + dr * (word.length - 1) >= size || col + dc * (word.length - 1) < 0 || col + dc * (word.length - 1) >= size) continue;
        if ([...word].some((letter, k) => grid[row + dr * k][col + dc * k] && grid[row + dr * k][col + dc * k] !== letter)) continue;
        [...word].forEach((letter, k) => { grid[row + dr * k][col + dc * k] = letter; }); placements.push({ word, row, col, dr, dc }); found = true; break;
      }
      if (!found) { placements = []; break; }
    }
    // A separate horizontal row per word guarantees the complete accepted vocabulary.
    if (placements.length !== words.length) {
      seed = spec.puzzle.seed >>> 0; grid = Array.from({ length: size }, () => Array<string>(size).fill('')); placements = [];
      words.forEach((word, row) => { const col = Math.floor(random() * (size - word.length + 1)); [...word].forEach((letter, k) => { grid[row][col + k] = letter; }); placements.push({ word, row, col, dr: 0, dc: 1 }); });
    }
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!grid[r][c]) grid[r][c] = String.fromCharCode(65 + Math.floor(random() * 26));
    return { size, grid, placements };
  }
  function validate(input: unknown): WordGameSpec {
    const data = object(input, ['version', 'title', 'description', 'genre', 'instructions', 'puzzle'], 'Word game');
    if (data.version !== 3) throw new Error('Unsupported word game version.');
    const common = { version: 3 as const, title: text(data.title, 80, 'Title'), description: text(data.description, 300, 'Description', true), instructions: text(data.instructions, 300, 'Instructions', true) };
    if (data.genre === 'crossword') {
      const p = object(data.puzzle, ['seed', 'entries'], 'Crossword puzzle'), seed = integer(p.seed, 1, 2147483647, 'Layout seed');
      if (!Array.isArray(p.entries) || p.entries.length < 3 || p.entries.length > 16) throw new Error('A crossword needs 3 to 16 entries.');
      const entries = p.entries.map(input => { const e = object(input, ['answer', 'clue'], 'Crossword entry'); return { answer: word(e.answer), clue: text(e.clue, 140, 'Clue') }; });
      if (new Set(entries.map(e => e.answer)).size !== entries.length) throw new Error('Crossword answers must be unique.');
      if (entries.reduce((n, e) => n + e.answer.length, 0) > 200) throw new Error('Crossword answers must total at most 200 letters.');
      const spec: CrosswordSpec = { ...common, genre: 'crossword', puzzle: { seed, entries } }; crossword(spec); return spec;
    }
    if (data.genre === 'word-search') {
      const p = object(data.puzzle, ['seed', 'size', 'allowBackwards', 'words'], 'Word search puzzle'), seed = integer(p.seed, 1, 2147483647, 'Layout seed'), size = integer(p.size, 10, 24, 'Grid size');
      if (typeof p.allowBackwards !== 'boolean') throw new Error('Allow backwards must be true or false.');
      if (!Array.isArray(p.words) || p.words.length < 3 || p.words.length > 16 || p.words.length > size) throw new Error('A word search needs 3 to 16 words, with no more words than grid rows.');
      const words = p.words.map(word);
      if (new Set(words).size !== words.length) throw new Error('Word search words must be unique.');
      if (words.some(word => word.length > size)) throw new Error('Every word must fit the grid size.');
      return { ...common, genre: 'word-search', puzzle: { seed, size, allowBackwards: p.allowBackwards, words } };
    }
    if (data.genre === 'mad-libs') {
      const p = object(data.puzzle, ['template', 'blanks'], 'Mad Libs puzzle'), template = text(p.template, 2000, 'Template');
      if (!Array.isArray(p.blanks) || p.blanks.length < 1 || p.blanks.length > 12) throw new Error('A Mad Libs story needs 1 to 12 blanks.');
      const blanks = p.blanks.map(input => { const b = object(input, ['id', 'label'], 'Blank'); if (typeof b.id !== 'string' || !/^blank-(?:[1-9]|1[0-2])$/u.test(b.id)) throw new Error('Blank identifiers must be blank-1 through blank-12.'); return { id: b.id, label: text(b.label, 60, 'Blank label') }; });
      if (new Set(blanks.map(b => b.id)).size !== blanks.length) throw new Error('Blank identifiers must be unique.');
      const tokens = [...template.matchAll(/\{\{(blank-(?:[1-9]|1[0-2]))\}\}/gu)].map(m => m[1]);
      if (/[{}]/u.test(template.replace(/\{\{blank-(?:[1-9]|1[0-2])\}\}/gu, '')) || tokens.some(id => !blanks.some(b => b.id === id)) || blanks.some(b => !tokens.includes(b.id))) throw new Error('Use only declared {{blank-N}} tokens, and use every declared blank in the story.');
      return { ...common, genre: 'mad-libs', puzzle: { template, blanks } };
    }
    throw new Error('Choose crossword, word-search, or mad-libs.');
  }
  function story(spec: MadLibsSpec, answers: Record<string, string>): string {
    const clean: Record<string, string> = {};
    for (const blank of spec.puzzle.blanks) clean[blank.id] = text(answers[blank.id], 80, 'Answer');
    return spec.puzzle.template.replace(/\{\{(blank-(?:[1-9]|1[0-2]))\}\}/gu, (_, id: string) => clean[id]);
  }
  return { validate, crossword, wordSearch, story, crosswordWorkLimit: 2000000 };
}
