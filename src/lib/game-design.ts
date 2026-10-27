import type { ArcadeGameSpec, GameArcadeOptions, GameLevel, GamePowerUps, GameSpec } from './game-types';
import { createWordGameEngine } from './word-game-engine';
import { designWordGame, wordGameGenre } from './word-game-design';

/** Data is the only author-controlled input to the fixed game engine. */
export function validateArcadeGameSpec(value: unknown): ArcadeGameSpec {
  function object(input: unknown, keys: string[], label: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error(`${label} must be an object.`);
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key)) || Object.keys(record).some(key => !keys.includes(key))) throw new Error(`${label} has missing or unexpected fields.`);
    return record;
  }
  function text(input: unknown, max: number, label: string, allowEmpty = false): string {
    if (typeof input !== 'string' || (!allowEmpty && !input.trim()) || input !== input.trim() || input.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(input) || /[<>]|(?:https?:\/\/|www\.|javascript\s*:|data\s*:|vbscript\s*:)|\b(?:eval|fetch|import)\s*\(/iu.test(input)) throw new Error(`${label} must be plain text up to ${max} characters, without links or code.`);
    return input;
  }
  function integer(input: unknown, min: number, max: number, label: string): number {
    if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    return input;
  }
  const version = value && typeof value === 'object' ? (value as Record<string, unknown>).version : undefined;
  if (version !== 1 && version !== 2 && version !== 4 && version !== 5) throw new Error('Unsupported game version.');
  const hasArcade = Object.prototype.hasOwnProperty.call(value, 'arcade');
  const spec = object(value, ['version', 'title', 'description', 'genre', 'theme', 'player', 'rules', 'objects', 'instructions', ...(version !== 1 ? ['progression', 'levels'] : []), ...(version === 4 || version === 5 && Object.prototype.hasOwnProperty.call(value, 'multiplayer') ? ['multiplayer'] : []), ...(version === 5 ? ['powerUps'] : []), ...(hasArcade ? ['arcade'] : [])], 'Game');
  const player = object(spec.player, ['name', 'color', 'speed', 'jump'], 'Player');
  const rules = object(spec.rules, ['goal', 'timeLimit', 'lives', 'difficulty'], 'Rules');
  const objects = object(spec.objects, ['collectible', 'hazard'], 'Objects');
  if (!['collect', 'dodge', 'platformer'].includes(spec.genre as string)) throw new Error('Choose collect, dodge, or platformer.');
  if (!['pond', 'space', 'garden'].includes(spec.theme as string)) throw new Error('Choose pond, space, or garden.');
  if (typeof player.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(player.color)) throw new Error('Player color must be a six-digit hex color.');
  const clean: ArcadeGameSpec = {
    version,
    title: text(spec.title, 80, 'Title'), description: text(spec.description, 300, 'Description', true),
    genre: spec.genre as ArcadeGameSpec['genre'], theme: spec.theme as ArcadeGameSpec['theme'],
    player: { name: text(player.name, 40, 'Player name'), color: player.color, speed: integer(player.speed, 2, 8, 'Speed'), jump: integer(player.jump, 6, 14, 'Jump') },
    rules: { goal: integer(rules.goal, 3, 40, 'Goal'), timeLimit: integer(rules.timeLimit, 30, 180, 'Time'), lives: integer(rules.lives, 1, 5, 'Lives'), difficulty: integer(rules.difficulty, 1, 5, 'Difficulty') },
    objects: { collectible: text(objects.collectible, 30, 'Collectible'), hazard: text(objects.hazard, 30, 'Hazard') },
    instructions: text(spec.instructions, 300, 'Instructions', true),
  };
  if (hasArcade) {
    if (spec.genre !== 'dodge') throw new Error('Arcade options are supported only for dodge games.');
    const arcade = object(spec.arcade, ['rotation', 'shooting', 'splitAsteroids', 'scoring', 'highScores'], 'Arcade options');
    if (Object.values(arcade).some(value => typeof value !== 'boolean')) throw new Error('Arcade options must be true or false.');
    if (arcade.splitAsteroids && !arcade.shooting) throw new Error('Splitting asteroids requires shooting.');
    if (arcade.highScores && !arcade.scoring) throw new Error('High scores require scoring.');
    clean.arcade = { ...arcade } as GameArcadeOptions;
  }
  if (version !== 1) {
    clean.progression = text(spec.progression, 300, 'Progression');
    if (!Array.isArray(spec.levels) || spec.levels.length < 1 || spec.levels.length > 8) throw new Error('A game needs 1 to 8 levels.');
    const ids = new Set<string>();
    clean.levels = spec.levels.map(input => {
      const level = object(input, ['id', 'title', 'brief', 'theme', 'rules', 'seed'], 'Level');
      if (typeof level.id !== 'string' || !/^level-[1-8]$/u.test(level.id) || ids.has(level.id)) throw new Error('Level identifiers must be unique, from level-1 to level-8.');
      ids.add(level.id);
      if (!['pond', 'space', 'garden'].includes(level.theme as string)) throw new Error('Choose pond, space, or garden for each level.');
      const settings = object(level.rules, ['goal', 'timeLimit', 'lives', 'difficulty'], 'Level rules');
      return { id: level.id, title: text(level.title, 80, 'Level title'), brief: text(level.brief, 300, 'Level brief'), theme: level.theme as GameLevel['theme'], seed: integer(level.seed, 1, 2147483647, 'Layout seed'), rules: { goal: integer(settings.goal, 3, 40, 'Level goal'), timeLimit: integer(settings.timeLimit, 30, 180, 'Level time'), lives: integer(settings.lives, 1, 5, 'Level lives'), difficulty: integer(settings.difficulty, 1, 5, 'Level difficulty') } };
    });
  }
  if (version === 4 || version === 5 && Object.prototype.hasOwnProperty.call(spec, 'multiplayer')) {
    const multiplayer = object(spec.multiplayer, ['mode', 'maxPlayers'], 'Multiplayer');
    if (multiplayer.mode !== 'cooperative' || multiplayer.maxPlayers !== 2) throw new Error('Multiplayer supports two cooperative players.');
    clean.multiplayer = { mode: 'cooperative', maxPlayers: 2 };
  }
  if (version === 5) {
    if (clean.genre !== 'dodge' || !clean.arcade?.shooting) throw new Error('Prizes require a dodge game with shooting.');
    const prizes = object(spec.powerUps, ['spawnInterval', 'duration', 'types'], 'Prizes');
    const allowed = ['triple-shot', 'rapid-fire', 'shield', 'speed-boost'];
    if (!Array.isArray(prizes.types) || prizes.types.length < 1 || prizes.types.length > 4 || prizes.types.some(type => typeof type !== 'string' || !allowed.includes(type)) || new Set(prizes.types).size !== prizes.types.length) throw new Error('Choose one to four different supported prizes.');
    clean.powerUps = { spawnInterval: integer(prizes.spawnInterval, 5, 60, 'Prize interval'), duration: integer(prizes.duration, 3, 30, 'Prize duration'), types: [...prizes.types] as GamePowerUps['types'] };
  }
  return clean;
}

/** Legacy games retain their original rules and layout, without rewriting saved data. */
export function getGameLevels(spec: ArcadeGameSpec): GameLevel[] {
  return spec.version !== 1 ? structuredClone(spec.levels || []) : [{ id: 'level-1', title: spec.title, brief: spec.instructions || 'Collect treasures and avoid obstacles.', theme: spec.theme, rules: { ...spec.rules }, seed: 17031 }];
}

function layoutSeed(text: string): number {
  let hash = 17031;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) >>> 0;
  return hash % 2147483646 + 1;
}

/** Only the fixed dodge engine can run these optional controls and scoring rules. */
function arcadeControls(spec: ArcadeGameSpec): string {
  return spec.arcade?.rotation ? 'Left/Right or A/D turn 360 degrees; Up/W thrusts and Down/S reverses.' : 'Use arrows or WASD to swim.';
}

function arcadeChallenge(spec: ArcadeGameSpec): string {
  if (!spec.arcade?.shooting) return `Avoid ${spec.objects.hazard}s.`;
  return spec.arcade.splitAsteroids ? 'Space fires. Large asteroids split into two pieces; one shot destroys each piece.' : 'Space fires. One shot destroys an asteroid.';
}

function arcadeInstructions(spec: ArcadeGameSpec): string {
  const goal = spec.version !== 1 ? 'Complete each level’s collection goal.' : `Collect ${spec.rules.goal} ${spec.objects.collectible}s before time runs out.`;
  const points = spec.arcade?.scoring ? ` Points: snacks 10${spec.arcade.shooting ? ', large hits 20' : ''}${spec.arcade.splitAsteroids ? ', small pieces 50' : ''}.` : '';
  return `${arcadeControls(spec)} ${goal} ${arcadeChallenge(spec)}${points}`;
}

/** A short reminder fits beside every collection goal without inventing a new win rule. */
function arcadeLevelBrief(spec: ArcadeGameSpec, goal: number, focus: string): string {
  return `${focus} Collect ${goal} ${spec.objects.collectible}s. ${arcadeControls(spec)} ${arcadeChallenge(spec)}`;
}

/** Refresh generated control hints without replacing an author's level design. */
function refreshArcadeBrief(before: ArcadeGameSpec, spec: ArcadeGameSpec, brief: string): string {
  const previous = `${arcadeControls(before)} ${arcadeChallenge(before)}`;
  if (!brief.endsWith(previous)) return brief;
  const authored = brief.slice(0, -previous.length).trimEnd();
  const refreshed = `${authored ? `${authored} ` : ''}${arcadeControls(spec)} ${arcadeChallenge(spec)}`;
  // A longer control hint must never truncate the creator's original text.
  // The runtime always displays its fixed control help beside this brief.
  return refreshed.length <= 300 ? refreshed : authored;
}

const arcadeFeatures: [keyof GameArcadeOptions, string][] = [
  ['rotation', '360(?:[ -]degrees?|\\s*°)?(?:\\s+(?:turning|rotation))?|rotation|rotating|turning'],
  ['shooting', 'shoot(?:ing|er)?|firing|fire'],
  ['splitAsteroids', '(?:asteroid\\s+)?splitting|split(?:\\s+asteroids?)?'],
  ['scoring', 'scoring|points?(?:\\s+(?:tracker|tracking))?|score\\s+tracking'],
  ['highScores', 'high[ -]?scores?|leaderboards?'],
];

function arcadeToggle(message: string, feature: string): boolean | undefined {
  const pattern = new RegExp(`\\b(?:(no|without|disable|remove|turn off|turn on|enable|add|allow|do not want|don't want)\\s+(?:the\\s+)?)?(?:${feature})\\b(?:\\s*(?:is|:|=|to)?\\s*(on|off|enabled|disabled|true|false))?`, 'gu');
  let result: boolean | undefined;
  for (const match of message.matchAll(pattern)) result = match[2] ? ['on', 'enabled', 'true'].includes(match[2]) : !['no', 'without', 'disable', 'remove', 'turn off', 'do not want', "don't want"].includes(match[1]);
  return result;
}

/** Free fallback: explicit progression from the creator's rules, with saved layout variation. */
export function planGameLevels(spec: ArcadeGameSpec, count: number, seedText: string, previous: GameLevel[] = []): ArcadeGameSpec {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Choose 1 to 8 levels.');
  const levels: GameLevel[] = Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 1 : index / (count - 1);
    const stage = count === 1 ? 'Your adventure' : index === 0 ? 'First steps' : index === count - 1 ? 'The big adventure' : `Practice trail ${index}`;
    const difficulty = Math.max(1, Math.min(5, spec.rules.difficulty - (count === 1 ? 0 : 1) + Math.floor(progress * (count === 1 ? 0 : 2))));
    const goal = Math.max(3, Math.round(spec.rules.goal * (count === 1 ? 1 : 0.6 + 0.4 * progress)));
    const focus = count === 1 ? 'Explore the world at your own pace.' : index === 0 ? 'Learn the controls with a smaller collection goal and fewer obstacles.' : index === count - 1 ? 'Put your practice together with the full collection goal and the strongest challenge.' : 'Practice finding treasures while watching a more varied obstacle pattern.';
    return { id: `level-${index + 1}`, title: stage, brief: spec.arcade ? arcadeLevelBrief(spec, goal, index === 0 ? 'Learn the controls.' : index === count - 1 ? 'Combine your skills.' : 'Practice with more obstacles.') : `${focus} Collect ${goal} ${spec.objects.collectible}s and avoid ${spec.objects.hazard}s.`, theme: spec.theme, rules: { ...spec.rules, goal, difficulty }, seed: previous[index]?.seed || layoutSeed(`${seedText}|${index + 1}`) };
  });
  return validateArcadeGameSpec({ ...spec, version: spec.version === 5 ? 5 : spec.version === 4 ? 4 : 2, progression: count === 1 ? 'One complete adventure with a saved layout. Lives and time reset when you retry.' : 'Start with the controls and a smaller goal, practice avoiding obstacles, then finish with the full goal and a greater challenge. Each level starts with fresh lives and time.', levels });
}

export function defaultGameSpec(): ArcadeGameSpec {
  return { version: 1, title: 'Axolotl Pond Adventure', description: 'Help a curious axolotl gather water snacks and steer clear of rocks.', genre: 'collect', theme: 'pond', player: { name: 'Axolotl', color: '#efadc4', speed: 5, jump: 10 }, rules: { goal: 10, timeLimit: 60, lives: 3, difficulty: 2 }, objects: { collectible: 'water snack', hazard: 'rock' }, instructions: 'Use the arrow keys or WASD to swim. Collect 10 water snacks before time runs out. Avoid rocks. Touch controls are available below the game.' };
}

export function defaultPowerUps(): GamePowerUps { return { spawnInterval: 12, duration: 10, types: ['triple-shot', 'rapid-fire', 'shield', 'speed-boost'] }; }

/** A transparent, bounded conversational builder; it does not invoke an AI model. */
export function designArcadeGame(message: string, current?: ArcadeGameSpec): { spec: ArcadeGameSpec; reply: string } {
  if (typeof message !== 'string' || !message.trim() || message.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)) throw new Error('Describe your game in 1 to 2,000 characters.');
  let spec = current ? validateArcadeGameSpec(current) : defaultGameSpec();
  const before = structuredClone(spec);
  const lower = message.toLowerCase();
  const changes: string[] = [], notes: string[] = [];
  const has = (regex: RegExp) => regex.test(lower);
  const prizeText = lower.split('\n').filter(line => !/^\s*(?:title|name|description|player|collectible|hazard|instructions)\s*:/u.test(line)).join('\n').replace(/\b(?:call(?:ed)?(?: it)?|title(?:d)?|name(?:d)?(?: it)?)\s+["“][^"”\n]+["”]/gu, '');
  const prizes = arcadeToggle(prizeText, 'power[ -]?ups?|prizes?|triple[ -]?shots?|rapid[ -]?fire|shields?|speed[ -]?boosts?');
  const arcadeRequest = has(/\b(?:asteroids?|arcade(?:[ -]style)?(?:\s+game)?)\b/) || prizes === true;
  const toggles = arcadeFeatures.map(([key, feature]) => [key, arcadeToggle(lower, feature)] as const);
  const hasArcadeToggle = toggles.some(([, value]) => value !== undefined);
  let explicitOtherGenre = false;
  if (has(/\b(platformer|platforming|jumping game|jump across|jump between)\b/)) { spec.genre = 'platformer'; explicitOtherGenre = true; changes.push('a jumping platform game'); }
  else if (has(/\b(dodge|dodging|avoid(?:ing)? falling|survival)\b/)) { spec.genre = 'dodge'; changes.push('a falling-obstacle dodging game'); }
  else if (has(/\b(?:collection|collecting|collector)(?:[- ]style)? game\b|\bcollector\b|\bcollect game\b|\b(?:genre|style)\s*[:=]?\s*collect\b|\b(?:switch|change)(?: it)? to (?:a )?collect(?:ion)?\b/) || (!current && !arcadeRequest && !hasArcadeToggle && has(/\b(collect|collecting|gather|gathering)\b/))) { spec.genre = 'collect'; explicitOtherGenre = true; changes.push('a swimming collection game'); }
  if ((arcadeRequest || hasArcadeToggle) && !explicitOtherGenre) {
    spec.genre = 'dodge';
    if (arcadeRequest && !spec.arcade) {
      spec.arcade = { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true };
      spec.theme = 'space'; spec.objects.hazard = 'asteroid';
      changes.push('Asteroids arcade options');
    } else if (!spec.arcade) spec.arcade = { rotation: false, shooting: false, splitAsteroids: false, scoring: false, highScores: false };
    for (const [key, value] of toggles) if (value !== undefined) {
      spec.arcade[key] = value;
      if (key === 'splitAsteroids' && value) spec.arcade.shooting = true;
      if (key === 'highScores' && value) spec.arcade.scoring = true;
      changes.push(`${key} ${value ? 'on' : 'off'}`);
    }
    // An explicit parent switch takes precedence over a dependent feature request.
    if (toggles.find(([key]) => key === 'shooting')?.[1] === false) spec.arcade.shooting = spec.arcade.splitAsteroids = false;
    if (toggles.find(([key]) => key === 'scoring')?.[1] === false) spec.arcade.scoring = spec.arcade.highScores = false;
  }
  if (spec.genre !== 'dodge') {
    delete spec.arcade;
    if (hasArcadeToggle) notes.push('Rotation, shooting, and arcade score options are supported in dodge games.');
  }
  if (spec.version === 5 && (spec.genre !== 'dodge' || !spec.arcade?.shooting)) {
    delete spec.powerUps; spec.version = spec.multiplayer ? 4 : 2;
    changes.push('prizes off');
  }
  // Explicit settings win over incidental object words: stars can belong in a pond.
  const world = lower.match(/\b(pond|underwater|aquarium|lake|ocean|space|galaxy|garden|meadow)\b/)?.[1];
  if (world) {
    spec.theme = ['space', 'galaxy'].includes(world) ? 'space' : ['garden', 'meadow'].includes(world) ? 'garden' : 'pond';
    changes.push(`a ${spec.theme} setting`);
  } else if (has(/\b(stars?|planets?|astronaut)\b/)) { spec.theme = 'space'; changes.push('a space setting'); }
  else if (has(/\bflowers?\b/)) { spec.theme = 'garden'; changes.push('a garden setting'); }
  if (has(/\b(easy|easier|gentle)\b/)) { spec.rules.difficulty = 1; changes.push('easy difficulty'); }
  else if (has(/\b(hard|harder|challenging)\b/)) { spec.rules.difficulty = 4; changes.push('hard difficulty'); }
  const colors: Record<string, string> = { pink: '#efadc4', blue: '#79b9df', green: '#81b29a', purple: '#b99ad7', yellow: '#e8c76b', orange: '#eda16f', red: '#d97a86' };
  const color = lower.match(/\b(?:color|colour)(?:\s*(?:to|is|:|=))?\s*(#[0-9a-f]{6}|pink|blue|green|purple|yellow|orange|red)\b/) || lower.match(/\b(pink|blue|green|purple|yellow|orange|red)\s+(?:axolotl|player|character)\b/);
  if (color) { spec.player.color = colors[color[1]] || color[1]; changes.push('player color'); }
  const snack = lower.match(/\b(?:collect(?:ing)?|gather(?:ing)?)(?:\s+\d+)?(?:\s+(?:pink|blue|green|purple|yellow|orange|red|golden|glowing))?\s+(water snacks?|snacks?|stars?|flowers?|bubbles?)\b/) || lower.match(/\b\d+\s+(water snacks?|snacks?|stars?|flowers?|bubbles?)\b/);
  if (snack) { spec.objects.collectible = snack[1].replace(/s$/u, ''); changes.push(`collectible ${spec.objects.collectible}`); }
  const hazard = lower.match(/\b(?:avoid(?:ing|s)?|dodge|dodging)(?:\s+(?:the|falling))?\s+(rocks?|asteroids?|meteors?|thorns?)\b/);
  if (hazard) { spec.objects.hazard = hazard[1].replace(/s$/u, ''); changes.push(`hazard ${spec.objects.hazard}`); }
  const applyNumber = (label: string, regex: RegExp, assign: (value: number) => void, min: number, max: number, multiplier = 1) => {
    const match = lower.match(regex);
    if (!match) return;
    const value = Number(match[1]) * multiplier;
    if (!Number.isInteger(value) || value < min || value > max) { notes.push(`${label} must be from ${min} to ${max}; I kept the previous value.`); return; }
    assign(value); changes.push(`${label.toLowerCase()} ${value}`);
  };
  applyNumber('Goal', /\b(?:goal|collect|gather)(?:\s*(?:to|is|:|=))?\s*(\d+)\b/, value => { spec.rules.goal = value; }, 3, 40);
  if (!/\b(?:goal|collect|gather)(?:\s*(?:to|is|:|=))?\s*\d+\b/.test(lower)) applyNumber('Goal', /\b(\d+)\s+(?:water snacks?|snacks?|stars?|flowers?|bubbles?)\b/, value => { spec.rules.goal = value; }, 3, 40);
  applyNumber('Time', /\b(\d+)\s*(?:seconds?|secs?)\b/, value => { spec.rules.timeLimit = value; }, 30, 180);
  if (!/\b\d+\s*(?:seconds?|secs?)\b/.test(lower)) applyNumber('Time', /\b(\d+)\s*minutes?\b/, value => { spec.rules.timeLimit = value; }, 30, 180, 60);
  applyNumber('Time', /\btime(?:\s*(?:limit|to|is|:|=))?\s*(\d+)\b/, value => { spec.rules.timeLimit = value; }, 30, 180);
  applyNumber('Lives', /\b(\d+)\s*lives?\b/, value => { spec.rules.lives = value; }, 1, 5);
  applyNumber('Lives', /\blives?(?:\s*(?:to|is|:|=))?\s*(\d+)\b/, value => { spec.rules.lives = value; }, 1, 5);
  applyNumber('Difficulty', /\bdifficulty(?:\s*(?:to|is|:|=))?\s*(\d+)\b/, value => { spec.rules.difficulty = value; }, 1, 5);
  applyNumber('Speed', /\bspeed(?:\s*(?:to|is|:|=))?\s*(\d+)\b/, value => { spec.player.speed = value; }, 2, 8);
  applyNumber('Jump', /\bjump(?:\s*(?:to|is|:|=))?\s*(\d+)\b/, value => { spec.player.jump = value; }, 6, 14);
  const fields: Record<string, (value: string) => void> = {
    title: value => { spec.title = value; }, name: value => { spec.title = value; }, description: value => { spec.description = value; }, player: value => { spec.player.name = value; }, collectible: value => { spec.objects.collectible = value; }, hazard: value => { spec.objects.hazard = value; }, instructions: value => { spec.instructions = value; },
  };
  let customInstructions = false;
  for (const line of message.split('\n')) {
    const match = line.match(/^\s*(title|name|description|player|collectible|hazard|instructions)\s*:\s*(.+?)\s*$/iu);
    if (match) {
      const candidate = structuredClone(spec), field = match[1].toLowerCase();
      fields[field](match[2]);
      try { validateArcadeGameSpec(spec); changes.push(field); if (field === 'instructions') customInstructions = true; }
      catch { Object.assign(spec, candidate); notes.push(`The ${field} needs short, plain text without links or code; I kept its previous value.`); }
    }
  }
  const quotedTitle = message.match(/\b(?:call(?:ed)?(?: it)?|title(?:d)?|name(?:d)?(?: it)?)\s+["“]([^"”\n]+)["”]/iu);
  if (quotedTitle) { const previous = spec.title; spec.title = quotedTitle[1].trim(); try { validateArcadeGameSpec(spec); changes.push('title'); } catch { spec.title = previous; notes.push('Keep the title to 80 plain-text characters.'); } }
  if (changes.length && !customInstructions && spec.arcade) spec.instructions = arcadeInstructions(spec);
  else if (changes.length && !customInstructions) {
    const controls = spec.genre === 'platformer' ? 'Use the arrow keys or WASD to move; Space or Up jumps.' : 'Use the arrow keys or WASD to swim.';
    spec.instructions = `${controls} Collect ${spec.rules.goal} ${spec.objects.collectible}${spec.rules.goal === 1 ? '' : 's'} before time runs out. Avoid ${spec.objects.hazard}s. Touch controls are available below the game.`;
  }
  const countWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const countMatch = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight)(?:[ -]+(?:gentle|easy|tricky|challenging|short|long|fun|gradual|increasingly|progressively|harder)){0,3}[ -]+levels?\b|\blevels?\s*(?:count\s*)?(?:to|is|:|=)\s*(\d+)\b/);
  let count = spec.levels?.length || 3, acceptedCount = false;
  if (countMatch) {
    const token = countMatch[1] || countMatch[2], requested = countWords[token] || Number(token);
    if (requested >= 1 && requested <= 8) { count = requested; acceptedCount = true; changes.push(`${count} levels`); }
    else notes.push('A game supports 1 to 8 levels; I kept the previous level count.');
  }
  const target = lower.match(/\blevel\s+([1-8])\b/), shuffle = /\b(?:shuffle|randomi[sz]e|regenerate)(?:(?:\s+(?:the|all|level))?\s+(?:layouts?|maps?|levels?)\b|\s+level\s+[1-8]\b)|\bnew\s+layouts?\b/u.test(lower);
  const replan = /\b(?:replan|rebuild|redesign)\s+(?:the\s+)?(?:levels?|progression)\b|\badd\s+(?:more\s+)?levels?\b|\blevel\s+progression\b/u.test(lower);
  const arcadeChanged = JSON.stringify(before.arcade) !== JSON.stringify(spec.arcade);
  const mechanicsChanged = JSON.stringify(before.rules) !== JSON.stringify(spec.rules) || before.theme !== spec.theme || before.genre !== spec.genre || JSON.stringify(before.objects) !== JSON.stringify(spec.objects);
  const seedText = `${message}|${spec.title}`;
  if (target && before.version !== 1 && !acceptedCount && !replan) {
    const index = Number(target[1]) - 1, levels = getGameLevels(before);
    if (!levels[index]) { notes.push(`This game does not have level ${index + 1}.`); spec.rules = before.rules; spec.theme = before.theme; }
    else {
      const level = levels[index];
      // Reuse the complete rule parser against this level's current settings.
      // A legacy-shaped context prevents recursive level planning.
      const requested = designArcadeGame(message, { version: 1, title: spec.title, description: spec.description, genre: spec.genre, theme: level.theme, player: spec.player, rules: level.rules, objects: spec.objects, instructions: spec.instructions, ...(spec.arcade ? { arcade: spec.arcade } : {}) }).spec;
      level.rules = requested.rules;
      if (has(/\b(hard|harder|challenging)\b/)) level.rules.difficulty = Math.min(5, Math.max(before.levels![index].rules.difficulty + 1, 4));
      if (world) level.theme = requested.theme;
      if (shuffle) level.seed = layoutSeed(`${level.seed}|${seedText}|${index + 1}`);
      if (JSON.stringify(level.rules) !== JSON.stringify(before.levels![index].rules) || level.theme !== before.levels![index].theme || JSON.stringify(before.objects) !== JSON.stringify(spec.objects)) level.brief = spec.arcade ? arcadeLevelBrief(spec, level.rules.goal, 'Practice this part of the adventure.') : `Practice this part of the adventure. Collect ${level.rules.goal} ${spec.objects.collectible}s within ${level.rules.timeLimit} seconds and avoid ${spec.objects.hazard}s.`;
      spec = { ...spec, rules: before.rules, theme: before.theme, levels };
      changes.push(`level ${index + 1}`);
    }
  } else if (!current || acceptedCount || replan || before.version !== 1 && mechanicsChanged) {
    spec = planGameLevels(spec, count, seedText, shuffle ? [] : getGameLevels(before).slice(0, before.version !== 1 ? 8 : 0));
    changes.push('a staged level plan');
  } else if (shuffle && before.version !== 1) {
    spec.levels = getGameLevels(spec).map((level, index) => ({ ...level, seed: layoutSeed(`${level.seed}|${seedText}|${index + 1}`) }));
    changes.push('fresh saved layouts');
  }
  if (before.version !== 1 && spec.version !== 1 && arcadeChanged && !mechanicsChanged && !acceptedCount && !replan) {
    spec.levels = getGameLevels(spec).map(level => ({ ...level, brief: refreshArcadeBrief(before, spec, level.brief) }));
  }
  if (spec.version !== 1 && !customInstructions && (changes.length || !current)) {
    const controls = spec.genre === 'platformer' ? 'Use arrows or WASD to move; Space or Up jumps.' : 'Use arrows or WASD to swim.';
    spec.instructions = spec.arcade ? arcadeInstructions(spec) : `${controls} Complete each level’s collection goal and avoid ${spec.objects.hazard}s. Each level starts with fresh lives and time. Touch controls are available below the game.`;
  }
  if (has(/\b(3d|chat|weapons?|upload|custom code|javascript|payment|purchase|soundtrack|music)\b/) || has(/\bonline\b/) && !has(/\b(?:high[ -]?scores?|leaderboards?)\b/) || /https?:\/\/|<script|javascript:/iu.test(message)) notes.push('This builder supports 2D games, optional two-player cooperation, and shared high scores for signed-in players. It cannot add custom code, external assets, music, chat, or purchases.');
  const cooperative = arcadeToggle(lower, 'multiplayer|two[ -]player|2[ -]player|cooperative|co-op');
  if (cooperative === true) {
    if (spec.version === 1) spec = planGameLevels(spec, 1, seedText);
    spec = validateArcadeGameSpec({ ...spec, version: spec.version === 5 ? 5 : 4, multiplayer: { mode: 'cooperative', maxPlayers: 2 } });
    changes.push('optional two-player cooperation');
  } else if (cooperative === false && !!spec.multiplayer) {
    const { multiplayer: _multiplayer, ...single } = spec;
    spec = validateArcadeGameSpec({ ...single, version: spec.version === 5 ? 5 : 2 });
    changes.push('single-player only');
  }
  if (prizes === true) {
    if (spec.genre === 'dodge' && spec.arcade?.shooting) {
      if (spec.version === 1) spec = planGameLevels(spec, 1, seedText);
      spec = validateArcadeGameSpec({ ...spec, version: 5, powerUps: spec.powerUps ?? defaultPowerUps() });
      changes.push('periodic ship prizes');
    } else notes.push('Prizes are available in dodge games with shooting enabled.');
  } else if (prizes === false && spec.version === 5) {
    const { powerUps: _prizes, ...without } = spec;
    spec = validateArcadeGameSpec({ ...without, version: spec.multiplayer ? 4 : 2 });
    changes.push('prizes off');
  }
  const summary = changes.length ? `Updated ${[...new Set(changes)].join(', ')}.` : 'I can build a collection, dodging, or platform game in a pond, space, or garden.';
  const help = changes.length ? 'Review the level plan, then test each level. Ask for “5 levels”, “level 2 harder”, or “shuffle layouts”. The free guided plan uses fixed progression rules; a configured AI assistant can design a tailored progression.' : 'Try “a space platformer, 3 levels, collect 12, 90 seconds, 3 lives,” or use a line such as “Title: Moon Axolotl”.';
  return { spec: validateArcadeGameSpec(spec), reply: [summary, ...notes, help].join(' ') };
}

/** Preserve legacy layouts and dispatch only validated data to the matching fixed engine. */
export function validateGameSpec(value: unknown): GameSpec {
  return value && typeof value === 'object' && (value as { version?: unknown }).version === 3 ? createWordGameEngine().validate(value) : validateArcadeGameSpec(value);
}
export function designGame(message: string, current?: GameSpec): { spec: GameSpec; reply: string } {
  const validated = current ? validateGameSpec(current) : undefined;
  if (validated?.version === 3 || wordGameGenre(message)) return designWordGame(message, validated?.version === 3 ? validated : undefined);
  return designArcadeGame(message, validated);
}
