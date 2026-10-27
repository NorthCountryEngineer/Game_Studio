import { createWordGameEngine } from './word-game-engine';
import type { CrosswordEntry, MadLibBlank, WordGameSpec, WordGenre } from './game-types';

const engine = createWordGameEngine();
/** Field values are authored content, never instructions to replace a saved puzzle. */
function wordGameDirectives(message: string): string {
  let continuation = false;
  const prose: string[] = [];
  for (const line of message.split('\n')) {
    const field = line.match(/^\s*(title|description|instructions|seed|size|backwards|words|entries|template|blanks)\s*:\s*(.*?)\s*$/iu);
    if (field) { continuation = ['words', 'entries', 'template', 'blanks'].includes(field[1].toLowerCase()); continue; }
    if (!continuation) prose.push(line);
  }
  return prose.join('\n');
}
export function wordGameGenre(message: string): WordGenre | undefined {
  if (typeof message !== 'string') return undefined;
  message = wordGameDirectives(message);
  if (/\bcrossword\b/iu.test(message)) return 'crossword';
  if (/\bword[ -]?search\b/iu.test(message)) return 'word-search';
  if (/\bmad[ -]?libs?\b/iu.test(message)) return 'mad-libs';
  return undefined;
}
const packs: Record<string, CrosswordEntry[]> = {
  nature: [{ answer: 'WATER', clue: 'A liquid that plants and animals need' }, { answer: 'RIVER', clue: 'A stream of water flowing toward a lake or sea' }, { answer: 'RAIN', clue: 'Water falling from clouds' }, { answer: 'TREE', clue: 'A tall plant with a trunk' }, { answer: 'EARTH', clue: 'The planet we call home' }],
  space: [{ answer: 'PLANET', clue: 'A large world that orbits a star' }, { answer: 'STAR', clue: 'A glowing ball of gas in space' }, { answer: 'ORBIT', clue: 'The path around a planet or star' }, { answer: 'MOON', clue: 'A natural companion orbiting a planet' }, { answer: 'COMET', clue: 'An icy object that can grow a glowing tail' }],
  animals: [{ answer: 'AXOLOTL', clue: 'An aquatic salamander with feathery external gills' }, { answer: 'WATER', clue: 'The liquid home of an axolotl' }, { answer: 'POND', clue: 'A small body of still fresh water' }, { answer: 'GILLS', clue: 'Body parts that help aquatic animals breathe' }, { answer: 'TAIL', clue: 'The rear body part an axolotl uses to swim' }],
  garden: [{ answer: 'FLOWER', clue: 'The colorful part of many plants' }, { answer: 'ROOT', clue: 'A plant part that takes up water from soil' }, { answer: 'LEAF', clue: 'A plant part that catches sunlight' }, { answer: 'SEED', clue: 'A small beginning from which a plant can grow' }, { answer: 'SOIL', clue: 'The ground in which garden plants grow' }],
  science: [{ answer: 'ATOM', clue: 'A tiny unit of a chemical element' }, { answer: 'ENERGY', clue: 'The capacity to do work or cause change' }, { answer: 'MATTER', clue: 'Anything that has mass and takes up space' }, { answer: 'FORCE', clue: 'A push or a pull' }, { answer: 'LIGHT', clue: 'Visible electromagnetic radiation' }],
};
function topicKey(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (/\b(space|planets?|astronomy|solar system)\b/u.test(lower)) return 'space';
  if (/\b(animals?|axolotls?|pond)\b/u.test(lower)) return 'animals';
  if (/\b(garden|plants?|flowers?)\b/u.test(lower)) return 'garden';
  if (/\b(science|physics|atoms?)\b/u.test(lower)) return 'science';
  if (/\b(nature|water|earth)\b/u.test(lower)) return 'nature';
  return undefined;
}
export function defaultWordGameSpec(genre: WordGenre = 'crossword', topic = 'nature'): WordGameSpec {
  const key = topicKey(topic) || 'nature', entries = structuredClone(packs[key]);
  const common = { version: 3 as const, title: `${key[0].toUpperCase()}${key.slice(1)} ${genre === 'crossword' ? 'Crossword' : genre === 'word-search' ? 'Word Search' : 'Mad Libs'}`, description: `A free guided ${key} word game. Review and edit the content before publishing.`, instructions: '' };
  if (genre === 'crossword') return engine.validate({ ...common, genre, instructions: 'Fill the numbered across and down clues. Check your letters, or reveal the solution after trying.', puzzle: { seed: 17031, entries } });
  if (genre === 'word-search') return engine.validate({ ...common, genre, instructions: 'Select the first and last letter of each hidden word in a straight line. Use a pointer, or arrows and Enter.', puzzle: { seed: 17031, size: 12, allowBackwards: false, words: entries.map(entry => entry.answer) } });
  const templates: Record<string, string> = {
    nature: 'One day, a {{blank-1}} explorer took a {{blank-2}} to the park. There they decided to {{blank-3}} beside a {{blank-1}} tree.',
    space: 'One day, a {{blank-1}} explorer took a {{blank-2}} aboard a spaceship. They decided to {{blank-3}} beside a {{blank-1}} planet.',
    animals: 'A {{blank-1}} axolotl found a {{blank-2}} in the pond. It decided to {{blank-3}} while a {{blank-1}} turtle watched.',
    garden: 'A {{blank-1}} gardener planted a {{blank-2}} beside the flowers. Before lunch, the plants began to {{blank-3}} in the {{blank-1}} garden.',
    science: 'In the laboratory, a {{blank-1}} scientist placed a {{blank-2}} on the table. The experiment began to {{blank-3}} and made a {{blank-1}} discovery.',
  };
  return engine.validate({ ...common, genre, instructions: 'Fill every prompt before revealing your story. Your answers stay in this player.', puzzle: { template: templates[key], blanks: [{ id: 'blank-1', label: 'Adjective' }, { id: 'blank-2', label: 'Noun' }, { id: 'blank-3', label: 'Verb' }] } });
}
export function parseCrosswordEntries(text: string): CrosswordEntry[] {
  return text.split(/[\n;]/u).filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*([a-z]{2,18})\s*[|:]\s*(.+?)\s*$/iu);
    if (!match) throw new Error('Write one ANSWER | clue per line, or separate entries with semicolons.');
    return { answer: match[1].toUpperCase(), clue: match[2].trim() };
  });
}
export function parseWordList(text: string): string[] { return text.split(/[\s,;]+/u).filter(Boolean).map(word => word.toUpperCase()); }
export function parseMadLibBlanks(text: string): MadLibBlank[] {
  return text.split(/[\n;]/u).filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*(blank-(?:[1-9]|1[0-2]))\s*[|:]\s*(.+?)\s*$/u);
    if (!match) throw new Error('Write one blank-1 | prompt label per line, using blank-1 through blank-12.');
    return { id: match[1], label: match[2].trim() };
  });
}
/** No model is called. Known topics use disclosed, editable curated vocabulary. */
export function designWordGame(message: string, current?: WordGameSpec): { spec: WordGameSpec; reply: string } {
  if (typeof message !== 'string' || !message.trim() || message.length > 2000 || /[\uD800-\uDFFF]/u.test(message) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)) throw new Error('Describe your game in 1 to 2,000 characters.');
  const directives = wordGameDirectives(message);
  const genre = wordGameGenre(message) || current?.genre || 'crossword', topic = topicKey(directives);
  const reset = !current || current.genre !== genre || /\b(?:about|topic\s*:|theme\s*:)\s*/iu.test(directives) && Boolean(topic);
  let spec = reset ? defaultWordGameSpec(genre, topic || 'nature') : engine.validate(current);
  const fields: Record<string, string> = {};
  const lines = message.split('\n');
  let active = '';
  for (const line of lines) {
    const match = line.match(/^\s*(title|description|instructions|seed|size|backwards|words|entries|template|blanks)\s*:\s*(.*?)\s*$/iu);
    if (match) { active = match[1].toLowerCase(); fields[active] = match[2]; }
    else if (active && ['words', 'entries', 'template', 'blanks'].includes(active)) fields[active] += `\n${line}`;
  }
  spec = structuredClone(spec);
  for (const field of ['title', 'description', 'instructions'] as const) if (field in fields) spec[field] = fields[field].trim();
  if (spec.genre !== 'mad-libs' && 'seed' in fields) spec.puzzle.seed = Number(fields.seed);
  if (spec.genre === 'crossword' && 'entries' in fields) spec.puzzle.entries = parseCrosswordEntries(fields.entries);
  if (spec.genre === 'word-search') {
    if ('words' in fields) spec.puzzle.words = parseWordList(fields.words);
    if ('size' in fields) spec.puzzle.size = Number(fields.size);
    else { const size = directives.match(/\b(?:size|grid)\s+(\d+)\b/iu); if (size) spec.puzzle.size = Number(size[1]); }
    const backwards = fields.backwards ?? directives.match(/\b(no backwards|allow backwards|backwards on|backwards off)\b/iu)?.[1];
    if (backwards !== undefined) {
      if (/^(?:true|yes|on|allow backwards|backwards on)$/iu.test(backwards)) spec.puzzle.allowBackwards = true;
      else if (/^(?:false|no|off|no backwards|backwards off)$/iu.test(backwards)) spec.puzzle.allowBackwards = false;
      else throw new Error('Backwards must be on or off.');
    }
  }
  if (spec.genre === 'mad-libs') {
    if ('template' in fields) spec.puzzle.template = fields.template.trim();
    if ('blanks' in fields) spec.puzzle.blanks = parseMadLibBlanks(fields.blanks);
  }
  const topicNote = reset ? topic ? `Used the editable curated ${topic} starter.` : 'Used the editable curated nature starter; arbitrary-topic content is not generated by this free designer.' : 'Kept your saved content except for the explicit edits above.';
  const help = spec.genre === 'crossword' ? 'Edit Entries: ANSWER | clue; ANSWER | clue; ANSWER | clue. Every word must fit one connected crossword.' : spec.genre === 'word-search' ? 'Edit Words: WATER, RIVER, RAIN. Set Size: 12 and Backwards: off.' : 'Edit Template: using {{blank-1}} tokens, and Blanks: blank-1 | adjective; blank-2 | noun. Every declared blank must be used.';
  return { spec: engine.validate(spec), reply: `Updated your ${genre} game. ${topicNote} ${help} This free guided designer calls no AI model. Review all content, then complete a playtest before publishing.` };
}
