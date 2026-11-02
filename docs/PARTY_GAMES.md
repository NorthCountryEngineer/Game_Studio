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
have ten minutes for a rematch; closed rooms have one minute. Retention does not
slide on repeated reads. Expired rows are reclaimed when another room is created,
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
