# Full-screen play

The shared player toolbar appears for every arcade format, crossword, word search, Mad Libs, private playtest and cooperative player. Click **Full screen**, press **F** while the player or its toolbar has focus, or press **Alt+Enter**. Use **Escape** or the visible exit button to return. F and Alt+Enter also toggle the active view off.

F is ordinary typing inside inputs, text areas, selects and editable content. Alt+Enter remains an explicit display shortcut from word-game inputs. Shortcuts outside the player do not interrupt the creator's editor. Repeated keys, input composition and Ctrl/Command shortcuts are ignored.

The toolbar stays visible above the game. Arcade canvases preserve their aspect ratio and share the available height with their existing controls. Word puzzles keep scrolling when needed. Unsupported or denied browser fullscreen falls back to a full-window view with an explanation and the same exit controls. A nested host that denies fullscreen can only expand within that host's iframe.

Switching views changes layout without replacing the game document, restarting a level, creating a new room, changing answers or submitting scores. Existing blur/Escape pause behavior remains available. Display messages from the fixed opaque game iframe are accepted only from the current source window, current nonce and exact three-field display schema. They grant no game, identity, network or publication authority. The sandbox still denies direct fullscreen; its trusted parent owns display changes.

## Embedding

The SDK and generated HTML snippets delegate fullscreen to the exact approved Game Studio origin. Use the updated SDK or add `allowfullscreen` and `allow="fullscreen https://your-studio-origin.example"` to the outer service iframe. Keep its existing sandbox and other permission restrictions. Every ancestor iframe and any host Permissions-Policy must permit the same trusted service origin for native fullscreen.

Axolotl News has a companion patch for its direct standalone-player iframe. NCAcademy has a companion wrapper around its approved local snapshot player. Academy's five attested runtime files, runtime digest, import approvals, scoring and attempt handling are unchanged. Its new hotkeys work while the parent display toolbar has focus; keys inside its existing pinned iframe retain their approved behavior. The button and native Escape exit are available for those games.

## Validation for this source change

- Game Studio: 315 TypeScript tests and preview build passed. Coverage includes native API entry/exit, rejected/unsupported APIs, request cancellation, stale ownership, document-wide display reservation and balanced scrolling across two players, exact iframe-message admission, keyboard typing and serialized bridges for all three runtimes.
- Local browser rehearsal: button, F, Alt+Enter and Escape passed in an explicitly unsupported-browser fixture. Arcade elapsed time and Mad Libs answers survived display changes. Two actual local WebSocket peers using the real Python relay retained their room, lives and matching elapsed time after host and guest display changes.
- Native Firefox acceptance on the rebased release source passed button, F and Alt+Enter entry, stable native display, Escape/button exit, and retention of the mounted arcade round. Native Mad Libs acceptance also preserved the typed word "fluffy" through Alt+Enter/Escape without revealing or submitting the story; typing F stayed in the input. The in-app browser entered native fullscreen and immediately exited it; it is not used as proof of stable native display. No browser-specific workaround is included.
- Academy: 466 frontend tests and production build passed; all five attested files remained byte-identical. Axolotl: six focused host tests and JSX transpilation passed; full typecheck could not finish because reads in its existing dependency tree stalled.

The rehearsal uses synthetic local state only. No production release, cloud configuration, persistent game migration, score update or paid request was performed for this change.
