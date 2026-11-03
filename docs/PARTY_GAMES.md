# Party games

The public Party games library is `/party`. No account is required to play. It
contains Mafia and five additional fixed games, with a consistent choice between
**Play online** and **Host in person**.

| Game | Players | Online play |
| --- | --- | --- |
| Mafia | 5–24, plus a human narrator if selected | Existing private roles, narration, night actions and voting |
| Starship Suspects | 4–12 | Original hidden-impostor game with a deck map, tasks, sabotage, meetings and voting |
| Sketch & Guess | 2–12 | Shared drawing canvas, private prompts, guesses and scored turns |
| Trivia Rally | 2–24 | Simultaneous private answers and scored question rounds |
| Rock–Paper–Scissors Duel | 2 | Simultaneous secret choices and a best-of-five match |
| Drop Four | 2 | Alternating disc drops, four-in-a-row wins and draws |

Starship Suspects uses original presentation and content. It is inspired by the
hidden-impostor party-game format; it is not an official Among Us client or a
reproduction of its art. All five new online engines use fixed rules and bounded
bundled content. They make no model calls. Existing Mafia's approved cached AI
narration remains independent and makes no model calls during play.

## How to play

All six party games have a collapsible **How to play** guide before play and in
the online room, including the lobby and active rounds. The same guide has
in-person instructions in the host controller. Starship Suspects explains its
secret teams, room-card movement, symbol tasks, tagging, repairs, meetings,
voting and win conditions without assuming knowledge of another game. The
guide contains only public rules and never reads private room state. It starts
closed, supports normal keyboard disclosure controls and stays open through
online room updates. Reading it does not pause an online timer.

## Drawing on desktop and mobile

Sketch & Guess accepts mouse, pen and one-finger drawing on the same canvas.
Dragging inside the canvas draws instead of scrolling the page. Pointer capture
keeps a line connected if the pointer leaves the canvas; additional fingers do
not take over the current line. Normal page scrolling works outside the canvas.

The artist sees ink immediately while bounded batches save in the background.
Long lines continue across overlapping segments rather than stopping at a point
limit. A pending save does not disable the pen. Confirmed segment identifiers
replace local ink without drawing it twice; uncertain requests retry with their
original action identity. Clearing the canvas changes its epoch so delayed old
ink cannot reappear. Changing the artist or ending the turn discards old local
work.

Only the current artist can send drawing data. Batches contain at most six
segments of 120 points each and use the existing sequenced room transport. The
server retains at most 384 segments, 8,000 points and 120 KB of serialized
geometry. Older lines gradually lose detail and the oldest segments eventually
age out, allowing continued drawing within the room's storage limits. The
existing room action budget still applies; network retries never block local
pointer input. Legacy complete-stroke requests remain supported.

## In-person hosting

`/party/{kind}/host` is a local host controller. The lead adds names and avatars,
starts the game, advances phases or rounds, records outcomes, adjusts points and
can undo a mistake. Names and the current game are saved in that browser for
reload recovery. The host can start a fresh game with the same group.

**Open game screen** opens a separate presentation tab for a projector, TV or
shared display. Keep the host controls on the lead's private display. Only the
sanitized presentation snapshot is transmitted to that tab. Roles, drawing
prompts, trivia answers and unrevealed hands are excluded until the host chooses
the applicable reveal. Use physical role cards or privately tell people their
roles when playing hidden-role games together. Narrating, counting physical
votes and confirming in-person outcomes remain the lead's responsibility.

The local host controller supports all six games. It uses browser storage and a
same-origin broadcast channel, with a separate random capability for the public
view. It does not create an online room, call a provider or send game actions to
the backend. This separation keeps the projector's normal UI free of host
secrets; it does not isolate secrets from someone with access to the lead's
browser profile or developer tools. Use a private host device for secret games.

## Online room protocol and storage

The five new games use `/party/rooms` and `/party/rooms/{id}`. Mafia retains its
existing `/mafia` protocol and storage. Invitations carry a random capability in
the URL fragment. Each seat has a different random capability in its bearer
header; invitations do not grant read access to a participant's private view.
Only capability hashes are stored. Creator/admin Core permissions and all
published GameSpec formats remain unchanged.

Creation and joining use stable request IDs and fingerprints. Actions use
per-seat monotonic sequences, fingerprints and a phase ID. Exact retries are
idempotent; changed or stale requests fail without replaying an earlier action.
Room transitions, admission and lease/index changes use conditional DynamoDB
transactions in the existing public table. Reads project only the requesting
seat's permitted view. Private rows are filtered before catalog payload decoding.

At most 32 new-party rooms are tracked at once. Creation is limited per gateway
source and installation in a ten-minute bucket; these limits are independent of
Mafia's existing room limits. Active rooms renew a two-hour lease. Finished rooms
have ten minutes for a rematch. Closing an active room gives it one minute;
closing an already finished room keeps its existing deadline of up to ten
minutes. Retention does not slide on repeated reads. Expired rows are reclaimed when another room is created,
under the same conditional index fence as renewal. Chat, events, drawing vectors,
participants, requests and stored payloads are bounded. No table, IAM, relay,
capacity or model configuration change is needed for these engines.

These are casual game results. Host-entered scores and outcomes are not an
assessment or identity verification mechanism.

## Offline rehearsal

Run `python3 scripts/mafia-preview.py` for the synthetic in-memory Mafia and party
API. In another terminal run Vite with `MAFIA_PREVIEW_URL` and
`PARTY_PREVIEW_URL` set to `http://127.0.0.1:8097`, and
`VITE_MAFIA_PREVIEW_API=/mafia-api`, `VITE_PARTY_PREVIEW_API=/party-api`.
Use the local preview configuration rather than a production Core binding. The
server binds only to loopback and never calls AWS, Core or models. Stop it to
discard online rehearsal rooms; local in-person sessions can be reset in the UI.
