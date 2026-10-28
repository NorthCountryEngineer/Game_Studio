import { useEffect, useMemo, useRef, useState } from 'react';
import { validateGameSpec } from '../lib/game-design';
import { createGameEngine, gameSandboxDocument, validateGameResult } from '../lib/game-runtime';
import { wordGameSandboxDocument } from '../lib/word-game-runtime';
import { isEndlessAsteroids, type GameResult, type GameSpec, type SingleGameSpec } from '../lib/game-types';
import { gamePlayerLoadMessage, validateGameReview, type GameReview } from '../lib/game-review';
import { PlayerSurface } from './PlayerSurface';
import { MultiGamePlayer } from './MultiGamePlayer';
import type { MultiGameProgress, MultiGameResult, MultiMaterialHandler } from '../lib/multi-game-session';
import { LevelFlowPlayer } from './LevelFlowPlayer';
import type { FlowProgress, MaterialHandler } from '../lib/game-flow-session';

export type GamePlayerProps = { spec: GameSpec; levelId?: string; stepId?: string; onMultiProgress?: (progress: MultiGameProgress) => void; onMultiComplete?: (result: MultiGameResult) => void; onMultiMaterialRequest?: MultiMaterialHandler; onComplete?: (result: GameResult) => void; playtest?: boolean; onReview?: (review: GameReview) => void; characterId?: string; onCharacter?: (id: string) => void; onMaterialRequest?: MaterialHandler; onFlowProgress?: (progress: FlowProgress, result?: GameResult) => void };
export function GamePlayer(props: GamePlayerProps) {
  if (props.spec.version === 8) return <MultiGamePlayer key={JSON.stringify(props.spec)} {...props} spec={props.spec} />;
  if (props.spec.version !== 3 && props.spec.flow && !props.levelId) return <LevelFlowPlayer key={JSON.stringify(props.spec)} {...props} spec={props.spec} />;
  return <GameFrame {...props} spec={props.spec} />;
}
export function GameFrame({ spec, levelId, onComplete, playtest = false, onReview, characterId, onCharacter }: Omit<GamePlayerProps, 'spec'> & { spec: SingleGameSpec }) {
  const fingerprint = JSON.stringify(spec);
  const instance = useMemo(() => {
    try {
      const validated = validateGameSpec(JSON.parse(fingerprint));
      if (validated.version === 8) throw new Error('Open a multi-game journey in its sequence player.');
      if (levelId && (validated.version === 3 ? levelId !== 'level-1' : !createGameEngine().getLevels(validated).some(level => level.id === levelId))) throw new Error('Choose a level in this game.');
      const nonce = crypto.randomUUID().replaceAll('-', '');
      return { spec: validated, nonce, document: validated.version === 3 ? wordGameSandboxDocument(nonce) : gameSandboxDocument(nonce), error: '' };
    } catch (error) { return { spec: undefined, nonce: '', document: '', error: error instanceof Error ? error.message : 'This game could not be loaded safely.' }; }
  }, [fingerprint, levelId, playtest]);
  const iframe = useRef<HTMLIFrameElement>(null);
  const completed = useRef(onComplete);
  const reviewed = useRef(onReview);
  const characterSelected = useRef(onCharacter);
  useEffect(() => { characterSelected.current = onCharacter; }, [onCharacter]);
  const [readyNonce, setReadyNonce] = useState('');
  const [failedNonce, setFailedNonce] = useState('');
  useEffect(() => { completed.current = onComplete; }, [onComplete]);
  useEffect(() => { reviewed.current = onReview; }, [onReview]);
  useEffect(() => {
    if (!instance.spec) return;
    const send = () => iframe.current?.contentWindow?.postMessage(gamePlayerLoadMessage(instance.spec!, instance.nonce, levelId, playtest, characterId), '*');
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== 'null' || !event.data || Array.isArray(event.data) || event.data.nonce !== instance.nonce) return;
      const keys = Object.keys(event.data);
      if (event.data.type === 'axolotl-game-character') {
        if (instance.spec!.version === 7 && keys.sort().join(',') === 'characterId,nonce,type' && typeof event.data.characterId === 'string' && ['maya', 'leo', 'sam', 'aisha', 'eli', 'nora', 'kai', 'robin'].includes(event.data.characterId)) characterSelected.current?.(event.data.characterId);
        return;
      }
      if (event.data.type === 'axolotl-game-review') {
        if (!playtest || keys.length !== 3 || keys.some(key => !['type', 'nonce', 'review'].includes(key))) return;
        const review = validateGameReview(event.data.review, instance.spec!, levelId);
        if (review) reviewed.current?.(review);
        return;
      }
      if (event.data.type === 'axolotl-game-result' ? keys.length !== 3 || keys.some(key => !['type', 'nonce', 'result'].includes(key)) : keys.length !== 2 || keys.some(key => !['type', 'nonce'].includes(key))) return;
      if (event.data.type === 'axolotl-game-ready') { setReadyNonce(instance.nonce); send(); }
      if (event.data.type === 'axolotl-game-loaded') setReadyNonce(instance.nonce);
      if (event.data.type === 'axolotl-game-result') {
        const result = validateGameResult(event.data.result, instance.spec!, levelId);
        if (result) completed.current?.(result);
      }
    };
    window.addEventListener('message', receive);
    // Covers an iframe that finished loading before React installed the listener.
    send();
    const timeout = window.setTimeout(() => setFailedNonce(instance.nonce), 12000);
    return () => { window.removeEventListener('message', receive); window.clearTimeout(timeout); };
  }, [instance, levelId, playtest]);
  if (instance.error) return <p role="alert">{instance.error}</p>;
  const ready = readyNonce === instance.nonce;
  return <PlayerSurface key={instance.nonce} frame={iframe} nonce={instance.nonce} title={spec.title}>
    {!ready && <p role="status">{failedNonce === instance.nonce ? 'The game is taking longer to load. Reload the page to try again.' : 'Preparing your game…'}</p>}
    <iframe key={instance.nonce} ref={iframe} title={`${spec.title} — isolated game player`} srcDoc={instance.document} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'" style={{ display: 'block', width: '100%', height: 'clamp(570px, 70vw, 850px)', border: 0, borderRadius: 12 }} onLoad={() => instance.spec && iframe.current?.contentWindow?.postMessage(gamePlayerLoadMessage(instance.spec, instance.nonce, levelId, playtest, characterId), '*')} />
    <p className="game-player-note">{spec.version === 3 ? 'The puzzle runs in an isolated player. Your entered letters and story answers stay inside this player. Only completion counts are reported.' : isEndlessAsteroids(spec) ? `Survive as long as you can. Difficulty rises during active play; Pause stops the clock.${playtest ? ' After five seconds, Finish playtest records your private review without submitting a score.' : ' The run ends when your lives are gone.'}` : 'The game runs in an isolated player. Use Start, Pause, Restart level, and the touch buttons, or click the game to use your keyboard. Complete a level to unlock the next one.'}</p>
  </PlayerSurface>;
}
