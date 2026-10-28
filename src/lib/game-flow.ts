import type { ArcadeGameSpec, GameFlow, GameFlowNode, GameLevel } from './game-types';

/** Strict data-only flow validation. This function can be serialized without imports. */
export function validateGameFlow(value: unknown, levels: Pick<GameLevel, 'id'>[]): GameFlow {
  function record(input: unknown, keys: string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Flow steps must be plain objects.');
    if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !keys.includes(key))) throw new Error('A flow step has missing or unexpected fields.');
    return input as Record<string, unknown>;
  }
  function title(input: unknown): string {
    if (typeof input !== 'string' || !input.trim() || input !== input.trim() || input.length > 80 || /[\u0000-\u001f\u007f-\u009f<>]|(?:https?:\/\/|www\.|javascript\s*:|data\s*:|vbscript\s*:)|\b(?:eval|fetch|import)\s*\(/iu.test(input)) throw new Error('Flow titles must be plain text up to 80 characters.');
    return input;
  }
  const flow = record(value, ['version', 'nodes']);
  if (flow.version !== 1 || !Array.isArray(flow.nodes) || flow.nodes.length < 1 || flow.nodes.length > 24) throw new Error('A flow needs 1 to 24 steps and version 1.');
  const ids = new Set<string>(), usedLevels = new Set<string>(), levelIds = new Set(levels.map(level => level.id));
  const nodes: GameFlowNode[] = flow.nodes.map((input, index) => {
    if (!input || typeof input !== 'object') throw new Error('Choose a supported flow step.');
    const type = (input as Record<string, unknown>).type;
    const node = record(input, type === 'level' ? ['id', 'type', 'levelId'] : type === 'menu' ? ['id', 'type', 'title'] : type === 'material' ? ['id', 'type', 'title', 'kind', 'reference', 'required'] : []);
    if (typeof node.id !== 'string' || !/^step-(?:[1-9]|1[0-9]|2[0-4])$/u.test(node.id) || ids.has(node.id)) throw new Error('Flow identifiers must be unique step-1 through step-24 values.');
    ids.add(node.id);
    if (type === 'level') {
      if (typeof node.levelId !== 'string' || !levelIds.has(node.levelId) || usedLevels.has(node.levelId)) throw new Error('Each saved level must appear exactly once in the flow.');
      usedLevels.add(node.levelId);
      return { id: node.id, type, levelId: node.levelId };
    }
    if (type === 'menu') {
      if (index !== 0) throw new Error('A level-selection home screen can appear only as the first step.');
      return { id: node.id, type, title: title(node.title) };
    }
    if (type !== 'material' || !['lesson', 'video', 'exercise'].includes(node.kind as string) || typeof node.required !== 'boolean') throw new Error('Choose a lesson, video, or exercise and whether it is required.');
    if (typeof node.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(node.reference) || node.reference.includes('://') || node.reference.split('/').includes('..')) throw new Error('Material references must be opaque client identifiers, without URLs or parent paths.');
    return { id: node.id, type, title: title(node.title), kind: node.kind as 'lesson' | 'video' | 'exercise', reference: node.reference, required: node.required };
  });
  if (usedLevels.size !== levelIds.size) throw new Error('Each saved level must appear exactly once in the flow.');
  return { version: 1, nodes };
}

/** A finite solo game uses its authored order until its creator saves a custom flow. */
export function defaultGameFlow(spec: ArcadeGameSpec): GameFlow {
  const levels = spec.levels ?? [{ id: 'level-1' }];
  return spec.flow ? validateGameFlow(spec.flow, levels) : { version: 1, nodes: levels.map((level, index) => ({ id: `step-${index + 1}`, type: 'level', levelId: level.id })) };
}

/** Keep creator material in place when the deterministic designer changes level count. */
export function reconcileGameFlow(flow: GameFlow, levels: Pick<GameLevel, 'id'>[]): GameFlow {
  const allowed = new Set(levels.map(level => level.id));
  const nodes = structuredClone(flow.nodes).filter(node => node.type !== 'level' || allowed.has(node.levelId));
  const used = new Set(nodes.map(node => node.id));
  for (const level of levels) if (!nodes.some(node => node.type === 'level' && node.levelId === level.id)) {
    const id = Array.from({ length: 24 }, (_, index) => `step-${index + 1}`).find(id => !used.has(id));
    if (!id) throw new Error('The flow is full. Remove a step before adding a level.');
    used.add(id); nodes.push({ id, type: 'level', levelId: level.id });
  }
  return validateGameFlow({ version: 1, nodes }, levels);
}

/** New category: fixed pixel platformer, with character choice made by each player. */
export function createPlatformerSpec(base?: ArcadeGameSpec): ArcadeGameSpec {
  const rules = base ? { ...base.rules } : { goal: 8, timeLimit: 90, lives: 3, difficulty: 2 };
  const levels: GameLevel[] = base?.levels ? structuredClone(base.levels) : [
    { id: 'level-1', title: 'First steps', brief: 'Walk, jump between platforms and collect the stars.', theme: 'garden', rules: { ...rules, goal: 5, difficulty: 1 }, seed: 17031 },
    { id: 'level-2', title: 'Moon crossing', brief: 'Time your jumps and collect the stars while avoiding obstacles.', theme: 'space', rules: { ...rules, goal: 6, difficulty: 2 }, seed: 27031 },
    { id: 'level-3', title: 'Waterside finale', brief: 'Combine your jumps and collection skills to finish the adventure.', theme: 'pond', rules: { ...rules }, seed: 37031 },
  ];
  return { version: 7, title: base?.title ?? 'Pixel Platformer', description: base?.description ?? 'Choose your character and jump through three themed worlds.', genre: 'platformer', theme: base?.theme ?? 'garden', player: base ? { ...base.player } : { name: 'Adventurer', color: '#65cadd', speed: 4, jump: 10 }, rules, objects: base ? { ...base.objects } : { collectible: 'star', hazard: 'obstacle' }, instructions: 'Choose a character. Left/Right or A/D walk; Space, Up or W jumps. Collect each level’s goal. Each collectible earns 10 points.', progression: base?.progression ?? 'Learn to walk and jump, practice in space, then complete the waterside finale.', levels, ...(base?.flow ? { flow: reconcileGameFlow(base.flow, levels) } : {}) };
}
