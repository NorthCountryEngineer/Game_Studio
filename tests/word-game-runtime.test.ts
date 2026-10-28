import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script, createContext } from 'node:vm';
import { defaultWordGameSpec } from '../src/lib/word-game-design.ts';
import { createWordGameEngine } from '../src/lib/word-game-engine.ts';
import { wordGameSandboxDocument } from '../src/lib/word-game-runtime.ts';
import { validateGameResult } from '../src/lib/game-runtime.ts';
import type { WordGameSpec } from '../src/lib/game-types.ts';

type Handler = (event: any) => void;
class Element {
  tag: string; children: Element[] = []; parent?: Element; handlers: Record<string, Handler[]> = {}; textContent = ''; value = ''; hidden = false; disabled = false; type = ''; className = ''; style: Record<string, string> = {}; dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; classes = new Set<string>();
  classList = { add: (...names: string[]) => names.forEach(name => this.classes.add(name)), remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)) };
  constructor(tag = 'div') { this.tag = tag; }
  append(node: Element) { node.parent = this; this.children.push(node); }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  addEventListener(name: string, fn: Handler) { (this.handlers[name] ||= []).push(fn); }
  fire(name: string, event: Record<string, unknown> = {}) { (this.handlers[name] || []).forEach(fn => fn({ preventDefault() {}, target: this, detail: 0, ...event })); }
  focus() {} select() {}
  closest() { return this.tag === 'button' && 'row' in this.dataset ? this : null; }
  contains(node: Element): boolean { return node === this || this.children.some(child => child.contains(node)); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
function sandbox(spec: WordGameSpec) {
  const elements = Object.fromEntries(['title', 'instruction', 'play', 'announce', 'restart'].map(id => [id, new Element()]));
  const messages: any[] = [], handlers: Record<string, Handler> = {}, parent = { postMessage(message: unknown) { messages.push(JSON.parse(JSON.stringify(message))); } };
  let hit: Element | undefined, now = 100;
  const context = createContext({ document: { getElementById: (id: string) => elements[id], createElement: (tag: string) => new Element(tag), elementFromPoint: () => hit, addEventListener() {} }, window: { addEventListener(name: string, fn: Handler) { handlers[name] = fn; } }, parent, performance: { now: () => now } });
  const html = wordGameSandboxDocument('1234567890abcdef'); new Script(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/u)![1]).runInContext(context);
  new Script(`window.loadSpec = ${JSON.stringify(spec)};`).runInContext(context);
  const loadSpec = (context.window as any).loadSpec;
  handlers.message({ source: {}, data: { type: 'axolotl-game-load', nonce: '1234567890abcdef', spec: loadSpec } }); assert.equal(messages.length, 1);
  handlers.message({ source: parent, data: { type: 'axolotl-game-load', nonce: 'wrong', spec: loadSpec } }); assert.equal(messages.length, 1);
  handlers.message({ source: parent, data: { type: 'axolotl-game-load', nonce: '1234567890abcdef', spec: loadSpec } }); assert.equal(messages.at(-1).type, 'axolotl-game-loaded');
  return { ...elements, messages, setHit(node: Element) { hit = node; }, elapse(seconds: number) { now += seconds * 1000; }, results: () => messages.filter(message => message.type === 'axolotl-game-result') };
}
test('word sandbox uses fixed serialized code, network denied CSP, nonce and source handshake', () => {
  const html = wordGameSandboxDocument('1234567890abcdef');
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'"]) assert.ok(html.includes(directive));
  assert.match(html, /event\.source\s*!==\s*parent/u); assert.match(html, /event\.data\.nonce\s*!==\s*nonce/u); assert.doesNotMatch(html, /\.innerHTML|localStorage|sessionStorage|new Function|https?:\/\//u);
  assert.doesNotThrow(() => new Script(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/u)![1])); assert.throws(() => wordGameSandboxDocument('unsafe'));
});
test('typed crossword checks completion and reveal reports lost, with only counts sent', () => {
  const spec = defaultWordGameSpec('crossword'); if (spec.genre !== 'crossword') throw new Error('fixture');
  const game = sandbox(spec), layout = createWordGameEngine().crossword(spec), inputs = game.play.all().filter(el => el.tag === 'input');
  const letters = layout.grid.flatMap(row => row.filter(Boolean)); assert.equal(inputs.length, letters.length);
  inputs.forEach((input, i) => { input.value = letters[i]; input.fire('input'); }); game.elapse(12);
  game.play.all().find(el => el.textContent === 'Check answers')!.fire('click');
  assert.equal(game.results()[0].result.outcome, 'won'); assert.equal(game.results()[0].result.score, spec.puzzle.entries.length); assert.equal(game.results()[0].result.elapsed, 12);
  assert.deepEqual(Object.keys(game.results()[0].result).sort(), ['elapsed', 'outcome', 'reviewedLevelIds', 'score']);
  game.restart.fire('click'); game.play.all().find(el => el.textContent === 'Reveal solution')!.fire('click'); assert.equal(game.results().at(-1).result.outcome, 'lost'); assert.equal(game.results().at(-1).result.score, 0);
});
test('word search supports keyboard endpoints and pointer drag, completes after every word', () => {
  const spec = defaultWordGameSpec('word-search'); if (spec.genre !== 'word-search') throw new Error('fixture');
  const game = sandbox(spec), layout = createWordGameEngine().wordSearch(spec), buttons = game.play.all().filter(el => el.tag === 'button' && 'row' in el.dataset), board = buttons[0].parent!;
  const at = (r: number, c: number) => buttons.find(el => Number(el.dataset.row) === r && Number(el.dataset.col) === c)!;
  layout.placements.forEach((p, i) => { const start = at(p.row, p.col), end = at(p.row + p.dr * (p.word.length - 1), p.col + p.dc * (p.word.length - 1)); if (i % 2) { board.fire('pointerdown', { target: start }); game.setHit(end); board.fire('pointerup', { clientX: 10, clientY: 10 }); } else { start.fire('click'); end.fire('click'); } });
  assert.equal(game.results().length, 1); assert.equal(game.results()[0].result.score, spec.puzzle.words.length); assert.equal(game.results()[0].result.outcome, 'won');
});
test('Mad Libs hides story until prompts are filled and keeps entered answers inside sandbox', () => {
  const spec = defaultWordGameSpec('mad-libs'), game = sandbox(spec), form = game.play.all().find(el => el.attributes['aria-label'] === 'Story prompts')!;
  assert.ok(!game.play.all().some(el => el.textContent.includes('One day'))); form.all().find(el => el.textContent === 'Reveal my story')!.fire('click'); assert.equal(game.results().length, 0);
  const inputs = form.all().filter(el => el.tag === 'input'); ['sparkly', 'privatepineapple', 'twirl'].forEach((word, i) => { inputs[i].value = word; }); form.all().find(el => el.textContent === 'Reveal my story')!.fire('click');
  assert.equal(game.play.all().filter(el => el.tag === 'form').length, 0); assert.equal(form.all().find(el => el.textContent === 'Reveal my story')!.type, 'button');
  assert.equal(form.hidden, true); assert.ok(game.play.all().some(el => el.textContent.includes('privatepineapple'))); assert.equal(game.results().length, 1); assert.doesNotMatch(JSON.stringify(game.messages), /privatepineapple|sparkly|twirl/u);
});
test('Mad Libs Enter reveals through explicit keyboard handling without native form submission', () => {
  const game = sandbox(defaultWordGameSpec('mad-libs')), prompts = game.play.all().find(el => el.attributes['aria-label'] === 'Story prompts')!;
  prompts.all().filter(el => el.tag === 'input').forEach(el => { el.value = 'curious'; });
  let prevented = false; prompts.fire('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(prompts.hidden, true); assert.equal(game.results()[0].result.outcome, 'won');
});
test('word result validation rejects leaked input, inflated counts, points and invalid elapsed', () => {
  for (const genre of ['crossword', 'word-search', 'mad-libs'] as const) {
    const spec = defaultWordGameSpec(genre), max = spec.genre === 'crossword' ? spec.puzzle.entries.length : spec.genre === 'word-search' ? spec.puzzle.words.length : spec.puzzle.blanks.length;
    const valid = { outcome: 'won', score: max, elapsed: 5000, reviewedLevelIds: ['level-1'] }; assert.ok(validateGameResult(valid, spec));
    for (const change of [{ answer: 'secret' }, { story: 'secret' }, { points: 10 }, { score: max + 1 }, { score: max - 1 }, { elapsed: 86401 }, { elapsed: NaN }, { reviewedLevelIds: ['level-2'] }, { outcome: 'level-complete' }]) assert.equal(validateGameResult({ ...valid, ...change }, spec), undefined);
  }
  const spec = defaultWordGameSpec('mad-libs'), game = sandbox(spec), form = game.play.all().find(el => el.attributes['aria-label'] === 'Story prompts')!; form.all().filter(el => el.tag === 'input').forEach(el => { el.value = 'test'; }); game.elapse(86401); form.all().find(el => el.textContent === 'Reveal my story')!.fire('click'); assert.equal(game.results().length, 0); assert.match(game.announce.textContent, /expired/u);
});
