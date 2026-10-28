import { installGameDisplayKeyboardBridge } from './game-runtime';
import { createWordGameEngine } from './word-game-engine';
import type { CrosswordLayout } from './word-game-engine';
import type { WordGameSpec } from './game-types';

/** Trusted fixed UI only; authored strings and player answers are assigned as text. */
export function startWordGameSandbox(engine: ReturnType<typeof createWordGameEngine>, nonce: string) {
  const title = document.getElementById('title')!, instruction = document.getElementById('instruction')!, play = document.getElementById('play')!, announce = document.getElementById('announce')!, restart = document.getElementById('restart') as HTMLButtonElement;
  let spec: WordGameSpec | undefined, started = 0, finished = false;
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', parent: HTMLElement = play): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  }
  function finish(outcome: 'won' | 'lost', score: number) {
    if (finished) return;
    const elapsed = (performance.now() - started) / 1000;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 86400) { announce.textContent = 'This play session has expired. Choose Restart puzzle for a fresh playtest.'; return; }
    finished = true;
    parent.postMessage({ type: 'axolotl-game-result', nonce, result: { outcome, score, elapsed, reviewedLevelIds: ['level-1'] } }, '*');
  }
  function crossword(current: Extract<WordGameSpec, { genre: 'crossword' }>) {
    const layout: CrosswordLayout = engine.crossword(current), inputs = new Map<string, HTMLInputElement>();
    const occupied = layout.grid.flatMap((row, r) => row.flatMap((letter, c) => letter ? [{ r, c }] : []));
    const minR = Math.min(...occupied.map(p => p.r)), maxR = Math.max(...occupied.map(p => p.r)), minC = Math.min(...occupied.map(p => p.c)), maxC = Math.max(...occupied.map(p => p.c));
    const wrap = el('div'); wrap.className = 'grid-scroll'; const board = el('div', '', wrap); board.className = 'crossword'; board.setAttribute('role', 'group'); board.setAttribute('aria-label', 'Crossword letter grid'); board.style.gridTemplateColumns = `repeat(${maxC - minC + 1}, minmax(30px, 1fr))`;
    let direction: 'across' | 'down' = 'across';
    function advance(r: number, c: number, dr: number, dc: number, skipBlocked = false) {
      for (let nr = r + dr, nc = c + dc; nr >= minR && nr <= maxR && nc >= minC && nc <= maxC; nr += dr, nc += dc) { const target = inputs.get(`${nr},${nc}`); if (target) { target.focus(); target.select(); return; } if (!skipBlocked) return; }
    }
    for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) {
      const cell = el('div', '', board); cell.className = 'crossword-cell';
      if (!layout.grid[r][c]) { cell.classList.add('blocked'); continue; }
      const start = layout.entries.find(entry => entry.row === r && entry.col === c); if (start) el('span', String(start.number), cell).className = 'cell-number';
      const clues = layout.entries.filter(entry => entry.direction === 'across' ? entry.row === r && c >= entry.col && c < entry.col + entry.answer.length : entry.col === c && r >= entry.row && r < entry.row + entry.answer.length);
      const input = el('input', '', cell); input.type = 'text'; input.maxLength = 1; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocapitalize', 'characters'); input.setAttribute('aria-label', `Row ${r - minR + 1}, column ${c - minC + 1}. ${clues.map(entry => `${entry.number} ${entry.direction}: ${entry.clue}`).join('. ')}`);
      inputs.set(`${r},${c}`, input);
      input.addEventListener('focus', () => { if (!clues.some(entry => entry.direction === direction)) direction = clues[0].direction; });
      input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z]/gu, '').slice(-1); input.removeAttribute('aria-invalid'); if (input.value) advance(r, c, direction === 'down' ? 1 : 0, direction === 'across' ? 1 : 0); });
      input.addEventListener('keydown', event => {
        const moves: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
        if (moves[event.key]) { event.preventDefault(); const [dr, dc] = moves[event.key]; direction = dr ? 'down' : 'across'; advance(r, c, dr, dc, true); }
        if (event.key === 'Backspace' && !input.value) advance(r, c, direction === 'down' ? -1 : 0, direction === 'across' ? -1 : 0);
      });
    }
    const clues = el('div'); clues.className = 'clues';
    for (const d of ['across', 'down'] as const) {
      const group = el('section', '', clues); el('h3', d === 'across' ? 'Across' : 'Down', group);
      for (const entry of layout.entries.filter(entry => entry.direction === d).sort((a, b) => a.number - b.number)) { const button = el('button', `${entry.number}. ${entry.clue} (${entry.answer.length})`, group); button.type = 'button'; button.className = 'clue'; button.addEventListener('click', () => { direction = d; inputs.get(`${entry.row},${entry.col}`)?.focus(); }); }
    }
    function solvedCount() { return layout.entries.filter(entry => [...entry.answer].every((letter, k) => inputs.get(`${entry.row + (entry.direction === 'down' ? k : 0)},${entry.col + (entry.direction === 'across' ? k : 0)}`)?.value === letter)).length; }
    const actions = el('div'); actions.className = 'actions'; const check = el('button', 'Check answers', actions), reveal = el('button', 'Reveal solution', actions);
    check.addEventListener('click', () => {
      let incorrect = 0;
      for (const [key, input] of inputs) { const [r, c] = key.split(',').map(Number), wrong = input.value !== layout.grid[r][c]; if (wrong) incorrect++; input.setAttribute('aria-invalid', String(wrong)); }
      const solved = solvedCount(); announce.textContent = incorrect ? `${solved} of ${layout.entries.length} words correct. ${incorrect} letters need attention.` : 'Crossword complete! Every answer is correct.';
      if (!incorrect) finish('won', solved);
    });
    reveal.addEventListener('click', () => { const solved = solvedCount(); for (const [key, input] of inputs) { const [r, c] = key.split(',').map(Number); input.value = layout.grid[r][c]; input.disabled = true; } check.disabled = true; reveal.disabled = true; announce.textContent = 'Solution revealed. This attempt is a revealed playtest. Restart to solve it yourself.'; finish('lost', solved); });
    announce.textContent = 'Choose an across or down clue, then type in the grid. Arrow keys move between letters.';
  }
  function wordSearch(current: Extract<WordGameSpec, { genre: 'word-search' }>) {
    const layout = engine.wordSearch(current), found = new Set<string>(), buttons: HTMLButtonElement[][] = [], list = new Map<string, HTMLLIElement>();
    el('p', 'Choose the first and last letter of a word. Drag across a word, tap two endpoints, or use arrows and Enter.');
    const wrap = el('div'); wrap.className = 'grid-scroll'; const board = el('div', '', wrap); board.className = 'word-search'; board.style.gridTemplateColumns = `repeat(${layout.size}, minmax(28px, 1fr))`; board.setAttribute('role', 'group'); board.setAttribute('aria-label', 'Word search letter grid');
    let start: [number, number] | undefined, pointerStart: [number, number] | undefined;
    function select(row: number, col: number) {
      if (!start) { start = [row, col]; buttons[row][col].classList.add('selected'); announce.textContent = `Start selected at row ${row + 1}, column ${col + 1}. Choose the last letter.`; return; }
      const [r, c] = start; start = undefined; buttons[r][c].classList.remove('selected');
      const distance = Math.max(Math.abs(row - r), Math.abs(col - c)), dr = Math.sign(row - r), dc = Math.sign(col - c);
      if (!distance || row !== r && col !== c && Math.abs(row - r) !== Math.abs(col - c)) { announce.textContent = 'Choose two different endpoints in a straight horizontal, vertical, or diagonal line.'; return; }
      const cells = Array.from({ length: distance + 1 }, (_, k) => [r + dr * k, c + dc * k]), letters = cells.map(([rr, cc]) => layout.grid[rr][cc]).join('');
      const word = current.puzzle.words.find(word => !found.has(word) && (word === letters || word === [...letters].reverse().join('')));
      if (!word) { announce.textContent = 'That selection is not an unfound word. Choose a new first letter.'; return; }
      found.add(word); cells.forEach(([rr, cc]) => buttons[rr][cc].classList.add('found')); list.get(word)!.textContent = `${word} — found`;
      announce.textContent = `${word} found. ${found.size} of ${current.puzzle.words.length} words found.`;
      if (found.size === current.puzzle.words.length) { announce.textContent = 'Word search complete! Every word found.'; finish('won', found.size); }
    }
    for (let r = 0; r < layout.size; r++) {
      buttons[r] = [];
      for (let c = 0; c < layout.size; c++) {
        const button = el('button', layout.grid[r][c], board); button.type = 'button'; button.dataset.row = String(r); button.dataset.col = String(c); button.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}: ${layout.grid[r][c]}`); buttons[r][c] = button;
        button.addEventListener('click', event => { if (event.detail === 0) select(r, c); });
        button.addEventListener('keydown', event => { const moves: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }; if (moves[event.key]) { event.preventDefault(); const [dr, dc] = moves[event.key]; buttons[Math.max(0, Math.min(layout.size - 1, r + dr))][Math.max(0, Math.min(layout.size - 1, c + dc))].focus(); } if (event.key === 'Escape' && start) { buttons[start[0]][start[1]].classList.remove('selected'); start = undefined; announce.textContent = 'Selection cleared.'; } });
      }
    }
    board.addEventListener('pointerdown', event => { const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-row]'); if (!target) return; event.preventDefault(); target.focus(); pointerStart = [Number(target.dataset.row), Number(target.dataset.col)]; });
    board.addEventListener('pointerup', event => {
      if (!pointerStart) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('button[data-row]');
      if (target && board.contains(target)) { const [r, c] = pointerStart, row = Number(target.dataset.row), col = Number(target.dataset.col); if (row !== r || col !== c) { if (start) buttons[start[0]][start[1]].classList.remove('selected'); start = undefined; select(r, c); select(row, col); } else select(row, col); }
      pointerStart = undefined;
    });
    board.addEventListener('pointercancel', () => { pointerStart = undefined; });
    el('h3', 'Words to find'); const ul = el('ul'); ul.className = 'word-list'; for (const word of current.puzzle.words) list.set(word, el('li', word, ul));
    announce.textContent = `${current.puzzle.words.length} words to find. ${current.puzzle.allowBackwards ? 'Words may be backwards.' : 'Words run forward horizontally, vertically, or diagonally.'}`;
  }
  function madLibs(current: Extract<WordGameSpec, { genre: 'mad-libs' }>) {
    el('p', 'Fill the prompts first. The story appears after every prompt is complete. Your words stay in this player.');
    // This is deliberately a prompt group: native form submission is blocked by
    // the opaque sandbox and form-action CSP, even before a submit handler runs.
    const prompts = el('div'), fields = new Map<string, HTMLInputElement>();
    prompts.setAttribute('role', 'group'); prompts.setAttribute('aria-label', 'Story prompts');
    for (const blank of current.puzzle.blanks) { const label = el('label', blank.label, prompts); label.className = 'prompt'; const input = el('input', '', label); input.type = 'text'; input.required = true; input.maxLength = 80; input.autocomplete = 'off'; fields.set(blank.id, input); }
    const reveal = el('button', 'Reveal my story', prompts); reveal.type = 'button';
    function revealStory() {
      if (prompts.hidden) return;
      try { const story = engine.story(current, Object.fromEntries([...fields].map(([id, input]) => [id, input.value.trim()]))); prompts.hidden = true; el('h3', 'Your story'); el('p', story).className = 'story'; announce.textContent = 'Story complete! Restart to try different words.'; finish('won', current.puzzle.blanks.length); }
      catch (error) { announce.textContent = error instanceof Error ? error.message : 'Fill every prompt using short, plain text.'; }
    }
    reveal.addEventListener('click', revealStory);
    prompts.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); revealStory(); } });
    announce.textContent = 'Your story is waiting. Fill every prompt, then reveal it.';
  }
  function render() {
    if (!spec) return;
    play.replaceChildren(); title.textContent = spec.title; instruction.textContent = spec.instructions; started = performance.now(); finished = false;
    if (spec.genre === 'crossword') crossword(spec); else if (spec.genre === 'word-search') wordSearch(spec); else madLibs(spec);
  }
  restart.addEventListener('click', render);
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || Array.isArray(event.data) || event.data.type !== 'axolotl-game-load' || event.data.nonce !== nonce || spec || Object.keys(event.data).some(key => !['type', 'nonce', 'spec', 'levelId'].includes(key))) return;
    try { if (event.data.levelId && event.data.levelId !== 'level-1') throw new Error('Choose the puzzle in this game.'); spec = engine.validate(event.data.spec); render(); parent.postMessage({ type: 'axolotl-game-loaded', nonce }, '*'); }
    catch { announce.textContent = 'This word game could not be loaded safely.'; }
  });
  parent.postMessage({ type: 'axolotl-game-ready', nonce }, '*');
}
export function wordGameSandboxDocument(nonce: string): string {
  if (!/^[a-zA-Z0-9_-]{16,100}$/u.test(nonce)) throw new Error('A safe random game nonce is required.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'"><style>
*{box-sizing:border-box}body{margin:0;background:#fffaf0;color:#254e45;font:16px/1.5 system-ui,sans-serif}main{padding:16px;max-width:1100px;margin:auto}h2{margin:0;font-size:23px}h3{font-size:17px;margin:14px 0 7px}p{margin:10px 0}button,input{font:inherit;color:inherit}button{min-height:44px;padding:8px 14px;border:1px solid #628175;border-radius:8px;background:#fff;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #a94c7b;outline-offset:2px}button:disabled{opacity:.6;cursor:default}.grid-scroll{overflow:auto;padding:4px;margin:12px 0}.crossword,.word-search{display:grid;gap:1px;background:#648074;border:2px solid #648074;width:max-content;min-width:min(100%,450px);max-width:100%}.crossword-cell{position:relative;background:#fff;min-width:30px;height:38px}.crossword-cell.blocked{background:#254e45}.crossword-cell input{width:100%;height:100%;padding:8px 0 0;border:0;text-align:center;text-transform:uppercase;background:#fff}.crossword-cell input[aria-invalid=true]{background:#ffe0dc}.cell-number{position:absolute;top:0;left:2px;font-size:10px;line-height:12px;pointer-events:none}.clues{display:flex;gap:24px;flex-wrap:wrap}.clues section{flex:1;min-width:240px}.clue{display:block;text-align:left;width:100%;border:0;background:transparent;min-height:40px;padding:7px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.word-search{touch-action:none;user-select:none}.word-search button{min-width:28px;min-height:32px;padding:0;border:0;border-radius:0;background:#fff;font-weight:700;line-height:32px}.word-search button.selected{background:#f5c16c}.word-search button.found{background:#b5dfc3}.word-list{display:flex;gap:12px 25px;flex-wrap:wrap;padding-left:20px}.prompt{display:block;margin:12px 0;font-weight:600}.prompt input{display:block;width:min(100%,420px);border:1px solid #628175;border-radius:7px;background:#fff;min-height:44px;padding:7px}.story{font-size:20px;white-space:pre-wrap;background:#fff;padding:20px;border-radius:12px}#announce{font-weight:600;min-height:28px}#restart{margin-top:12px}[hidden]{display:none!important}@media(max-width:500px){main{padding:9px}.crossword-cell{height:34px}.word-search button{min-width:28px}.clues{gap:8px}}
</style></head><body><main><h2 id="title">Loading your puzzle…</h2><p id="instruction"></p><div id="play"></div><p id="announce" role="status" aria-live="polite">Loading…</p><button id="restart" type="button">Restart puzzle</button></main><script nonce="${nonce}">const __name = (fn) => fn; (${installGameDisplayKeyboardBridge.toString()})("${nonce}"); (${startWordGameSandbox.toString()})((${createWordGameEngine.toString()})(),"${nonce}");</script></body></html>`;
}
