import { useEffect, useMemo, useRef, useState } from 'react';
import { validateGameSpec } from '../lib/game-design';
import { createGameEngine, gameSandboxDocument, validateGameResult } from '../lib/game-runtime';
import { wordGameSandboxDocument } from '../lib/word-game-runtime';
import type { GameResult, GameSpec } from '../lib/game-types';

export function GamePlayer({ spec, levelId, onComplete }: { spec: GameSpec; levelId?: string; onComplete?: (result: GameResult) => void }) {
  const fingerprint = JSON.stringify(spec);
  const instance = useMemo(() => {
    try {
      const validated = validateGameSpec(JSON.parse(fingerprint));
      if (levelId && (validated.version === 3 ? levelId !== 'level-1' : !createGameEngine().getLevels(validated).some(level => level.id === levelId))) throw new Error('Choose a level in this game.');
      const nonce = crypto.randomUUID().replaceAll('-', '');
      return { spec: validated, nonce, document: validated.version === 3 ? wordGameSandboxDocument(nonce) : gameSandboxDocument(nonce), error: '' };
    } catch (error) { return { spec: undefined, nonce: '', document: '', error: error instanceof Error ? error.message : 'This game could not be loaded safely.' }; }
  }, [fingerprint, levelId]);
  const iframe = useRef<HTMLIFrameElement>(null);
  const completed = useRef(onComplete);
  const [readyNonce, setReadyNonce] = useState('');
  const [failedNonce, setFailedNonce] = useState('');
  useEffect(() => { completed.current = onComplete; }, [onComplete]);
  useEffect(() => {
    if (!instance.spec) return;
    const send = () => iframe.current?.contentWindow?.postMessage({ type: 'axolotl-game-load', nonce: instance.nonce, spec: instance.spec, levelId }, '*');
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== 'null' || !event.data || Array.isArray(event.data) || event.data.nonce !== instance.nonce) return;
      const keys = Object.keys(event.data);
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
  }, [instance, levelId]);
  if (instance.error) return <p role="alert">{instance.error}</p>;
  const ready = readyNonce === instance.nonce;
  return <div className="game-player">
    {!ready && <p role="status">{failedNonce === instance.nonce ? 'The game is taking longer to load. Reload the page to try again.' : 'Preparing your game…'}</p>}
    <iframe key={instance.nonce} ref={iframe} title={`${spec.title} — isolated game player`} srcDoc={instance.document} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'" style={{ display: 'block', width: '100%', height: 'clamp(570px, 70vw, 850px)', border: 0, borderRadius: 12 }} onLoad={() => iframe.current?.contentWindow?.postMessage({ type: 'axolotl-game-load', nonce: instance.nonce, spec: instance.spec, levelId }, '*')} />
    <p className="game-player-note">{spec.version === 3 ? 'The puzzle runs in an isolated player. Your entered letters and story answers stay inside this player. Only completion counts are reported.' : 'The game runs in an isolated player. Use Start, Pause, Restart level, and the touch buttons, or click the game to use your keyboard. Complete a level to unlock the next one.'}</p>
  </div>;
}
