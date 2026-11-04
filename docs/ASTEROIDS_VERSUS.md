# Asteroids versus

Standalone published Asteroids games with shooting offer an **Asteroids versus**
room alongside solo play. A creator does not need to edit or republish the game
to make this room option available. Games with a custom level flow and games
inside a Multi-game journey retain their existing solo experience.

The host chooses **1–5 lives per player** and **30–180 seconds per match**, then
creates a private invitation or offers an open seat through **Find a partner**.
The guest receives the host's fixed match rules. These settings cannot change
after the room is created; create a new room to choose different rules.

## Playing a match

Both players fly separate ships in the same asteroid field. Left/Right or A/D
turn the ship, Up/W thrusts, Down/S reverses, and Space or the touch **Fire**
button shoots. Versus uses turning controls even if the game's solo mode uses
directional movement. Existing touch controls and full-screen play are available.

Shots can hit the other ship. Each unprotected hit costs one life, and asteroid
collisions still matter. A surviving ship respawns on its side of the arena with
brief protection; it cannot shoot while that protection is active. Ships do not
damage themselves with their own shots. The host starts, pauses and restarts the
match. An interrupted connection pauses play rather than awarding a victory.

The last ship with lives wins. If both ships lose their last life in the same
physics tick, the result is a draw. At the time limit, the ship with more lives
wins; equal lives draw. Points do not break a tie. The result is shown to both
players. A rematch restores the chosen lives and timer with a fresh result.

The arena starts from the first authored level. Collection goals and later levels
do not end or advance the match. The original saved game, level plan, solo rules,
cooperative option, custom sprites and publication remain intact. Competitive
results stay in the room and do not submit solo leaderboard entries, claim a
campaign completion or emit assignment-completion events.

## Room and transport boundaries

The optional room field is exactly
`match: { mode: 'versus', lives: 3, timeLimit: 120 }`. Missing `match` retains the
existing cooperative room contract and its creator-controlled opt-in. The relay
validates versus eligibility and settings against the exact live published
edition, stores the settings in the room, and returns the same settings on
creation, admission, socket readiness and public listings. A guest or a snapshot
cannot change those settings. Public listings expose no invitation or seat
capabilities.

The host's fixed engine owns physics, damage, lives and results. The guest sends
only its own input controls. The existing relay validates bounded snapshots and
their match-result consistency, retains publication/revision/hash fences and
uses the existing connection-generation, sequence, conditional-write and lease
rules. Guest smoothing remains drawing-only. These are casual matches with a
host-authoritative browser, not an authoritative anti-cheat server.

No new hosting resources, model calls, identity permissions or saved-game
migration are required. A release updates both existing API/relay code and the
frontend, with backend acceptance before the frontend is promoted. Live
publication requires separate authorization; local tests and rehearsal use only
synthetic state.
