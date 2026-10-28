export type PlayerDisplayMode = 'windowed' | 'fullscreen' | 'expanded';
export type PlayerDisplayState = { mode: PlayerDisplayMode; pending: boolean; notice: string };
export type PlayerDisplayAction = 'toggle' | 'exit';
const playerDisplayOwners = new WeakMap<HTMLElement, symbol>();
const documentDisplayOwners = new WeakMap<Document, symbol>();

/** Display messages confer no gameplay, identity, or networking authority. */
export function gameDisplayMessage(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, source: Window | null | undefined, nonce: string): PlayerDisplayAction | undefined {
  const data = event.data;
  if (!source || event.source !== source || event.origin !== 'null' || !data || typeof data !== 'object' || Array.isArray(data)) return;
  if (Object.keys(data).length !== 3 || !Object.keys(data).every(key => ['type', 'nonce', 'action'].includes(key)) || data.type !== 'game-player-display' || data.nonce !== nonce) return;
  if (data.action === 'toggle' || data.action === 'exit') return data.action;
}

export function playerDisplayShortcut(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target' | 'defaultPrevented'> & { keyCode?: number }): PlayerDisplayAction | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Escape' && !event.altKey) return 'exit';
  if (event.key === 'Enter' && event.altKey) return 'toggle';
  const target = event.target as HTMLElement | null;
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])')) return;
  if (event.key.toLowerCase() === 'f' && !event.altKey) return 'toggle';
}

/** Fullscreen changes layout only: the same mounted iframe and live room keep running. */
export function createPlayerDisplay(options: {
  element: HTMLElement;
  frame: () => HTMLIFrameElement | null;
  exitButton: () => HTMLButtonElement | null;
  nonce: string;
  onChange: (state: PlayerDisplayState) => void;
}) {
  const root = options.element, doc = root.ownerDocument, win = doc.defaultView!;
  const owner = Symbol('player display'); playerDisplayOwners.set(root, owner);
  const ownsDisplay = () => playerDisplayOwners.get(root) === owner;
  const ownsDocument = () => documentDisplayOwners.get(doc) === owner;
  const releaseDocument = () => { if (ownsDocument()) documentDisplayOwners.delete(doc); };
  let state: PlayerDisplayState = { mode: 'windowed', pending: false, notice: '' };
  let alive = true, cancelled = false, savedOverflow: string | undefined;
  let returnFocus: HTMLElement | null = null;
  const ownNative = () => doc.fullscreenElement === root;
  const publish = () => { if (alive && ownsDisplay()) options.onChange({ ...state }); };
  const focusGame = () => options.frame()?.focus({ preventScroll: true });
  function restoreOverflow() { if (savedOverflow !== undefined) { doc.body.style.overflow = savedOverflow; savedOverflow = undefined; } }
  function windowed() {
    restoreOverflow(); releaseDocument(); state = { mode: 'windowed', pending: false, notice: '' }; publish();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function expanded() {
    if (!alive || !ownsDisplay() || !ownsDocument() || cancelled) return;
    if (savedOverflow === undefined) savedOverflow = doc.body.style.overflow;
    doc.body.style.overflow = 'hidden';
    state = { mode: 'expanded', pending: false, notice: 'Browser full screen is unavailable here. The player fills this window instead.' }; publish(); focusGame();
  }
  function closeNative() { if (!ownsDisplay()) return; try { void Promise.resolve(doc.exitFullscreen()).catch(() => { if (alive) { state.notice = 'Use Escape to leave full screen.'; publish(); } }); } catch { if (alive) { state.notice = 'Use Escape to leave full screen.'; publish(); } } }
  function exit() {
    cancelled = true;
    if (ownNative()) closeNative();
    else if (state.mode === 'expanded') windowed();
  }
  function toggle() {
    if (!alive || !ownsDisplay() || state.pending) return;
    if (state.mode !== 'windowed' || ownNative()) { exit(); return; }
    if (documentDisplayOwners.has(doc) && !ownsDocument()) { state.notice = 'Close the other player display first.'; publish(); return; }
    if (doc.fullscreenElement) { state.notice = 'Close the other full-screen view first.'; publish(); return; }
    documentDisplayOwners.set(doc, owner);
    cancelled = false; returnFocus = doc.activeElement as HTMLElement | null;
    if (typeof root.requestFullscreen !== 'function' || doc.fullscreenEnabled === false) { expanded(); return; }
    state.pending = true; state.notice = ''; publish();
    // Keep this call synchronous with the click/keypress. Ancestor activation
    // from the fixed opaque game frame is also preserved through postMessage.
    try {
      void Promise.resolve(root.requestFullscreen()).then(() => {
        state.pending = false;
        if (!alive || cancelled) { if (ownNative()) { state.mode = 'fullscreen'; publish(); closeNative(); } else if (alive) windowed(); return; }
        if (ownNative()) { state.mode = 'fullscreen'; publish(); focusGame(); }
        else windowed();
      }, () => { state.pending = false; if (alive && !cancelled) expanded(); else if (alive) windowed(); });
    } catch { state.pending = false; expanded(); }
  }
  const change = () => {
    if (!ownsDisplay()) return;
    if (ownNative()) { if (cancelled) { state.mode = 'fullscreen'; state.pending = false; publish(); closeNative(); return; } state.mode = 'fullscreen'; publish(); }
    else if (state.mode === 'fullscreen') windowed();
  };
  const receive = (event: MessageEvent) => {
    const action = gameDisplayMessage(event, options.frame()?.contentWindow, options.nonce);
    if (action === 'toggle') toggle(); else if (action === 'exit') exit();
  };
  const keydown = (event: KeyboardEvent) => {
    if (!ownsDisplay() || state.mode !== 'windowed' && !ownsDocument()) return;
    const target = event.target as Node | null;
    // Typing or shortcuts elsewhere in the editor must never open a player.
    if (state.mode === 'windowed' && !root.contains(target) && doc.activeElement !== options.frame()) return;
    const action = playerDisplayShortcut(event);
    if (action === 'toggle') { event.preventDefault(); toggle(); }
    else if (action === 'exit' && state.mode !== 'windowed') exit();
  };
  const focus = (event: FocusEvent) => { if (ownsDisplay() && ownsDocument() && state.mode !== 'windowed' && !root.contains(event.target as Node | null)) options.exitButton()?.focus({ preventScroll: true }); };
  doc.addEventListener('fullscreenchange', change);
  doc.addEventListener('keydown', keydown);
  doc.addEventListener('focusin', focus);
  win.addEventListener('message', receive);
  return {
    toggle, exit,
    destroy() {
      alive = false; cancelled = true;
      doc.removeEventListener('fullscreenchange', change); doc.removeEventListener('keydown', keydown); doc.removeEventListener('focusin', focus); win.removeEventListener('message', receive);
      restoreOverflow(); if (ownNative()) closeNative(); releaseDocument();
    },
  };
}
