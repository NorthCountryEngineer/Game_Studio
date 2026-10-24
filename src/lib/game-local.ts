import { designGame, getGameLevels, validateGameSpec } from './game-design';
import type { Game, GameConfig, GameSettings, GameSpec } from './game-types';

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Receipt = { id: string; message: string; revision: number };
type State = { config: GameConfig; drafts: Game[]; published: Game[]; receipts: Record<string, Receipt[]>; prompts: Record<string, string>; deleted: string[] };
const key = 'game-studio-games:v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = () => new Date().toISOString();
const copy = <T,>(value: T): T => structuredClone(value);
function identifier(value: string) { if (!uuid.test(value)) throw new Error('Invalid game or request identifier.'); }
function prompt(value: string) { if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('Describe your game in 1–2,000 characters.'); return value.trim(); }
export function validateGameConfig(value: GameConfig): GameConfig {
  if (!value || Object.keys(value).sort().join(',') !== 'assistantModeId,creationEnabled,revision,version' || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.creationEnabled !== 'boolean' || typeof value.assistantModeId !== 'string' || value.assistantModeId && !/^[a-z][a-z0-9_-]{0,63}$/.test(value.assistantModeId)) throw new Error('Choose valid game creation settings and an available assistant mode.');
  return { version: 1, revision: value.revision, creationEnabled: value.creationEnabled, assistantModeId: value.assistantModeId };
}

/** Browser-only game rehearsal. No generated code, model calls, uploads, or cloud writes. */
export class LocalGameLibrary {
  constructor(private storage: StoragePort) {}
  private read(): State {
    const raw = this.storage.getItem(key);
    if (!raw) return { config: { version: 1, revision: 0, creationEnabled: true, assistantModeId: '' }, drafts: [], published: [], receipts: {}, prompts: {}, deleted: [] };
    try {
      const state = JSON.parse(raw) as State;
      validateGameConfig(state.config);
      if (!Array.isArray(state.deleted)) state.deleted = [];
      if (!Array.isArray(state.drafts) || !Array.isArray(state.published) || !state.receipts || !state.prompts) throw new Error();
      for (const game of [...state.drafts, ...state.published]) { identifier(game.id); validateGameSpec(game.spec); }
      return state;
    } catch { throw new Error('The local game library could not be read. Its saved data has not been changed.'); }
  }
  private write(state: State) {
    const data = JSON.stringify(state);
    if (new TextEncoder().encode(data).length > 3500000) throw new Error('This browser’s game library is full. Delete old drafts before adding more.');
    this.storage.setItem(key, data);
  }
  private enabled(state: State) { if (!state.config.creationEnabled) throw new Error('Game creation is paused by an administrator. Published games remain playable.'); }
  private draft(state: State, id: string, revision?: number): Game {
    identifier(id); const game = state.drafts.find(item => item.id === id);
    if (!game) throw new Error('This game could not be found. Reload the library.');
    if (revision !== undefined && game.revision !== revision) throw new Error('This game changed in another window. Reload it before continuing.');
    return game;
  }
  private update(state: State, game: Game) { game.revision += 1; game.updatedAt = now(); this.write(state); return copy(game); }
  settings(): GameSettings { const config = copy(this.read().config); return { config, canCreate: config.creationEnabled, canPublish: true, canManage: true, canAdminContent: true }; }
  saveSettings(config: GameConfig, expectedRevision: number): GameSettings {
    const state = this.read(), clean = validateGameConfig(config);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || clean.revision !== expectedRevision || state.config.revision !== expectedRevision) throw new Error('Game settings changed. Reload settings before saving again.');
    // Preview uses only the free guided designer, even when a live assistant mode is configured.
    state.config = { ...clean, revision: expectedRevision + 1 }; this.write(state); return this.settings();
  }
  list(published = false): Game[] { const state = this.read(); return copy(published ? state.published : state.drafts).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string, published = false): Game {
    const state = this.read(); identifier(id);
    if (!published) return copy(this.draft(state, id));
    const game = state.published.find(item => item.id === id);
    if (!game) throw new Error('This game is not published. It may have been removed from the arcade.');
    return copy(game);
  }
  create(id: string, description: string): Game {
    identifier(id); const message = prompt(description), state = this.read(); this.enabled(state);
    if (state.deleted.includes(id)) throw new Error('This game was deleted. Start a new game with a new identifier.');
    const existing = state.drafts.find(item => item.id === id);
    if (existing) { if (state.prompts[id] !== message) throw new Error('This game identifier already belongs to another idea.'); return copy(existing); }
    if (state.drafts.length >= 200) throw new Error('This game library has reached its draft limit. Delete an old draft first.');
    const result = designGame(message), stamp = now();
    const game: Game = { id, spec: result.spec, revision: 0, status: 'Draft', messages: [{ id: crypto.randomUUID(), role: 'user', text: message }, { id: crypto.randomUUID(), role: 'assistant', text: result.reply }], createdAt: stamp, updatedAt: stamp };
    state.drafts.unshift(game); state.prompts[id] = message; state.receipts[id] = []; this.write(state); return copy(game);
  }
  save(id: string, revision: number, spec: GameSpec): Game {
    const clean = validateGameSpec(spec), state = this.read(); this.enabled(state); const game = this.draft(state, id, revision);
    game.spec = clean; game.status = 'Draft'; delete game.testedRevision; return this.update(state, game);
  }
  message(id: string, revision: number, requestId: string, description: string): Game {
    identifier(requestId); const message = prompt(description), state = this.read(); this.enabled(state); const game = this.draft(state, id);
    const receipt = (state.receipts[id] || []).find(item => item.id === requestId);
    if (receipt) { if (receipt.message !== message || receipt.revision !== revision) throw new Error('This request was already used for a different message.'); return copy(game); }
    if (revision !== game.revision) throw new Error('This game changed in another window. Reload it before continuing.');
    if ((state.receipts[id]?.length || 0) >= 40) throw new Error('This conversation is full. Duplicate the game to start a fresh design conversation.');
    const result = designGame(message, game.spec);
    game.spec = result.spec; game.status = 'Draft'; delete game.testedRevision;
    game.messages = [...(game.messages || []), { id: requestId, role: 'user', text: message }, { id: crypto.randomUUID(), role: 'assistant', text: result.reply }];
    state.receipts[id] = [...(state.receipts[id] || []), { id: requestId, message, revision }]; return this.update(state, game);
  }
  test(id: string, revision: number, reviewedLevelIds?: string[]): Game {
    const state = this.read(), game = this.draft(state, id, revision);
    validateGameSpec(game.spec);
    if (game.spec.version === 2) {
      const ids = getGameLevels(game.spec).map(level => level.id);
      if (!Array.isArray(reviewedLevelIds) || reviewedLevelIds.length !== ids.length || new Set(reviewedLevelIds).size !== ids.length || reviewedLevelIds.some(id => !ids.includes(id))) throw new Error('Complete and review every level of this saved version before marking the playtest complete.');
    }
    game.testedRevision = game.revision + 1; return this.update(state, game);
  }
  publish(id: string, revision: number): Game {
    const state = this.read(); this.enabled(state); const game = this.draft(state, id, revision);
    if (game.testedRevision !== game.revision) throw new Error('Complete and acknowledge a playtest of this saved revision before publishing.');
    game.status = 'Published'; game.publishedAt = now(); game.publishedRevision = game.revision + 1;
    game.revision += 1; game.updatedAt = now();
    const snapshot: Game = { id: game.id, spec: copy(game.spec), revision: game.revision, status: game.status, createdAt: game.createdAt, updatedAt: game.updatedAt, publishedAt: game.publishedAt, publishedRevision: game.publishedRevision };
    state.published = [snapshot, ...state.published.filter(item => item.id !== id)]; this.write(state); return copy(game);
  }
  unpublish(id: string, revision: number): Game {
    const state = this.read(), game = this.draft(state, id, revision); state.published = state.published.filter(item => item.id !== id);
    game.status = 'Draft'; delete game.publishedRevision; delete game.publishedAt; return this.update(state, game);
  }
  duplicate(id: string, revision: number, newId: string): Game {
    identifier(newId); const state = this.read(); this.enabled(state); const source = this.draft(state, id, revision);
    if (state.deleted.includes(newId) || state.drafts.some(item => item.id === newId)) throw new Error('This copy identifier already exists. Reload the library.');
    const stamp = now(), game: Game = { id: newId, spec: validateGameSpec({ ...source.spec, title: `${source.spec.title.slice(0, 70)} (copy)` }), revision: 0, status: 'Draft', messages: [], createdAt: stamp, updatedAt: stamp };
    state.drafts.unshift(game); state.prompts[newId] = ''; state.receipts[newId] = []; this.write(state); return copy(game);
  }
  delete(id: string, revision: number): void {
    const state = this.read(); this.draft(state, id, revision); state.drafts = state.drafts.filter(item => item.id !== id); state.published = state.published.filter(item => item.id !== id);
    delete state.receipts[id]; delete state.prompts[id]; state.deleted.push(id); this.write(state);
  }
}
