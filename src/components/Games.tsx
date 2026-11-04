import type { MultiGameProgress, MultiGameResult, MultiMaterialRequest } from '../lib/multi-game-session';
import type { FlowProgress, MaterialRequest } from '../lib/game-flow-session';
import { useEffect, useRef, useState } from 'react';
import { isCooperativeGameSpec, isEndlessAsteroids, type Game, type GameResult, type GameSettings, type GameSpec } from '../lib/game-types';
import { deleteGame, duplicateGame, getGame, getGameSettings, listGames } from '../lib/game-api';
import { GamePlayer } from './GamePlayer';
import { CooperativeGame } from './CooperativePlayer';
import { isVersusEligible } from '../lib/game-versus';
import { MultiplayerLobby } from './MultiplayerLobby';
import { MafiaCategoryCard } from './MafiaCategoryCard';
import { AsteroidPrizeGuide } from './AsteroidPrizeEditor';
import { getGameLevels } from '../lib/game-design';
import { ItemActions } from './ItemActions';
import { useConfirm } from './Confirm';
import { isCore } from '../lib/core';
import { getGameScores, submitGameScore } from '../lib/game-scores';
import type { GameScoreBoard } from '../lib/game-scores';
import { leaderboardRanking, leaderboardValue, qualifiesLeaderboard, validateLeaderboardName, validateLeaderboardResult } from '../lib/game-leaderboard';
import { useBranding } from '../lib/branding';
import { ServiceBadge } from './ServiceBadge';
import { wordGameSummary, wordGenreNames } from './WordGameEditor';

type Props = { navigate: (path: string) => Promise<void>; adminMode: boolean; signed: boolean; playerSigned?: boolean };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The Games shelf could not be opened.';
const themeName = { pond: 'A pond adventure', garden: 'A garden adventure', space: 'A space adventure' };
const genreName = { collect: 'Collect treasures', dodge: 'Dodge obstacles', platformer: 'Jumping adventure', ...wordGenreNames };
export function gameCardPresentation(spec: GameSpec) {
  if (spec.version === 8) return { world: 'world-multi-game', symbol: '◇', category: 'Multi-game', detail: `${spec.steps.filter(step => step.type === 'game').length} games · ${spec.steps.length} steps${spec.steps.some(step => step.type === 'free-play') ? ' · free play ending' : ''}`, label: 'Games and client objects · one journey' };
  if (spec.version === 3) return { world: `word-${spec.genre}`, symbol: spec.genre === 'crossword' ? '▦' : spec.genre === 'word-search' ? '⌕' : '✎', category: wordGenreNames[spec.genre], detail: wordGameSummary(spec), label: 'Word game' };
  const count = getGameLevels(spec).length;
  return { world: `world-${spec.theme}`, symbol: spec.theme === 'space' ? '✦' : spec.theme === 'garden' ? '✿' : '≈', category: spec.version === 7 ? '2D Platformer' : spec.arcade ? 'Asteroids' : genreName[spec.genre], detail: `${isEndlessAsteroids(spec) ? 'Continuous survival' : `${count} ${count === 1 ? 'level' : 'levels'}`}${isCooperativeGameSpec(spec) || isVersusEligible(spec) ? ' · 1–2 players' : ''}${isVersusEligible(spec) ? ' · versus' : ''}${spec.powerUps ? ' · prizes' : ''}${spec.version === 6 && spec.asteroids?.enemies.enabled ? ` · ${spec.asteroids.enemies.difficulty} enemies` : ''}`, label: spec.version === 7 ? 'Pixel worlds · choose your character' : themeName[spec.theme] };
}

function useGameActions({ navigate, adminMode, signed }: Props, refresh: () => Promise<void>) {
  const confirm = useConfirm(), lock = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [settings, setSettings] = useState<GameSettings>();
  useEffect(() => {
    let active = true;
    if (signed) void getGameSettings().then(value => { if (active) setSettings(value); }).catch(() => { if (active) setSettings(undefined); });
    else setSettings(undefined);
    return () => { active = false; };
  }, [signed, adminMode]);
  async function action(kind: 'update' | 'duplicate' | 'delete', value: Game) {
    if (lock.current || !signed || !adminMode || !settings?.canAdminContent) return;
    if (kind === 'update') { await navigate(`/game-studio?game=${encodeURIComponent(value.id)}`); return; }
    if (kind === 'duplicate' && !settings.config.creationEnabled) { setError('Game creation is paused by an administrator.'); return; }
    if (kind === 'delete' && !await confirm(`Permanently delete “${value.spec.title}”? Its draft and public game will both be removed. This cannot be undone.`)) return;
    lock.current = true; setBusy(true); setError('');
    try {
      // The private record is authoritative: a public snapshot may be an older revision.
      const current = await getGame(value.id);
      if (kind === 'duplicate') { const created = await duplicateGame(current); await navigate(`/game-studio?game=${encodeURIComponent(created.id)}`); }
      else { await deleteGame(current); await refresh(); }
    } catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return { busy, error, settings, actions: (game: Game) => signed && adminMode && settings?.canAdminContent ? <ItemActions label={game.spec.title} disabled={busy} onUpdate={() => action('update', game)} onDuplicate={() => action('duplicate', game)} onDelete={() => action('delete', game)} /> : null };
}

export function Games(props: Props) {
  const brand = useBranding();
  const [games, setGames] = useState<Game[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [filter, setFilter] = useState('all');
  async function refresh() { setLoading(true); try { setGames(await listGames(true)); setError(''); } catch (value) { setError(errorMessage(value)); } finally { setLoading(false); } }
  useEffect(() => { let active = true; void listGames(true).then(value => { if (active) { setGames(value); setError(''); } }).catch(value => { if (active) setError(errorMessage(value)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const controls = useGameActions(props, refresh), shown = games.filter(game => filter === 'all' || game.spec.genre === filter);
  return <main id="main" className="games-page"><section className="games-hero"><div><span className="eyebrow">IDEAS BECOME ADVENTURES.</span><h1>Your next<br/><em>adventure.</em></h1><p>Original games built in {brand.appName}. Explore Asteroids and pixel platformers, solve crosswords, find hidden words, play with a Mad Libs story, or explore a multi-game journey.</p></div><div className="games-hero-art" aria-hidden="true"><span>✦</span><img src="/assets/game-studio-mark.svg" alt="" /><b>PRESS PLAY.<br/>GET CURIOUS.</b></div></section><MafiaCategoryCard navigate={props.navigate}/><MultiplayerLobby navigate={props.navigate}/><section className="games-library"><div className="game-section-heading"><div><span className="eyebrow">THE GAMES SHELF</span><h2>Choose your next adventure.</h2></div>{props.signed && <button className="button secondary" onClick={() => void props.navigate('/game-studio')}>Visit the game studio ↗</button>}</div><div className="filter-tabs" role="group" aria-label="Filter games">{[['all', 'All games'], ['collect', 'Collect'], ['dodge', 'Asteroids'], ['platformer', '2D Platformer'], ['multi-game', 'Multi-game'], ['crossword', 'Crossword'], ['word-search', 'Word search'], ['mad-libs', 'Mad Libs']].map(([id, title]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{title}</button>)}</div>{controls.error && <p className="error" role="alert">{controls.error}</p>}{error ? <div className="error" role="alert"><p>{error}</p><button className="button secondary" onClick={() => void refresh()}>Try again</button></div> : loading ? <p role="status">Finding little adventures…</p> : shown.length ? <div className="games-grid">{shown.map(game => { const card = gameCardPresentation(game.spec); return <article className="game-card" key={game.id}><a href={`/games/${game.id}`} onClick={event => { event.preventDefault(); void props.navigate(`/games/${game.id}`); }}><div className={`game-card-art ${card.world}`}><span className="game-card-star" aria-hidden="true">{card.symbol}</span><img src="/assets/game-studio-mark.svg" alt="" style={{ filter: 'none' }} /><span className="game-card-genre">{card.category} · {card.detail}</span></div><div className="game-card-copy"><span className="eyebrow">{card.label}</span><h3>{game.spec.title}</h3><p>{game.spec.description}</p><span className="game-card-play">Play the game <span aria-hidden="true">→</span></span></div></a><div className="game-card-actions">{controls.actions(game)}</div></article>; })}</div> : <div className="games-empty"><span aria-hidden="true">✦</span><h3>{games.length ? 'A new adventure is just around the corner.' : 'Our first adventures are on their way.'}</h3><p>{games.length ? 'Try another game style to discover something to play.' : 'Games appear here after their creators playtest and publish them. Come back to see what grows!'}</p>{props.signed && <button className="button secondary" onClick={() => void props.navigate('/game-studio')}>Open the game studio →</button>}</div>}</section><div className="game-service-credit"><ServiceBadge /></div></main>;
}

export type PublishedGameEvent = { type: 'completed'; gameId: string; publishedRevision: number; result: GameResult; specVersion?: 6; mode?: 'endless' | 'levels' } | { type: 'flow-progress'; gameId: string; publishedRevision: number; progress: FlowProgress; result?: GameResult } | { type: 'multi-progress'; gameId: string; publishedRevision: number; progress: MultiGameProgress };
export type PublishedMultiMaterialHandler = (request: MultiMaterialRequest & { gameId: string; publishedRevision: number }, signal: AbortSignal) => Promise<void>;
export type PublishedMaterialHandler = (request: MaterialRequest & { gameId: string; publishedRevision: number }, signal: AbortSignal) => Promise<void>;

export function GamePage(props: Props & { id: string; embedded?: boolean; onGameEvent?: (event: PublishedGameEvent) => void; onMaterialRequest?: PublishedMaterialHandler; onMultiMaterialRequest?: PublishedMultiMaterialHandler }) {
  const [game, setGame] = useState<Game>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  async function refresh() { try { setGame(await getGame(props.id, true)); setError(''); } catch (value) { setGame(undefined); setError(errorMessage(value)); } }
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setGame(undefined);
    void getGame(props.id, true).then(value => { if (active) setGame(value); }).catch(value => { if (active) setError(errorMessage(value)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.id]);
  const controls = useGameActions({ ...props, signed: !props.embedded && props.signed, adminMode: !props.embedded && props.adminMode }, refresh);
  return <main id="main" className={`game-page${props.embedded ? ' embedded-game-page' : ''}`}><div className="game-section-heading">{!props.embedded && <button className="text-button" onClick={() => void props.navigate('/games')}>← Back to Games</button>}{!props.embedded && game && controls.actions(game)}</div>{controls.error && <p className="error" role="alert">{controls.error}</p>}{loading ? <p role="status">Opening your adventure…</p> : error || !game ? <section className="games-empty"><h1>This adventure isn’t here.</h1><p>{error || 'It may have been unpublished or deleted.'}</p><button className="button primary" onClick={() => void props.navigate('/games')}>Find another game →</button></section> : <><span className="eyebrow">{gameCardPresentation(game.spec).label} · {gameCardPresentation(game.spec).category}</span><h1>{game.spec.title}</h1><p className="game-page-description">{game.spec.description}</p>{game.spec.version !== 3 && game.spec.version !== 8 && game.spec.progression && <p className="game-public-progression">{isEndlessAsteroids(game.spec) ? 'Continuous survival · difficulty rises during play' : `${getGameLevels(game.spec).length} levels · ${game.spec.progression}`}</p>}<PublishedGame key={`${game.id}-${game.publishedRevision ?? game.revision}`} game={game} signed={props.playerSigned ?? props.signed} embedded={props.embedded} onGameEvent={props.onGameEvent} onMaterialRequest={props.onMaterialRequest} onMultiMaterialRequest={props.onMultiMaterialRequest} /><div className="game-how-to"><span className="eyebrow">HOW TO PLAY</span><p>{game.spec.instructions}</p><AsteroidPrizeGuide spec={game.spec}/></div></>}<div className="game-service-credit"><ServiceBadge compact /></div></main>;
}


type ScoreRun = { id: string; result: GameResult | MultiGameResult };
export function PublishedGame({ game, onGameEvent, onMaterialRequest, onMultiMaterialRequest }: { game: Game; signed: boolean; embedded?: boolean; onGameEvent?: (event: PublishedGameEvent) => void; onMaterialRequest?: PublishedMaterialHandler; onMultiMaterialRequest?: PublishedMultiMaterialHandler }) {
  const [run, setRun] = useState<ScoreRun>();
  function recordResult(result: GameResult | MultiGameResult) {
    const checked = validateLeaderboardResult(game.spec, result);
    if (checked) setRun({ id: crypto.randomUUID(), result: checked });
  }
  function record(result: GameResult) {
    if (game.spec.version !== 8 && !(game.spec.version !== 3 && game.spec.flow) && !isCooperativeGameSpec(game.spec) && result.outcome !== 'level-complete') onGameEvent?.({ type: 'completed', gameId: game.id, publishedRevision: game.publishedRevision ?? game.revision, ...(game.spec.version === 6 ? { specVersion: 6, mode: isEndlessAsteroids(game.spec) ? 'endless' : 'levels' } as const : {}), result: { ...result, reviewedLevelIds: [...result.reviewedLevelIds] } });
    recordResult(result);
  }
  const solo = <GamePlayer spec={game.spec} onComplete={record} onMultiComplete={recordResult} onMultiMaterialRequest={onMultiMaterialRequest ? (request, signal) => onMultiMaterialRequest({ ...request, gameId: game.id, publishedRevision: game.publishedRevision ?? game.revision }, signal) : undefined} onMultiProgress={progress => onGameEvent?.({ type: 'multi-progress', gameId: game.id, publishedRevision: game.publishedRevision ?? game.revision, progress })} onMaterialRequest={onMaterialRequest ? (request, signal) => onMaterialRequest({ ...request, gameId: game.id, publishedRevision: game.publishedRevision ?? game.revision }, signal) : undefined} onFlowProgress={(progress, result) => onGameEvent?.({ type: 'flow-progress', gameId: game.id, publishedRevision: game.publishedRevision ?? game.revision, progress, ...(result ? { result } : {}) })} />;
  return <>{isCooperativeGameSpec(game.spec) || isVersusEligible(game.spec) ? <CooperativeGame game={{ ...game, spec: game.spec }} onComplete={recordResult}>{solo}</CooperativeGame> : solo}<GameHighScores game={game} run={run}/></>;
}

function scoreValue(game: Game, result: GameResult | MultiGameResult) {
  const value = leaderboardValue(game.spec, result);
  return leaderboardRanking(game.spec) === 'points' ? `${value.toLocaleString()} points` : `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} seconds`;
}

export function GameHighScores({ game, run }: { game: Game; run?: ScoreRun }) {
  const [board, setBoard] = useState<GameScoreBoard>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [savedRuns, setSavedRuns] = useState<Set<string>>(() => new Set());
  const loadGeneration = useRef(0), saving = useRef(false), active = useRef(true), latestRun = useRef(run);
  const request = useRef<{ id: string; key: string }>();
  latestRun.current = run;
  const ranking = leaderboardRanking(game.spec), qualified = Boolean(board && run && qualifiesLeaderboard(board, run.result));
  useEffect(() => { active.current = true; return () => { active.current = false; loadGeneration.current += 1; }; }, []);
  async function reload() {
    const generation = ++loadGeneration.current; setLoading(true); setError('');
    try {
      const next = await getGameScores(game);
      if (active.current && generation === loadGeneration.current) setBoard(next);
    } catch (value) {
      if (active.current && generation === loadGeneration.current) { setBoard(undefined); setError(value instanceof Error ? value.message : 'The leaderboard could not be loaded.'); }
    } finally { if (active.current && generation === loadGeneration.current) setLoading(false); }
  }
  useEffect(() => { setBoard(undefined); setNotice(''); setError(''); request.current = undefined; void reload(); return () => { loadGeneration.current += 1; }; }, [game.id, game.publishedRevision, game.revision, run?.id]);
  async function save() {
    if (!run || !board || loading || saving.current || savedRuns.has(run.id) || !qualifiesLeaderboard(board, run.result)) return;
    let nickname: string;
    try { nickname = validateLeaderboardName(name); } catch (value) { setError(value instanceof Error ? value.message : 'Choose a name with 1–8 printable characters.'); return; }
    const currentRun = run, key = JSON.stringify([game.id, game.publishedRevision ?? game.revision, currentRun.id]);
    if (request.current?.key !== key) request.current = { id: crypto.randomUUID(), key };
    saving.current = true; setBusy(true); setError(''); setNotice('');
    const generation = ++loadGeneration.current;
    try {
      const next = await submitGameScore(game, { requestId: request.current.id, name: nickname, result: currentRun.result });
      if (!active.current) return;
      setSavedRuns(previous => new Set([...previous, currentRun.id]));
      if (latestRun.current?.id === currentRun.id) setNotice(next.qualified ? next.scope === 'shared' ? 'Your result is on the shared top 10!' : 'Your result is on this browser’s top 10!' : 'The board changed before your result was saved. This result no longer makes the top 10. Try another round!');
      if (generation === loadGeneration.current) { setBoard(next); setLoading(false); }
    } catch (value) { if (active.current && latestRun.current?.id === currentRun.id) setError(value instanceof Error ? value.message : 'Your result could not be saved. Try again with the same name.'); }
    finally { saving.current = false; if (active.current) { setBusy(false); if (generation === loadGeneration.current) setLoading(false); } }
  }
  const unsavedRun = run && !savedRuns.has(run.id);
  return <section className="game-high-scores" aria-labelledby="game-high-scores-heading">
    <div className="game-section-heading"><div><span className="eyebrow">THE TOP 10</span><h2 id="game-high-scores-heading">{ranking === 'points' ? 'High scores' : ranking === 'survival' ? 'Longest survival' : 'Fastest completions'}</h2></div><span className="game-score-version">This published edition</span></div>
    <p className="game-small-note">{isCore ? 'Everyone can join this game’s shared board. No sign-in needed. Publishing a new edition starts a fresh board.' : 'Local preview keeps this top 10 on this browser. The connected site shares its board with everyone.'} {ranking === 'points' ? 'Highest points first.' : ranking === 'survival' ? 'Longest active survival time first.' : 'Completed games rank by fastest active play time.'} These are casual, player-reported results.</p>
    <p className="game-score-scope">{isCore ? 'Shared · public names and results' : 'This browser · saved only on this device and browser'}</p>
    {loading ? <p role="status">Opening the leaderboard…</p> : board ? board.entries.length ? <ol className="game-score-list" aria-label={ranking === 'points' ? 'Top 10 point scores' : ranking === 'survival' ? 'Top 10 survival times' : 'Top 10 completion times'}>{board.entries.map((entry, index) => <li key={`${entry.createdAt}-${index}`}><span className="game-score-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span className="game-score-name">{entry.name}</span><strong>{ranking === 'points' ? entry.points!.toLocaleString() : entry.elapsed!.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <small>{ranking === 'points' ? 'points' : 'seconds'}</small></strong></li>)}</ol> : <p className="game-score-empty">No results yet. {ranking === 'time' ? 'Complete the game' : 'Finish a round'} to join the top 10!</p> : <button className="button secondary" disabled={busy} onClick={() => void reload()}>Try loading the leaderboard again</button>}
    {unsavedRun && loading && <p className="game-score-qualification" role="status">Checking your result against the current top 10…</p>}
    {unsavedRun && !loading && board && qualified && <form className="game-score-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div><strong>{scoreValue(game, run.result)} · you made the top 10!</strong><p>Choose a public nickname. Everyone can see it, so keep personal details private.</p></div>
      <label htmlFor="game-score-name">Leaderboard name<input id="game-score-name" autoComplete="off" value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="e.g. Nova" aria-describedby="game-score-name-help" /></label>
      <span id="game-score-name-help" className="game-small-note">1–8 characters. Letters, punctuation and emoji are welcome. {[...name.normalize('NFC').trim()].length}/8</span>
      <button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Saving result…' : 'Save to the top 10 →'}</button>
    </form>}
    {unsavedRun && !loading && board && !qualified && <p className="game-score-qualification" role="status">Your result: {scoreValue(game, run.result)}. {ranking === 'points' ? 'Earn more points' : ranking === 'survival' ? 'Survive longer' : 'Complete the game faster'} to make the top 10.</p>}
    {notice && <p className="game-score-notice" role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}
  </section>;
}
