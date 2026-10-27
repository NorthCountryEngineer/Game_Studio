import { useEffect, useRef, useState } from 'react';
import { isCooperativeGameSpec, type Game, type GameResult, type GameSettings, type GameSpec } from '../lib/game-types';
import { deleteGame, duplicateGame, getGame, getGameSettings, listGames } from '../lib/game-api';
import { GamePlayer } from './GamePlayer';
import { CooperativeGame } from './CooperativePlayer';
import { getGameLevels } from '../lib/game-design';
import { ItemActions } from './ItemActions';
import { useConfirm } from './Confirm';
import { beginCoreLogin, isCore } from '../lib/core';
import { getGameScores, getLocalGameScores, saveLocalGameScore, submitGameScore, validateArcadeName } from '../lib/game-scores';
import type { GameScoreBoard } from '../lib/game-scores';
import { useBranding } from '../lib/branding';
import { ServiceBadge } from './ServiceBadge';
import { wordGameSummary, wordGenreNames } from './WordGameEditor';

type Props = { navigate: (path: string) => Promise<void>; adminMode: boolean; signed: boolean; playerSigned?: boolean };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The Games shelf could not be opened.';
const themeName = { pond: 'A pond adventure', garden: 'A garden adventure', space: 'A space adventure' };
const genreName = { collect: 'Collect treasures', dodge: 'Dodge obstacles', platformer: 'Jumping adventure', ...wordGenreNames };
export function gameCardPresentation(spec: GameSpec) {
  if (spec.version === 3) return { world: `word-${spec.genre}`, symbol: spec.genre === 'crossword' ? '▦' : spec.genre === 'word-search' ? '⌕' : '✎', category: wordGenreNames[spec.genre], detail: wordGameSummary(spec), label: 'Word game' };
  const count = getGameLevels(spec).length;
  return { world: `world-${spec.theme}`, symbol: spec.theme === 'space' ? '✦' : spec.theme === 'garden' ? '✿' : '≈', category: genreName[spec.genre], detail: `${count} ${count === 1 ? 'level' : 'levels'}${spec.version === 4 ? ' · 1–2 players' : ''}`, label: themeName[spec.theme] };
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
  return <main id="main" className="games-page"><section className="games-hero"><div><span className="eyebrow">IDEAS BECOME ADVENTURES.</span><h1>Your next<br/><em>adventure.</em></h1><p>Original games built in {brand.appName}. Explore arcade adventures, solve crosswords, find hidden words, or play with a Mad Libs story.</p></div><div className="games-hero-art" aria-hidden="true"><span>✦</span><img src="/assets/game-studio-mark.svg" alt="" /><b>PRESS PLAY.<br/>GET CURIOUS.</b></div></section><section className="games-library"><div className="game-section-heading"><div><span className="eyebrow">THE GAMES SHELF</span><h2>Choose your next adventure.</h2></div>{props.signed && <button className="button secondary" onClick={() => void props.navigate('/game-studio')}>Visit the game studio ↗</button>}</div><div className="filter-tabs" role="group" aria-label="Filter games">{[['all', 'All games'], ['collect', 'Collect'], ['dodge', 'Dodge'], ['platformer', 'Jump'], ['crossword', 'Crossword'], ['word-search', 'Word search'], ['mad-libs', 'Mad Libs']].map(([id, title]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{title}</button>)}</div>{controls.error && <p className="error" role="alert">{controls.error}</p>}{error ? <div className="error" role="alert"><p>{error}</p><button className="button secondary" onClick={() => void refresh()}>Try again</button></div> : loading ? <p role="status">Finding little adventures…</p> : shown.length ? <div className="games-grid">{shown.map(game => { const card = gameCardPresentation(game.spec); return <article className="game-card" key={game.id}><a href={`/games/${game.id}`} onClick={event => { event.preventDefault(); void props.navigate(`/games/${game.id}`); }}><div className={`game-card-art ${card.world}`}><span className="game-card-star" aria-hidden="true">{card.symbol}</span><img src="/assets/game-studio-mark.svg" alt="" style={{ filter: 'none' }} /><span className="game-card-genre">{card.category} · {card.detail}</span></div><div className="game-card-copy"><span className="eyebrow">{card.label}</span><h3>{game.spec.title}</h3><p>{game.spec.description}</p><span className="game-card-play">Play the game <span aria-hidden="true">→</span></span></div></a><div className="game-card-actions">{controls.actions(game)}</div></article>; })}</div> : <div className="games-empty"><span aria-hidden="true">✦</span><h3>{games.length ? 'A new adventure is just around the corner.' : 'Our first adventures are on their way.'}</h3><p>{games.length ? 'Try another game style to discover something to play.' : 'Games appear here after their creators playtest and publish them. Come back to see what grows!'}</p>{props.signed && <button className="button secondary" onClick={() => void props.navigate('/game-studio')}>Open the game studio →</button>}</div>}</section><div className="game-service-credit"><ServiceBadge /></div></main>;
}

export type PublishedGameEvent = { type: 'completed'; gameId: string; publishedRevision: number; result: GameResult };

export function GamePage(props: Props & { id: string; embedded?: boolean; onGameEvent?: (event: PublishedGameEvent) => void }) {
  const [game, setGame] = useState<Game>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  async function refresh() { try { setGame(await getGame(props.id, true)); setError(''); } catch (value) { setGame(undefined); setError(errorMessage(value)); } }
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setGame(undefined);
    void getGame(props.id, true).then(value => { if (active) setGame(value); }).catch(value => { if (active) setError(errorMessage(value)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.id]);
  const controls = useGameActions({ ...props, signed: !props.embedded && props.signed, adminMode: !props.embedded && props.adminMode }, refresh);
  return <main id="main" className={`game-page${props.embedded ? ' embedded-game-page' : ''}`}><div className="game-section-heading">{!props.embedded && <button className="text-button" onClick={() => void props.navigate('/games')}>← Back to Games</button>}{!props.embedded && game && controls.actions(game)}</div>{controls.error && <p className="error" role="alert">{controls.error}</p>}{loading ? <p role="status">Opening your adventure…</p> : error || !game ? <section className="games-empty"><h1>This adventure isn’t here.</h1><p>{error || 'It may have been unpublished or deleted.'}</p><button className="button primary" onClick={() => void props.navigate('/games')}>Find another game →</button></section> : <><span className="eyebrow">{gameCardPresentation(game.spec).label} · {genreName[game.spec.genre]}</span><h1>{game.spec.title}</h1><p className="game-page-description">{game.spec.description}</p>{game.spec.version !== 3 && game.spec.progression && <p className="game-public-progression">{getGameLevels(game.spec).length} levels · {game.spec.progression}</p>}<PublishedGame key={`${game.id}-${game.publishedRevision ?? game.revision}`} game={game} signed={props.playerSigned ?? props.signed} embedded={props.embedded} onGameEvent={props.onGameEvent} /><div className="game-how-to"><span className="eyebrow">HOW TO PLAY</span><p>{game.spec.instructions}</p></div></>}<div className="game-service-credit"><ServiceBadge compact /></div></main>;
}


type ScoreRun = { id: string; result: GameResult };
export function PublishedGame({ game, signed, embedded = false, onGameEvent }: { game: Game; signed: boolean; embedded?: boolean; onGameEvent?: (event: PublishedGameEvent) => void }) {
  const [run, setRun] = useState<ScoreRun>();
  const enabled = game.spec.version !== 3 && game.spec.version !== 4 && Boolean(game.spec.arcade?.highScores && game.spec.arcade.scoring);
  function record(result: GameResult) {
    if (game.spec.version !== 4 && result.outcome !== 'level-complete') onGameEvent?.({ type: 'completed', gameId: game.id, publishedRevision: game.publishedRevision ?? game.revision, result: { ...result, reviewedLevelIds: [...result.reviewedLevelIds] } });
    if (!enabled || result.outcome === 'level-complete' || !Number.isSafeInteger(result.points) || (result.points ?? 0) <= 0) return;
    setRun({ id: crypto.randomUUID(), result });
  }
  const solo = <><GamePlayer spec={game.spec} onComplete={record} />{enabled && <GameHighScores game={game} signed={signed} run={run} embedded={embedded} />}</>;
  return isCooperativeGameSpec(game.spec) ? <CooperativeGame game={{ ...game, spec: game.spec }}>{solo}</CooperativeGame> : solo;
}

function GameHighScores({ game, signed, run, embedded }: { game: Game; signed: boolean; run?: ScoreRun; embedded: boolean }) {
  const [scope, setScope] = useState<'shared' | 'browser'>(isCore ? 'shared' : 'browser');
  const [board, setBoard] = useState<GameScoreBoard>(), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [signingIn, setSigningIn] = useState(false);
  const [name, setName] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [savedRuns, setSavedRuns] = useState<Set<string>>(() => new Set());
  const loadGeneration = useRef(0), saving = useRef(false), signInLock = useRef(false), active = useRef(true);
  const request = useRef<{ id: string; key: string }>();
  const submissionScope = isCore && signed && scope === 'shared' ? 'shared' : 'browser';
  useEffect(() => { active.current = true; return () => { active.current = false; loadGeneration.current += 1; }; }, []);
  useEffect(() => { setName(''); request.current = undefined; setError(''); setNotice(''); }, [signed]);
  useEffect(() => { setError(''); setNotice(''); }, [run?.id]);
  async function reload() {
    const generation = ++loadGeneration.current; setLoading(true); setError('');
    try {
      const next = scope === 'shared' ? await getGameScores(game) : getLocalGameScores(game);
      if (active.current && generation === loadGeneration.current) setBoard(next);
    } catch (value) {
      if (active.current && generation === loadGeneration.current) { setBoard(undefined); setError(value instanceof Error ? value.message : 'The high-score board could not be loaded.'); }
    } finally { if (active.current && generation === loadGeneration.current) setLoading(false); }
  }
  useEffect(() => { setBoard(undefined); void reload(); return () => { loadGeneration.current += 1; }; }, [game.id, game.publishedRevision, game.revision, scope]);
  async function save() {
    if (!run || saving.current || signInLock.current || savedRuns.has(`${run.id}:${submissionScope}`)) return;
    let nickname: string;
    try { nickname = validateArcadeName(name); } catch (value) { setError(value instanceof Error ? value.message : 'Choose an arcade name with 1–16 letters, numbers, spaces, underscores, or hyphens.'); return; }
    const targetScope = submissionScope, currentRun = run;
    const key = JSON.stringify([game.id, game.publishedRevision ?? game.revision, targetScope, nickname, currentRun.id]);
    if (request.current?.key !== key) request.current = { id: crypto.randomUUID(), key };
    saving.current = true; setBusy(true); setError(''); setNotice('');
    const generation = ++loadGeneration.current;
    try {
      const report = { requestId: request.current.id, name: nickname, result: currentRun.result };
      const next = targetScope === 'shared' ? await submitGameScore(game, report) : saveLocalGameScore(game, report);
      if (!active.current) return;
      setSavedRuns(previous => new Set([...previous, `${currentRun.id}:${targetScope}`]));
      setNotice(targetScope === 'shared' ? 'Your round was recorded. The shared board keeps each player’s best score.' : 'Your score was saved on this browser.');
      // A guest saving while viewing the shared board explicitly changes to the local board.
      setScope(targetScope);
      if (generation === loadGeneration.current) { setBoard(next); setLoading(false); }
    } catch (value) { if (active.current) setError(value instanceof Error ? value.message : 'Your score could not be saved. Try again with the same arcade name.'); }
    finally { saving.current = false; if (active.current) { setBusy(false); if (generation === loadGeneration.current) setLoading(false); } }
  }
  async function signIn() {
    if (saving.current || signInLock.current) return;
    signInLock.current = true; setSigningIn(true); setError('');
    try { await beginCoreLogin('login', `/games/${game.id}`); }
    catch (value) {
      signInLock.current = false;
      if (active.current) { setSigningIn(false); setError(value instanceof Error ? value.message : 'Sign-in could not be started. Try again.'); }
    }
  }
  return <section className="game-high-scores" aria-labelledby="game-high-scores-heading">
    <div className="game-section-heading"><div><span className="eyebrow">THE ARCADE</span><h2 id="game-high-scores-heading">High scores</h2></div><span className="game-score-version">This published edition</span></div>
    <p className="game-small-note">{isCore ? 'Each game has its own board. Publishing a new edition starts a fresh board so different editions compete fairly.' : 'Local preview keeps scores on this browser. Shared scores are available on the connected site.'}</p>
    {isCore && <div className="filter-tabs game-score-tabs" role="group" aria-label="High-score board"><button disabled={busy} className={scope === 'shared' ? 'active' : ''} aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}>Shared</button><button disabled={busy} className={scope === 'browser' ? 'active' : ''} aria-pressed={scope === 'browser'} onClick={() => setScope('browser')}>This browser</button></div>}
    <p className="game-score-scope">{scope === 'shared' ? 'Shared · scores submitted by signed-in players' : 'This browser · saved only on this device and browser'}</p>
    {loading ? <p role="status">Opening the high-score board…</p> : board ? board.entries.length ? <ol className="game-score-list" aria-label={scope === 'shared' ? 'Shared high scores' : 'High scores on this browser'}>{board.entries.map((entry, index) => <li key={`${entry.createdAt}-${index}`}><span className="game-score-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span className="game-score-name">{entry.name}</span><strong>{entry.points.toLocaleString()} <small>points</small></strong></li>)}</ol> : <p className="game-score-empty">No scores yet. Finish a round and leave your arcade name!</p> : <button className="button secondary" disabled={busy} onClick={() => void reload()}>Try loading scores again</button>}
    {run && !savedRuns.has(`${run.id}:${submissionScope}`) && <form className="game-score-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div><strong>You earned {(run.result.points ?? 0).toLocaleString()} points!</strong><p>{submissionScope === 'shared' ? 'Leave an arcade name on the shared board. Everyone can see this name, so use a nickname.' : 'Keep this score on this browser. Use a nickname for your arcade name.'}</p></div>
      <label htmlFor="game-score-name">Arcade name<input id="game-score-name" autoComplete="off" maxLength={16} value={name} disabled={busy || signingIn} onChange={event => setName(event.target.value)} placeholder="e.g. GillPilot" aria-describedby="game-score-name-help" /></label>
      <span id="game-score-name-help" className="game-small-note">1–16 letters, numbers, spaces, underscores, or hyphens.</span>
      <button className="button primary" disabled={busy || signingIn || !name.trim()}>{busy ? 'Saving score…' : submissionScope === 'shared' ? 'Save shared score →' : 'Save on this browser →'}</button>
    </form>}
    {isCore && !signed && <p className="game-score-signin">Want to join the shared board? {embedded ? <a className="text-button" href={`/games/${encodeURIComponent(game.id)}`} target="_blank" rel="noopener noreferrer">Open this game to sign in ↗</a> : <button className="text-button" disabled={busy || signingIn} onClick={() => void signIn()}>{signingIn ? 'Opening sign-in…' : 'Sign in to save shared scores →'}</button>}</p>}
    {notice && <p className="game-score-notice" role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}

  </section>;
}
