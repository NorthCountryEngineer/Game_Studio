import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPlayerDisplay, type PlayerDisplayState } from '../lib/game-fullscreen';

export function PlayerSurface({ frame, nonce, title, children, cooperative = false }: {
  frame: RefObject<HTMLIFrameElement>; nonce: string; title: string; children: ReactNode; cooperative?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const display = useRef<ReturnType<typeof createPlayerDisplay>>();
  const [state, setState] = useState<PlayerDisplayState>({ mode: 'windowed', pending: false, notice: '' });
  useEffect(() => {
    setState({ mode: 'windowed', pending: false, notice: '' });
    const controller = createPlayerDisplay({ element: root.current!, frame: () => frame.current, exitButton: () => button.current, nonce, onChange: setState });
    display.current = controller;
    return () => { display.current = undefined; controller.destroy(); };
  }, [frame, nonce]);
  const active = state.mode !== 'windowed';
  return <div ref={root} className={`game-player player-surface${cooperative ? ' cooperative-player' : ''}${active ? ' player-surface-active' : ''}`} data-display={state.mode} role={active ? 'dialog' : 'region'} aria-modal={active || undefined} aria-label={`${title} game player`} tabIndex={-1}>
    <div className="player-display-toolbar">
      <span>{active ? title : 'Make room for your adventure.'}</span>
      <div><small>{active ? 'Esc to exit' : 'F or Alt + Enter while playing'}</small><button ref={button} type="button" className="button secondary player-fullscreen-button" aria-keyshortcuts="F Alt+Enter Escape" aria-pressed={active} disabled={state.pending} onClick={() => display.current?.toggle()}>{active ? state.mode === 'expanded' ? 'Exit expanded view' : 'Exit full screen' : state.pending ? 'Opening…' : 'Full screen'} <span aria-hidden="true">{active ? '↙' : '⛶'}</span></button></div>
    </div>
    {state.notice && <p className="player-display-notice" role="status">{state.notice}</p>}
    {children}
  </div>;
}
