import { useEffect, useRef, useState } from 'react';
import { createGame, deleteGame, duplicateGame, getGame, getGameSettings, listGames, markGameTested, publishGame, saveGame, saveGameSettings, sendGameMessage, unpublishGame, generateCrosswordSuggestions } from '../lib/game-api';
import { defaultGameSpec, getGameLevels, validateGameSpec, updateAsteroidSettings } from '../lib/game-design';
import { gameReviewLevelIds, isCooperativeGameSpec, isEndlessAsteroids } from '../lib/game-types';
import { removeUnsupportedPowerUps, setCooperativeMode, updateArcadeLevelPlan } from '../lib/game-multiplayer-design';
import { WordGameEditor, buildPlatformerStarter, formatCreationPrompt, gameFormatStarters, wordGenreNames, type StarterFormat } from './WordGameEditor';
import type { ArcadeGameSpec, Game, GameConfig, GameLevel, GameResult, GameSettings, GameSpec, GameSprites } from '../lib/game-types';
import { getAgentSettings } from '../lib/agent-api';
import { isCore } from '../lib/core';
import { useConfirm } from './Confirm';
import { ItemActions } from './ItemActions';
import { GamePlayer } from './GamePlayer';
import { AsteroidSpriteEditor } from './AsteroidSpriteEditor';
import { AsteroidChallengeEditor } from './AsteroidChallengeEditor';
import { acceptEndlessPlaytestReview, arcadeAuthoringInstructions, type PrivatePlaytestReview } from '../lib/asteroid-authoring';
import { AsteroidPrizeEditor, AsteroidPrizeGuide } from './AsteroidPrizeEditor';
import { ServiceBadge } from './ServiceBadge';
import { MultiplayerLobby } from './MultiplayerLobby';
import { useBranding, useIntegrationConfig } from '../lib/branding';
import { createCreatorURL, createEmbedURL } from '../lib/integration';
import { gameStudioSelectionOrigin, loadMultiplayerConfig } from '../lib/game-multiplayer';
import { reconcileGameFlow } from '../lib/game-flow';
import { LevelFlowEditor, LevelSettings } from './LevelFlowEditor';
import { MultiGameEditor, multiStepTitle, multiStepLabel } from './MultiGameEditor';
import { defaultMultiGameSpec } from '../lib/multi-game';
import type { MultiGameProgress, MultiMaterialStep } from '../lib/multi-game-session';
import type { CrosswordGenerator } from './CrosswordSuggestionsEditor';
import { CrosswordGenerationRequest } from '../lib/crossword-generation-request';
import { HostSelectionLink, type HostSelectionConnection } from './HostSelectionLink';

const examples = ['An Asteroids game with endless survival, three asteroid sizes and collectible prizes.', 'An Asteroids game with 4 levels that gradually increase the challenge.', 'A two-player Asteroids game with prizes, enemy ships and endless survival.'];
type Props = { adminMode: boolean; onDirty: (dirty: boolean) => void; navigate: (path: string) => Promise<void>; initialGameId?: string };
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Reload and try again.';

async function availableWritingModes() {
  const value = await getAgentSettings();
  return value.config.modes.filter(mode => {
    const agent = value.config.agents.find(item => item.id === mode.agentId && item.enabled);
    const workflow = value.config.workflows.find(item => item.id === mode.workflowId && item.enabled);
    const model = value.config.models.find(item => item.id === agent?.modelId && item.enabled);
    return mode.enabled && agent && workflow && model && ['local', 'bedrock'].includes(model.provider) && (!value.availableModeIds || value.availableModeIds.includes(mode.id));
  }).map(mode => ({ id: mode.id, name: mode.name, provider: value.config.models.find(model => model.id === value.config.agents.find(agent => agent.id === mode.agentId)?.modelId)!.provider }));
}


export function GameStudio({ adminMode, onDirty, navigate, initialGameId }: Props) {
  const brand = useBranding(), integration = useIntegrationConfig();
  const confirm = useConfirm(), busyRef = useRef(false), chatEnd = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<GameSettings>(), [config, setConfig] = useState<GameConfig>(), [modes, setModes] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [games, setGames] = useState<Game[]>([]), [game, setGame] = useState<Game>(), [spec, setSpec] = useState<GameSpec>(() => defaultGameSpec());
  const [starter, setStarter] = useState<StarterFormat>('arcade');
  const [creationSprites, setCreationSprites] = useState<GameSprites>(), [spriteBusy, setSpriteBusy] = useState(false);
  const [idea, setIdea] = useState(examples[0]), [message, setMessage] = useState(''), [dirty, setDirty] = useState(false), [settingsDirty, setSettingsDirty] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('Choose a game format, then describe your idea.');
  const [playtest, setPlaytest] = useState(false), [playNumber, setPlayNumber] = useState(0), [result, setResult] = useState<GameResult>(), [privateReview, setPrivateReview] = useState<PrivatePlaytestReview>();
  const [selectionConnection, setSelectionConnection] = useState<HostSelectionConnection>(() => isCore ? { status: 'loading' } : { status: 'ready', origin: window.location.origin });
  const [selectionRetry, setSelectionRetry] = useState(0);
  const [materialReviewed, setMaterialReviewed] = useState(false);
  const [previewLevel, setPreviewLevel] = useState(''), [reviewedLevels, setReviewedLevels] = useState<string[]>([]);
  const embedChannels = useRef(new Map<string, string>());
  const createRetry = useRef<{ id: string; prompt: string }>(), turnRetry = useRef<{ id: string; gameId: string; revision: number; message: string }>();
  const canEdit = Boolean(settings?.canCreate && settings.config.creationEnabled), creationPaused = settings?.config.creationEnabled === false;
  const crosswordRetry = useRef(new CrosswordGenerationRequest());
  const configChanged = settingsDirty;
  useEffect(() => {
    if (!isCore) return;
    let active = true;
    setSelectionConnection({ status: 'loading' });
    void loadMultiplayerConfig().then(value => { if (active) setSelectionConnection({ status: 'ready', origin: gameStudioSelectionOrigin(window.location.origin, value) }); }).catch(() => { if (active) setSelectionConnection({ status: 'error' }); });
    return () => { active = false; };
  }, [selectionRetry]);

  useEffect(() => { onDirty(dirty || configChanged || !game && Boolean(creationSprites)); }, [dirty, configChanged, onDirty, game, creationSprites]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    void Promise.all([getGameSettings(), listGames(), initialGameId ? getGame(initialGameId) : Promise.resolve(undefined)]).then(([nextSettings, nextGames, selected]) => {
      if (!active) return;
      setSettings(nextSettings); setConfig(nextSettings.config); setSettingsDirty(false); setGames(nextGames);
      if (selected) load(selected); else { setGame(undefined); setDirty(false); setPlaytest(false); setResult(undefined); setPrivateReview(undefined); setReviewedLevels([]); setMaterialReviewed(false); setPreviewLevel(''); }
      if (nextSettings.canManage) void availableWritingModes().then(value => { if (active) setModes(value); }).catch(() => { /* Guided creation does not depend on assistant availability. */ });
    }).catch(value => { if (active) setError(messageOf(value)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initialGameId]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [game?.messages?.length]);
  useEffect(() => {
    let active = true;
    const check = () => { void getGameSettings().then(value => { if (active) { setSettings(value); if (!settingsDirty) setConfig(value.config); } }).catch(() => { /* The next protected action rechecks server authorization. */ }); };
    window.addEventListener('focus', check); return () => { active = false; window.removeEventListener('focus', check); };
  }, [settingsDirty]);

  function load(value: Game) {
    crosswordRetry.current.clear();
    setGame(value); setSpec(structuredClone(value.spec)); setDirty(false); setPlaytest(false); setResult(undefined); setPrivateReview(undefined); setReviewedLevels([]); setMaterialReviewed(false); setPreviewLevel(''); setMessage(''); turnRetry.current = undefined;
    setNotice(value.status === 'Published' ? 'Published version is live. New changes stay private until you test and publish again.' : 'Private draft loaded. Describe a change or fine-tune its details.');
  }
  async function refresh() { setGames(await listGames()); }
  async function run(task: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { await task(); } catch (value) { setError(messageOf(value)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function open(value: Game) {
    if (busyRef.current || (dirty || !game && Boolean(creationSprites)) && !await confirm('Leave these game changes without saving?')) return;
    await run(async () => { load(await getGame(value.id)); });
  }
  async function newIdea() {
    if (busyRef.current || (dirty || !game && Boolean(creationSprites)) && !await confirm('Leave these game changes without saving?')) return;
    setGame(undefined); setStarter('arcade'); setIdea(examples[0]); setCreationSprites(undefined); setDirty(false); setPlaytest(false); setResult(undefined); setPrivateReview(undefined); setReviewedLevels([]); setMaterialReviewed(false); setPreviewLevel(''); setError(''); setNotice('Choose a game format, then describe your idea.'); createRetry.current = undefined;
  }
  async function create() {
    if (spriteBusy || !canEdit || !idea.trim()) return;
    await run(async () => {
      const text = formatCreationPrompt(starter, idea); if (createRetry.current?.prompt !== text) createRetry.current = { id: crypto.randomUUID(), prompt: text };
      const value = await createGame(createRetry.current.id, text); createRetry.current = undefined; load(value); setIdea('');
      if (starter === 'arcade' && value.spec.version !== 3 && value.spec.version !== 8) {
        const next = { ...updateAsteroidSettings({ ...value.spec, genre: 'dodge', theme: 'space', arcade: { rotation: true, splitAsteroids: true, scoring: true, highScores: true, ...value.spec.arcade, shooting: true } }, {}), ...(creationSprites ? { sprites: creationSprites } : {}) };
        next.levels = next.levels?.map(level => ({ ...level, theme: 'space' }));
        setSpec(next); setDirty(true); load(await saveGame(value, next)); setCreationSprites(undefined);
      }
      if (starter === 'platformer') {
        const next = buildPlatformerStarter(value.spec.version === 3 || value.spec.version === 8 ? undefined : value.spec, idea);
        setSpec(next); setDirty(true); load(await saveGame(value, next)); setCreationSprites(undefined);
      }
      if (starter === 'multi-game' && value.spec.version !== 8) { const next = defaultMultiGameSpec(); setSpec(next); setDirty(true); load(await saveGame(value, next)); }
      await refresh(); setNotice('Your first playable draft is ready. Talk through changes, then save and playtest.');
    });
  }
  function crosswordGenerator(path: string[]): CrosswordGenerator {
    return {
      status: game?.operationState ? { available: false, reason: 'The last assistant request has no confirmed result. Edit and save the draft, or duplicate it, before generating more words.' } : settings?.crosswordGenerator ?? { available: false, reason: 'A game administrator can configure a crossword word assistant in Game settings.' },
      generate: async () => {
        if (!game || busyRef.current || spriteBusy || dirty || !canEdit || game.operationState) throw new Error('Save your title and description before generating words.');
        const step = game.spec.version === 8 ? game.spec.steps.find(item => item.id === path[0]) : undefined;
        const crossword = path.length === 0 ? game.spec : step?.type === 'game' ? step.spec : undefined;
        if (!crossword || crossword.version !== 3 || crossword.genre !== 'crossword') throw new Error('Save this crossword before generating words.');
        const { requestId, game: requestGame } = crosswordRetry.current.get(game, path);
        busyRef.current = true; setBusy(true); setError(''); setPlaytest(false);
        setResult(undefined); setPrivateReview(undefined); setReviewedLevels([]); setMaterialReviewed(false); setPreviewLevel('');
        try {
          const response = await generateCrosswordSuggestions(requestGame, requestId, path, crossword.title, crossword.description);
          setGame(response.game); setGames(previous => previous.map(item => item.id === response.game.id ? response.game : item));
          crosswordRetry.current.clear();
          setNotice('Word suggestions are ready. Choose which words to use, then save and playtest.');
          return { proposal: response.proposal, revision: response.game.revision };
        } catch (cause) {
          try { const latest = await getGame(game.id); if (JSON.stringify(validateGameSpec(latest.spec)) === JSON.stringify(validateGameSpec(game.spec))) { setGame(latest); setGames(previous => previous.map(item => item.id === latest.id ? latest : item)); if (latest.operationState) crosswordRetry.current.clear(); } } catch { /* The next reload can recover metadata without repeating a model request. */ }
          throw cause;
        } finally { busyRef.current = false; setBusy(false); }
      },
    };
  }

  function refreshInstructions() {
    if (spec.version === 3 || spec.version === 8) return;
    change({ ...spec, instructions: arcadeAuthoringInstructions(spec) });
  }
  function changeGenre(genre: ArcadeGameSpec['genre']) {
    if (spec.version === 3 || spec.version === 7 || spec.version === 8) return;
    const next = { ...spec, genre };
    if (genre !== 'dodge') delete next.arcade;
    change(removeUnsupportedPowerUps(next));
  }
  function setArcadeEnabled(enabled: boolean) {
    if (spec.version === 3 || spec.version === 8) return;
    const next = { ...spec };
    if (enabled) next.arcade = { rotation: true, shooting: true, splitAsteroids: true, scoring: true, highScores: true };
    else delete next.arcade;
    change(removeUnsupportedPowerUps(next));
  }
  function changeArcade(option: keyof NonNullable<ArcadeGameSpec['arcade']>, enabled: boolean) {
    if (spec.version === 3 || spec.version === 8 || !spec.arcade) return;
    const arcade = { ...spec.arcade, [option]: enabled };
    if (option === 'shooting' && !enabled) arcade.splitAsteroids = false;
    if (option === 'scoring' && !enabled) arcade.highScores = false;
    change(removeUnsupportedPowerUps({ ...spec, arcade }));
  }
  function change(next: GameSpec) { setSpec(next); setDirty(true); setPlaytest(false); setResult(undefined); setPrivateReview(undefined); setReviewedLevels([]); setMaterialReviewed(false); setPreviewLevel(''); setNotice('Unsaved changes. Save this version before playtesting.'); }
  function changeLevels(levels: GameLevel[]) { if (spec.version === 3 || spec.version === 8) return; const next = updateArcadeLevelPlan(spec, levels); if (spec.flow) next.flow = reconcileGameFlow(spec.flow, levels); change(next); }
  function updateLevel(id: string, patch: Partial<GameLevel>) { if (spec.version === 3 || spec.version === 8) return; changeLevels(getGameLevels(spec).map(level => level.id === id ? { ...level, ...patch } : level)); }
  function recordPlaytest(value: GameResult) {
    setResult(value); setPrivateReview(undefined);
    setReviewedLevels(previous => [...new Set([...previous, ...value.reviewedLevelIds])].filter(id => gameReviewLevelIds(game!.spec).includes(id)));
  }
  function recordMultiProgress(value: MultiGameProgress) {
    if (!game || game.spec.version !== 8 || dirty || !playtest) return;
    setReviewedLevels(previous => [...new Set([...previous, ...value.reviewedStepIds])].filter(id => gameReviewLevelIds(game.spec).includes(id)));
  }
  function recordPrivateReview(value: PrivatePlaytestReview) {
    if (!game || dirty || !playtest) return;
    const reviewed = acceptEndlessPlaytestReview(game.spec, value);
    if (!reviewed.length) return;
    setPrivateReview(value); setResult(undefined);
    setReviewedLevels(previous => [...new Set([...previous, ...reviewed])]);
    setNotice('Endless playtest recorded. Review the run, then acknowledge this saved version when you are ready.');
  }
  async function save() {
    if (!game || !canEdit) return;
    await run(async () => { const next = await saveGame(game, validateGameSpec(spec)); load(next); await refresh(); setNotice('Changes saved privately. Complete a fresh playtest before publishing.'); });
  }
  async function send(designPrompt?: string) {
    const text = (designPrompt ?? message).trim();
    if (!game || !canEdit || !text || dirty || game.operationState) return;
    await run(async () => {
      if (!turnRetry.current || turnRetry.current.gameId !== game.id || turnRetry.current.message !== text || turnRetry.current.revision !== game.revision) turnRetry.current = { id: crypto.randomUUID(), gameId: game.id, revision: game.revision, message: text };
      const next = await sendGameMessage(game, turnRetry.current.id, text); turnRetry.current = undefined; load(next); if (designPrompt) setMessage(message); await refresh(); setNotice('Design updated and saved privately. Review the result, then try a fresh playtest.');
    });
  }
  async function duplicate(value: Game) {
    if (!canEdit || dirty) { if (dirty) setError('Save your current changes before duplicating a game.'); return; }
    await run(async () => { load(await duplicateGame(value)); await refresh(); setNotice('A new private copy is ready. Its playtest and publication start fresh.'); });
  }
  async function remove(value: Game) {
    if (!await confirm(`Permanently delete “${value.spec.title}”? Its private draft and published game will be removed. This cannot be undone.`)) return;
    await run(async () => { await deleteGame(value); if (game?.id === value.id) { setGame(undefined); setDirty(false); setPlaytest(false); setResult(undefined); setPrivateReview(undefined); setReviewedLevels([]); setMaterialReviewed(false); setPreviewLevel(''); } await refresh(); setNotice('Game deleted.'); });
  }
  async function acknowledge() {
    if (!game || !allReviewed || dirty) return;
    await run(async () => { const next = await markGameTested(game, reviewedLevels); setGame(next); setPlaytest(false); await refresh(); setNotice('Playtest acknowledged for this saved version. You can publish when you are ready.'); });
  }
  async function publish() {
    if (!game || dirty || !canEdit || !settings?.canPublish || game.testedRevision !== game.revision) return;
    if (!await confirm(`Publish “${game.spec.title}” for everyone to play? This shares the saved, tested version of the game.`)) return;
    await run(async () => { load(await publishGame(game)); await refresh(); setNotice('Your game is live in Games! Future edits will stay private until you publish again.'); });
  }
  async function unpublish() {
    if (!game || !await confirm('Remove this game from the public Games section? Its private draft will remain.')) return;
    await run(async () => { load(await unpublishGame(game)); await refresh(); setNotice('Game unpublished. The private draft is still here.'); });
  }
  async function reload() {
    if (dirty && !await confirm('Reload this game and discard unsaved changes?')) return;
    await run(async () => { const currentSettings = await getGameSettings(); setSettings(currentSettings); if (currentSettings.canManage) { try { setModes(await availableWritingModes()); } catch { setModes([]); } } if (!settingsDirty) setConfig(currentSettings.config); if (game) load(await getGame(game.id)); await refresh(); setNotice('Game library reloaded.'); });
  }
  async function saveConfig() {
    if (!config || !settings?.canManage) return;
    await run(async () => { const next = await saveGameSettings(config, settings.config.revision); setSettings(next); setConfig(next.config); setSettingsDirty(false); setNotice(next.config.creationEnabled ? 'Game creation is enabled.' : 'Game creation is paused. Published games remain playable.'); });
  }
  function embedURL(hostId: string) {
    if (!game) return '';
    if (!embedChannels.current.has(hostId)) embedChannels.current.set(hostId, crypto.randomUUID());
    return createEmbedURL(window.location.origin, game.id, { hostId, channel: embedChannels.current.get(hostId)! });
  }
  const live = Boolean(game?.publishedRevision !== undefined), tested = Boolean(game && game.testedRevision === game.revision && !dirty);
  const levels = spec.version === 3 || spec.version === 8 ? [] : getGameLevels(spec), savedLevels = game && game.spec.version !== 3 && game.spec.version !== 8 ? getGameLevels(game.spec) : [];
  const reviewItems = game ? game.spec.version === 8 ? game.spec.steps.map(step => ({ id: step.id, title: `${multiStepTitle(step)} · ${multiStepLabel(step).toLowerCase()}` })) : game.spec.version === 3 ? [{ id: 'level-1', title: wordGenreNames[game.spec.genre] }] : savedLevels.filter(level => gameReviewLevelIds(game.spec).includes(level.id)) : [];
  const endless = isEndlessAsteroids(spec), savedEndless = Boolean(game && isEndlessAsteroids(game.spec));
  const materialSteps: MultiMaterialStep[] = !game || game.spec.version === 3 ? [] : game.spec.version === 8 ? game.spec.steps.flatMap<MultiMaterialStep>(step => step.type === 'material' ? [step] : step.spec.version !== 3 ? step.spec.flow?.nodes.filter(node => node.type === 'material').map(node => ({ ...node, id: `${step.id}/${node.id}`, title: `${step.spec.title}: ${node.title}` })) ?? [] : []) : game.spec.flow?.nodes.filter(node => node.type === 'material') ?? [];
  const allReviewed = Boolean(game && reviewItems.length && reviewItems.every(level => reviewedLevels.includes(level.id)) && (!materialSteps.length || materialReviewed));
  const wordGame = game?.spec.version === 3, multiGame = game?.spec.version === 8;

  return <main id="main" className="game-studio"><aside className="game-sidebar"><span className="eyebrow">DESIGN. PLAYTEST. PUBLISH.</span><h1>{brand.appName}<span aria-hidden="true">✦</span></h1><button className="button primary" disabled={busy || loading || !canEdit} onClick={() => void newIdea()}>＋ New game</button><button className="text-button" onClick={() => void navigate('/games')}>Visit the Games shelf ↗</button><div className="game-draft-heading">YOUR GAME DRAFTS <span>{games.length}</span></div><div className="game-draft-list">{games.map(item => <div className="game-draft-row" key={item.id}><button className={`game-draft-item ${game?.id === item.id ? 'active' : ''}`} disabled={busy} onClick={() => void open(item)}><strong>{item.spec.title}</strong><small>{item.publishedRevision !== undefined ? 'Live version + private draft' : 'Private draft'} · {item.spec.version === 8 ? 'Multi-game' : item.spec.version === 3 ? wordGenreNames[item.spec.genre] : item.spec.version === 7 ? '2D Platformer' : item.spec.arcade ? 'Asteroids' : item.spec.genre}</small></button>{adminMode && settings?.canAdminContent && <ItemActions label={item.spec.title} disabled={busy} onUpdate={() => open(item)} onDuplicate={() => duplicate(item)} onDelete={() => remove(item)} />}</div>)}{!loading && !games.length && <p>Your first little adventure belongs here.</p>}</div><div className="game-studio-note"><span aria-hidden="true">✎</span><strong>Make it. Try it. Share it.</strong><p>Every game starts as a private draft. Every game gets a playtest before publication.</p></div><button className="text-button" disabled={busy || loading} onClick={() => void reload()}>↻ Reload library</button></aside>
    <section className="game-workbench">{!game && <MultiplayerLobby navigate={navigate}/>}<div className="game-workbench-heading"><div><span className="eyebrow">THE GAME WORKSHOP</span><h2>{game ? game.spec.title : 'What shall we play?'}</h2></div><span className="game-private-badge">{game ? live ? 'LIVE + PRIVATE WORKSPACE' : 'PRIVATE DRAFT' : 'START WITH AN IDEA'}</span></div>
      <p className="game-status" role="status">{busy ? 'Working on your game…' : notice}</p>{error && <div className="error game-error" role="alert"><p>{error}</p><button className="text-button" disabled={busy} onClick={() => void reload()}>Reload saved game</button></div>}
      {loading ? <p role="status">Opening the game workshop…</p> : <>
        {creationPaused && <div className="game-notice" role="status"><strong>Game creation is taking a little break.</strong><p>An administrator has paused new games, design changes, copies, and publication. Saved games can still be played and playtested.</p></div>}
        {!settings?.canCreate && !creationPaused && <div className="game-notice"><strong>You have a seat in the workshop.</strong><p>Your account can view its available game tools. An application administrator can grant game creation access.</p></div>}
        {!game ? <section className="game-idea-card"><span className="eyebrow">STEP 1 · CHOOSE YOUR GAME</span><h3>What shall we make?</h3><p>Create Asteroids, a 2D platformer, a word game or a multi-game journey. Describe the topic and audience, then refine the saved draft through conversation or direct editing.</p><div className="game-format-starters" role="group" aria-label="Game format">{gameFormatStarters.map(format => <button key={format.id} aria-pressed={starter === format.id} className={starter === format.id ? 'selected' : ''} disabled={busy || !canEdit} onClick={() => { setStarter(format.id); setIdea(format.example); }}><span aria-hidden="true">{format.symbol}</span><strong>{format.label}</strong><small>{format.description}</small></button>)}</div><label htmlFor="game-idea">Your game idea</label><textarea id="game-idea" value={idea} maxLength={1800} rows={5} disabled={busy || !canEdit} placeholder={gameFormatStarters.find(format => format.id === starter)!.example} onChange={event => setIdea(event.target.value)}/><div className="game-example-list" aria-label="Example game ideas">{(starter === 'arcade' ? examples : [gameFormatStarters.find(format => format.id === starter)!.example]).map(example => <button key={example} disabled={busy || !canEdit} onClick={() => setIdea(example)}>{example}</button>)}</div>{starter === 'arcade' && <AsteroidSpriteEditor key="new-asteroids" sprites={creationSprites} disabled={busy || !canEdit} onChange={setCreationSprites} onBusyChange={setSpriteBusy}/>}<button className="button primary" disabled={busy || spriteBusy || !canEdit || !idea.trim()} onClick={() => void create()}>Build my first draft →</button><p className="game-small-note">The free guided designer uses supported formats and starter content. Directly edit the answers, clues, words or story prompts to make a word game your own. Configured AI follow-up requests use the administrator’s saved assistant permissions. Saving and publishing require a valid game and a fresh human playtest.</p></section> : <>
          {game.operationState && <div className="game-notice" role="status"><strong>{game.operationState === 'pending' ? 'An assistant request is still pending.' : 'The assistant result could not be confirmed.'}</strong><p>{game.operationError || 'Reload to check its status. You can edit the game details manually or duplicate the draft to continue. A paid request will not be replayed automatically.'}</p></div>}
          {spec.version !== 8 && <div className="game-builder-grid"><section className="game-conversation"><span className="eyebrow">STEP 2 · MAKE IT YOURS</span><h3>Talk it through.</h3><p className="game-small-note">{settings?.config.assistantModeId ? isCore ? 'Follow-up messages use the administrator’s configured assistant mode and its saved model permissions.' : 'Local preview uses the free guided designer. Configured AI runs only in the connected site.' : spec.version === 3 ? 'Free guided designer · describe a new topic, provide words and clues, or ask to shuffle the puzzle layout. You can also edit every item directly.' : 'Free guided designer · try “4 gentle levels”, “replan the progression”, or “randomize the layouts”.'}</p><div className="game-chat-log" role="log" aria-label="Game design conversation" aria-live="polite">{game.messages?.length ? game.messages.map(item => <div className={`game-chat-message ${item.role}`} key={item.id}><strong>{item.role === 'user' ? 'You' : 'Game designer'}</strong><p>{item.text}</p></div>) : <p>Describe a change to begin a new conversation about this draft.</p>}<div ref={chatEnd} /></div><form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="game-message">What would you like to change?</label><textarea id="game-message" value={message} maxLength={2000} rows={3} disabled={busy || !canEdit || Boolean(game.operationState)} placeholder={spec.version === 3 ? spec.genre === 'crossword' ? 'Entries: MOON | Earth’s natural satellite; STAR | A bright light in the night sky; MARS | The red planet' : spec.genre === 'word-search' ? 'Words: MOON, STAR, MARS, ORBIT\nSize: 14\nBackwards: false' : 'Template: A {{blank-1}} explorer found a {{blank-2}}.\nBlanks: blank-1 | describing word; blank-2 | noun' : 'Plan 4 levels for a beginner. Teach the controls first, then gradually increase the challenge…'} onChange={event => setMessage(event.target.value)} />{dirty && <p className="game-small-note">Save your changes before sending a design message.</p>}<button className="button primary" disabled={busy || !canEdit || dirty || !message.trim() || Boolean(game.operationState)}>{busy ? 'Designing…' : 'Send to designer →'}</button></form></section>
            {spec.version === 3 ? <WordGameEditor key={game.id} spec={spec} disabled={busy || !canEdit} dirty={dirty} revision={game.revision} change={change} save={() => void save()} crosswordGenerator={crosswordGenerator([])}/> : <section className="game-details"><span className="eyebrow">OR FINE-TUNE THE DETAILS</span><h3>The little details.</h3><fieldset disabled={busy || !canEdit}><label>Game title<input value={spec.title} maxLength={80} onChange={event => change({ ...spec, title: event.target.value })} /></label><label>Description<textarea value={spec.description} maxLength={300} rows={3} onChange={event => change({ ...spec, description: event.target.value.replace(/[\r\n]/g, ' ') })} /></label>{!spec.arcade && spec.version !== 7 && <div className="game-field-pair"><label>Game style<select value={spec.genre} onChange={event => changeGenre(event.target.value as ArcadeGameSpec['genre'])}><option value="collect">Collect treasures</option><option value="dodge">Dodge obstacles</option><option value="platformer">Jumping adventure</option></select></label><label>{spec.version !== 1 ? 'Cover world / new level default' : 'World'}<select value={spec.theme} onChange={event => change({ ...spec, theme: event.target.value as ArcadeGameSpec['theme'] })}><option value="pond">Pond</option><option value="space">Space</option><option value="garden">Garden</option></select></label></div>}{spec.genre === 'dodge' && <div className="game-arcade-options"><h4>Asteroids controls</h4><p className="game-small-note">Choose the controls and scoring for this game. Existing dodge adventures keep their original rules until you enable these options.</p><label className="game-checkbox"><input type="checkbox" checked={Boolean(spec.arcade)} onChange={event => setArcadeEnabled(event.target.checked)} />Enable Asteroids arcade options</label>{spec.arcade && <div className="game-arcade-choices"><label className="game-checkbox"><input type="checkbox" checked={spec.arcade.rotation} onChange={event => changeArcade('rotation', event.target.checked)} />Turn the ship 360 degrees</label><label className="game-checkbox"><input type="checkbox" checked={spec.arcade.shooting} onChange={event => changeArcade('shooting', event.target.checked)} />Shoot asteroids</label><label className="game-checkbox"><input type="checkbox" checked={spec.arcade.splitAsteroids} disabled={!spec.arcade.shooting} onChange={event => changeArcade('splitAsteroids', event.target.checked)} />Split large asteroids into smaller pieces</label><label className="game-checkbox"><input type="checkbox" checked={spec.arcade.scoring} onChange={event => changeArcade('scoring', event.target.checked)} />Track points</label><label className="game-checkbox"><input type="checkbox" checked={spec.arcade.highScores} disabled={isCooperativeGameSpec(spec) || !spec.arcade.scoring} onChange={event => changeArcade('highScores', event.target.checked)} />Show a high-score board</label><p className="game-small-note">Shared scores are for signed-in players on the published game. Guests can keep scores on this browser. Playtests never submit scores. {isCooperativeGameSpec(spec) && 'Shared high-score boards are unavailable for cooperative-enabled editions. '}Refresh the instructions, save, then playtest after changing options.</p><AsteroidChallengeEditor spec={spec} change={change}/><AsteroidPrizeEditor spec={spec} change={change}/></div>}</div>}{spec.genre === 'dodge' && spec.arcade?.shooting && <AsteroidSpriteEditor key={game.id} sprites={spec.sprites} disabled={busy || !canEdit} onBusyChange={setSpriteBusy} onChange={sprites => { const next = updateAsteroidSettings(spec, {}); if (sprites) next.sprites = sprites; else delete next.sprites; change(next); }}/>}{spec.version === 7 && <p className="game-small-note">2D Platformer · players choose their own character when they start. Characters are cosmetic; creators set the same movement and jumping rules for everyone. Each collectible earns 10 points.</p>}{spec.version !== 7 && <div className="game-multiplayer-options"><h4>Optional two-player mode</h4><label className="game-checkbox"><input type="checkbox" checked={isCooperativeGameSpec(spec)} disabled={Boolean(spec.flow)} onChange={event => change(setCooperativeMode(spec, event.target.checked))} />Allow two players to play together online</label><p className="game-small-note">Players can still play solo. A published game can also host one private live room for two sessions, with separate friendly characters, points, lives and goals in a shared world. Private invitations or an optional open seat on the homepage; no chat. Changing this option requires a fresh saved playtest and publication.{spec.flow && ' Remove the custom flow below before enabling two-player play.'}</p></div>}{spec.version !== 7 && <div className="game-field-pair"><label>Player name<input value={spec.player.name} maxLength={40} onChange={event => change({ ...spec, player: { ...spec.player, name: event.target.value } })} /></label><label>Player color<input type="color" value={spec.player.color} onChange={event => change({ ...spec, player: { ...spec.player, color: event.target.value } })} /></label></div>}<div className="game-field-pair"><label>Collectible<input value={spec.objects.collectible} maxLength={30} onChange={event => change({ ...spec, objects: { ...spec.objects, collectible: event.target.value } })} /></label><label>Hazard<input value={spec.objects.hazard} maxLength={30} onChange={event => change({ ...spec, objects: { ...spec.objects, hazard: event.target.value } })} /></label></div><div className="game-field-pair"><label>Movement speed<input type="number" min={2} max={8} step={1} value={spec.player.speed} onChange={event => change({ ...spec, player: { ...spec.player, speed: Number(event.target.value) } })} /></label>{spec.genre === 'platformer' && <label>Jump strength<input type="number" min={6} max={14} step={1} value={spec.player.jump} onChange={event => change({ ...spec, player: { ...spec.player, jump: Number(event.target.value) } })} /></label>}</div><label>Instructions<textarea rows={3} maxLength={300} value={spec.instructions} onChange={event => change({ ...spec, instructions: event.target.value.replace(/[\r\n]/g, ' ') })} /></label></fieldset><button className="text-button" disabled={busy || !canEdit} onClick={refreshInstructions}>↻ Refresh instructions for this adventure</button><div className="game-detail-actions"><button className="button secondary" disabled={busy || spriteBusy || !canEdit || !dirty} onClick={() => void save()}>Save changes</button><span>{dirty ? 'Unsaved changes' : `Saved version ${game.revision + 1}`}</span></div></section>}</div>}
          {spec.version === 8 && <MultiGameEditor key={game.id} spec={spec} library={games.filter(item => item.id !== game.id)} disabled={busy || spriteBusy || !canEdit} dirty={dirty} revision={game.revision} onChange={change} save={() => void save()} onBusyChange={setSpriteBusy} crosswordGenerator={crosswordGenerator}/>}
          {spec.version !== 3 && spec.version !== 8 && (endless ? <section className="game-level-plan game-continuous-settings" aria-labelledby="game-continuous-heading"><span className="eyebrow">CONTINUOUS PLAY</span><h3 id="game-continuous-heading">Starting world.</h3><p className="game-small-note">One continuous survival run, with no collection goal or countdown. Set its starting world here; difficulty growth, enemies, prizes and sprites are in the gameplay settings above.</p><LevelSettings level={levels[0]} continuous disabled={busy || !canEdit} onChange={level => updateLevel(level.id, level)}/><div className="game-detail-actions"><button className="button secondary" disabled={busy || spriteBusy || !canEdit || !dirty} onClick={() => void save()}>Save survival settings</button><span>{dirty ? 'Unsaved changes · playtest review will restart' : 'Saved survival settings'}</span></div></section> : <><LevelFlowEditor key={game.id} spec={spec} disabled={busy || !canEdit} onChange={change}/><div className="game-detail-actions"><button className="button secondary" disabled={busy || spriteBusy || !canEdit || !dirty} onClick={() => void save()}>Save game flow</button><span>{dirty ? 'Unsaved changes · playtest review will restart' : 'This is the saved flow'}</span></div></>)}
          <section className="game-playtest"><div className="game-section-heading"><div><span className="eyebrow">STEP 3 · TRY YOUR ADVENTURE</span><h3>A private little playtest.</h3></div></div>
            {game.spec.version === 8 ? <p>Play through each saved game and client object, or choose a single step below. Review all child levels and content in each game. Client objects have an explicit private preview action; review the actual integration in the connected application. If you add a free play ending, review five seconds of active play and finish its private playtest. Every outer step requires human review before publication.</p> : game.spec.version === 3 ? <p>Play the puzzle or use its explicit reveal action to inspect the finished result. For Mad Libs, fill in the prompts and reveal the completed story. Review every clue, word, prompt and instruction, then acknowledge this saved version before publication.</p> : savedEndless ? <p>Play the continuous run from its first saved level. Check the controls, increasing challenge, asteroid stages, enemy ships, and prizes you enabled. After five seconds of active play, choose <strong>Finish playtest</strong> inside the player, then acknowledge your review here. A real loss can also finish a round. The private review does not submit a score.</p> : <p><strong>Controls:</strong> {game.spec.arcade?.rotation ? 'Left/Right or A/D turn; Up/W thrusts' : 'Arrow keys or WASD move'}{game.spec.genre === 'platformer' ? '; Space or Up jumps' : game.spec.arcade?.shooting ? '; Space fires' : ''}. Touch buttons are available in the game. Play through the adventure or try each level separately. Complete a round in every level and review the controls, challenge, and wording before marking this version tested.</p>}
            <AsteroidPrizeGuide spec={game.spec}/>{savedEndless && <p className="game-small-note">Continuous run · review the starting world and survival settings.</p>}<div className="game-test-controls">{game.spec.version === 8 ? <label htmlFor="game-preview-step">Choose a playtest<select id="game-preview-step" value={previewLevel} disabled={busy || spriteBusy || dirty} onChange={event => { setPreviewLevel(event.target.value); setPlaytest(false); setResult(undefined); setPrivateReview(undefined); }}><option value="">Full multi-game journey · {game.spec.steps.length} steps</option>{game.spec.steps.map((step, index) => <option key={step.id} value={step.id}>Step {index + 1} · {multiStepTitle(step)}</option>)}</select></label> : game.spec.version !== 3 && !savedEndless && <label htmlFor="game-preview-level">Choose a playtest<select id="game-preview-level" value={previewLevel} disabled={busy || spriteBusy || dirty} onChange={event => { setPreviewLevel(event.target.value); setPlaytest(false); setResult(undefined); setPrivateReview(undefined); }}><option value="">Full adventure · {savedLevels.length} {savedLevels.length === 1 ? 'level' : 'levels'}</option>{savedLevels.map((level, index) => <option key={level.id} value={level.id}>Level {index + 1} · {level.title}</option>)}</select></label>}<button className="button secondary" disabled={busy || spriteBusy || dirty} onClick={() => { setPlaytest(true); setResult(undefined); setPrivateReview(undefined); setPlayNumber(number => number + 1); }}>{playtest ? 'Restart playtest' : 'Start playtest'}</button></div>
            {dirty && <p className="game-notice">Save your changes to playtest this version.</p>}
            {playtest && !dirty && <GamePlayer key={`${game.id}-${game.revision}-${playNumber}`} spec={game.spec} levelId={game.spec.version === 8 || savedEndless ? undefined : previewLevel || undefined} stepId={game.spec.version === 8 ? previewLevel || undefined : undefined} playtest onMultiProgress={recordMultiProgress} onComplete={recordPlaytest} onReview={recordPrivateReview} />}
            {materialSteps.length > 0 && <div className="game-flow-material-review"><strong>Review client material before acknowledging this edition</strong><ul>{materialSteps.map(node => node.type === 'material' && <li key={node.id}>{node.title} · {multiGame && node.kind === 'lesson' ? 'content' : multiGame && node.kind === 'exercise' ? 'interactive' : node.kind} · {node.reference}{node.required ? ' · client completion required' : ' · optional'}</li>)}</ul><p className="game-small-note">The private preview checks the flow and placeholder steps. Review the actual content and completion behavior in the connected client before using the published edition.</p><label className="game-checkbox"><input type="checkbox" checked={materialReviewed} disabled={dirty || busy} onChange={event => setMaterialReviewed(event.target.checked)}/>I reviewed the material references, requirements and client integration for this edition.</label></div>}
            <div className="game-level-review" aria-live="polite"><strong>{reviewedLevels.length} of {reviewItems.length} {multiGame ? 'steps' : wordGame ? 'puzzles' : savedEndless ? 'endless runs' : 'levels'} reviewed</strong><ul>{reviewItems.map((level, index) => <li key={level.id} className={reviewedLevels.includes(level.id) ? 'reviewed' : ''}><span aria-hidden="true">{reviewedLevels.includes(level.id) ? '✓' : '○'}</span> {index + 1}. {level.title}</li>)}</ul></div>
            {result && playtest && <div className="game-test-result"><strong>{wordGame ? 'Puzzle playtest complete.' : result.outcome === 'won' ? 'Adventure complete!' : result.outcome === 'level-complete' ? 'Level complete. Keep exploring!' : 'Round complete. How did it feel?'}</strong><p>{wordGame ? 'Review the finished puzzle or story and confirm that the content is appropriate for your players. Completion and reveal are review actions, not educational assessment.' : <>{typeof result.points === 'number' ? `Points: ${result.points} · ` : ''}Collected: {result.score} · {Math.round(result.elapsed)} seconds. {allReviewed ? 'Every level has a completed round. Confirm your review when you are ready.' : 'Try the remaining levels before marking this version tested.'}</>}</p></div>}
            {!dirty && !tested && <button className="button secondary game-mark-tested" disabled={busy || !allReviewed} onClick={() => void acknowledge()}>{multiGame ? 'Acknowledge all journey steps' : wordGame ? 'Acknowledge puzzle playtest' : savedEndless ? 'Acknowledge endless playtest' : 'Mark all levels playtested'}</button>}
            {privateReview && playtest && <div className="game-test-result"><strong>Endless playtest reviewed.</strong><p>{Math.round(privateReview.elapsed)} seconds of active play reviewed. Acknowledge this saved version when you are ready to publish.</p></div>}
            {tested && <p className="game-tested" role="status">{multiGame ? '✓ You reviewed every saved journey step. It is ready for a publisher’s review.' : wordGame ? '✓ You acknowledged the playtest of this saved puzzle. It is ready for a publisher’s review.' : savedEndless ? '✓ You acknowledged the playtest of this saved endless run. It is ready for a publisher’s review.' : '✓ You’ve playtested every level in this saved version. It’s ready for a publisher’s review.'}</p>}

          </section>
          <section className="game-publish"><div><span className="eyebrow">STEP 4 · OPEN THE DOORS</span><h3>{live ? 'A new edition of your adventure.' : 'Ready for the Games shelf?'}</h3><p>{!settings?.canPublish ? 'An authorized publisher can publish your tested draft.' : !tested ? multiGame ? 'Save your changes, review every game and client object, and acknowledge all journey steps to publish.' : wordGame ? 'Save your changes, finish or reveal the puzzle, and acknowledge your playtest to publish.' : savedEndless ? 'Save your changes, review the endless run, and acknowledge its playtest to publish.' : 'Save your changes, review a completed round in every level, and mark all levels playtested to publish.' : 'Publish this saved, tested version for everyone to play.'}</p></div><button className="button primary" disabled={busy || dirty || !tested || !canEdit || !settings?.canPublish} onClick={() => void publish()}>{live ? 'Update published game ↗' : 'Publish game ↗'}</button></section><div className="game-footer-actions">{live && <button className="text-button" onClick={() => void navigate(`/games/${game.id}`)}>View published game ↗</button>}{adminMode && settings?.canAdminContent && live && <button className="text-button danger" disabled={busy} onClick={() => void unpublish()}>Unpublish game</button>}{!live && <button className="text-button danger" disabled={busy} onClick={() => void remove(game)}>Delete private draft</button>}</div>
        </>}
        {game && live && <section className="game-integration" aria-labelledby="game-integration-heading"><span className="eyebrow">PUBLISH ONCE. PLAY IN YOUR APPLICATION.</span><h3 id="game-integration-heading">Share or embed this game.</h3><p>The public player always shows the latest published edition. Saving a draft does not change the game people can play.</p><label>Public game link<input readOnly value={new URL(`/games/${encodeURIComponent(game.id)}`, window.location.origin).href} onFocus={event => event.target.select()} /></label>{integration.hosts.length ? <div className="game-integration-hosts">{integration.hosts.map(host => <details key={host.id}><summary>{host.name}</summary><label>Embedded player link<input readOnly value={embedURL(host.id)} onFocus={event => event.target.select()} /></label><label>Player iframe<textarea readOnly rows={4} value={`<iframe src="${embedURL(host.id)}" title="Game Studio player" width="100%" height="900" loading="lazy" referrerpolicy="strict-origin" allowfullscreen allow="fullscreen ${window.location.origin}; camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'"></iframe>`} onFocus={event => event.target.select()} /></label><label>Creator link for application administrators<input readOnly value={createCreatorURL(window.location.origin, { hostId: host.id, gameId: game.id })} onFocus={event => event.target.select()} /></label><p className="game-small-note">Open creation in its own page. Core checks the user’s game permissions. A return link takes them back to {host.name}; the application’s server must also guard its creator entry point.</p><HostSelectionLink connection={selectionConnection} host={host} gameId={game.id} publishedRevision={game.publishedRevision ?? game.revision} retry={() => { setSelectionConnection({ status: 'loading' }); setSelectionRetry(value => value + 1); }}/><p className="game-small-note">Return the published game ID and edition to {host.name}. The application reviews the public game before attaching it to a lesson or page. This does not save anything in that application.</p></details>)}</div> : <p className="game-small-note">An administrator can connect application origins in Integration settings. Connected applications receive an embed link and an administrator creator link here.</p>}</section>}
        {settings?.canManage && config && <section className="game-administration"><span className="eyebrow">ADMINISTRATOR SETTINGS</span><h3>Keep the workshop running.</h3><p>Pausing creation stops new games, design changes, copies, and publishing. Published games stay available to play.</p><fieldset disabled={busy}><label className="game-checkbox"><input type="checkbox" checked={config.creationEnabled} onChange={event => { setConfig({ ...config, creationEnabled: event.target.checked }); setSettingsDirty(true); }} />Allow game creation and publication</label><label>Conversation assistant<select value={config.assistantModeId} onChange={event => { setConfig({ ...config, assistantModeId: event.target.value }); setSettingsDirty(true); }}><option value="">Free guided designer</option>{modes.map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}{config.assistantModeId && !modes.some(mode => mode.id === config.assistantModeId) && <option value={config.assistantModeId}>Configured mode: {config.assistantModeId}</option>}</select></label><label>Crossword word assistant<select value={config.crosswordAssistantModeId ?? ''} onChange={event => { setConfig({ ...config, crosswordAssistantModeId: event.target.value }); setSettingsDirty(true); }}><option value="">Disabled</option>{modes.filter(mode => mode.provider === 'bedrock').map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}{config.crosswordAssistantModeId && !modes.some(mode => mode.id === config.crosswordAssistantModeId && mode.provider === 'bedrock') && <option value={config.crosswordAssistantModeId}>Configured mode: {config.crosswordAssistantModeId}</option>}</select></label><p className="game-small-note">Choose a separate small-model mode for words and clues. Add the Nova Micro preset in Agents &amp; workflows, authorize its model and audience, then reload this workshop. Generating words is an explicit authoring action; playing a published puzzle makes no model call.</p><p className="game-small-note">An optional configured assistant can create and refine supported games through conversation. Its model, audience, and paid usage permissions come from Agent settings. Every resulting game must still fit a supported arcade or word-game format.</p></fieldset><button className="button secondary" disabled={busy || !settingsDirty} onClick={() => void saveConfig()}>Save game settings</button>{settingsDirty && <span className="game-settings-unsaved">Unsaved settings</span>}</section>}
      </>}
      <div className="game-service-credit"><ServiceBadge /></div>
    </section></main>;
}
