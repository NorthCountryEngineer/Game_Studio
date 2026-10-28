import type { MultiGameSpec, MultiGameStep, SingleGameSpec } from './game-types';
import { validateArcadeGameSpec } from './game-design';
import { createWordGameEngine } from './word-game-engine';
import { defaultWordGameSpec } from './word-game-design';

/** A journey stores reviewed copies, never live references to mutable drafts. */
export function validateMultiGameSpec(value: unknown, validateSingle?: (value: unknown) => SingleGameSpec): MultiGameSpec {
  function record(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('A multi-game object has missing or unexpected fields.');
    return value as Record<string, unknown>;
  }
  function text(value: unknown, max: number, empty = false): string {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f<>]|(?:https?:\/\/|www\.|javascript\s*:|data\s*:|vbscript\s*:)|\b(?:eval|fetch|import)\s*\(/iu.test(value) || Array.from(value).some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) throw new Error(`Multi-game text must be plain text up to ${max} characters, without links or code.`);
    return value;
  }
  const root = record(value, ['version', 'genre', 'title', 'description', 'instructions', 'steps']);
  if (root.version !== 8 || root.genre !== 'multi-game' || !Array.isArray(root.steps) || root.steps.length < 1 || root.steps.length > 12) throw new Error('A multi-game journey needs version 8 and 1 to 12 steps.');
  const rawSteps = root.steps;
  let finiteGames = 0, games = 0;
  const ids = new Set<string>();
  const steps: MultiGameStep[] = rawSteps.map((input, index) => {
    if (!input || typeof input !== 'object') throw new Error('Choose a supported journey step.');
    const type = (input as Record<string, unknown>).type;
    const step = record(input, type === 'material' ? ['id', 'type', 'title', 'kind', 'reference', 'required'] : ['id', 'type', 'spec']);
    if (typeof step.id !== 'string' || !/^step-(?:[1-9]|1[0-2])$/u.test(step.id) || ids.has(step.id)) throw new Error('Journey identifiers must be unique step-1 through step-12 values.');
    ids.add(step.id);
    if (type === 'material') {
      if (!['content', 'video', 'interactive'].includes(step.kind as string) || typeof step.required !== 'boolean') throw new Error('Choose content, video, or interactive client material and whether it is required.');
      if (typeof step.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(step.reference) || step.reference.includes('://') || step.reference.split('/').includes('..')) throw new Error('Material references must be opaque client identifiers, without URLs or parent paths.');
      return { id: step.id, type, title: text(step.title, 80), kind: step.kind as 'content' | 'video' | 'interactive', reference: step.reference, required: step.required };
    }
    if (type !== 'game' && type !== 'free-play') throw new Error('Choose a game, client object, or final free-play step.');
    const raw = step.spec;
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version === 8) throw new Error('Nested multi-game journeys are not supported.');
    const spec = validateSingle ? validateSingle(raw) : (raw as { version?: unknown }).version === 3 ? createWordGameEngine().validate(raw) : validateArcadeGameSpec(raw);
    if ((spec as { version: number }).version === 8 || spec.version !== 3 && spec.multiplayer) throw new Error('Journey games must use the fixed solo formats.');
    if (++games > 8) throw new Error('A journey supports at most eight games, including free play.');
    const endless = spec.version === 6 && !!spec.asteroids?.endless;
    if (type === 'free-play') {
      if (index !== rawSteps.length - 1 || !endless || spec.version !== 6) throw new Error('Free play must be the last step and use continuous solo Asteroids.');
      return { id: step.id, type, spec };
    }
    if (endless) throw new Error('Continuous games belong only in the final free-play step.');
    finiteGames += 1;
    return { id: step.id, type, spec };
  });
  if (!finiteGames) throw new Error('A journey needs at least one finite game.');
  const clean: MultiGameSpec = { version: 8, genre: 'multi-game', title: text(root.title, 80), description: text(root.description, 300, true), instructions: text(root.instructions, 300, true), steps };
  function validUnicode(value: unknown): void {
    if (typeof value === 'string' && Array.from(value).some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) throw new Error('Journey content contains invalid Unicode.');
    if (value && typeof value === 'object') for (const child of Object.values(value)) validUnicode(child);
  }
  validUnicode(clean);
  const serialized = JSON.stringify(clean);
  // UTF-8 bytes, not JavaScript string units: sprites count toward this limit too.
  if (new TextEncoder().encode(serialized).length >= 240000) throw new Error('The combined journey must fit below 240,000 bytes. Use smaller sprites or fewer games.');
  return structuredClone(clean);
}

export function defaultMultiGameSpec(): MultiGameSpec {
  return validateMultiGameSpec({ version: 8, genre: 'multi-game', title: 'Multi-game Journey', description: 'A sequence of games and optional client-owned objects.', instructions: 'Complete each game to continue through the journey.', steps: [
    { id: 'step-1', type: 'game', spec: defaultWordGameSpec('crossword') },
    { id: 'step-2', type: 'game', spec: defaultWordGameSpec('word-search') },
  ] });
}

export function multiGameRequested(message: string): boolean {
  if (typeof message !== 'string') return false;
  const directives = message.split('\n').filter(line => !/^\s*(?:title|name|description|instructions|player|collectible|hazard)\s*:/iu.test(line)).join('\n');
  return /\b(?:create|build|make|start)\s+(?:a\s+)?multi[ -]game\b/iu.test(directives);
}

/** Conversation edits metadata only; the visual editor explicitly owns composition. */
export function designMultiGame(message: string, current?: MultiGameSpec): { spec: MultiGameSpec; reply: string } {
  if (typeof message !== 'string' || !message.trim() || message.length > 2000 || /[\uD800-\uDFFF]/u.test(message) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)) throw new Error('Describe your game in 1 to 2,000 characters.');
  const spec = current ? validateMultiGameSpec(current) : defaultMultiGameSpec();
  for (const line of message.split('\n')) {
    const match = line.match(/^\s*(title|description|instructions)\s*:\s*(.*?)\s*$/iu);
    if (match) spec[match[1].toLowerCase() as 'title' | 'description' | 'instructions'] = match[2].trim();
  }
  return { spec: validateMultiGameSpec(spec), reply: 'Use the journey editor to add, copy, and reorder games or client objects. Conversation updates Title, Description, and Instructions; saved game copies stay unchanged.' };
}
