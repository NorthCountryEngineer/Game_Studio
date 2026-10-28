# Game Studio

An independent, tenant-scoped NCE Core application for conversational arcade and word-game creation, private playtesting, publication, embedded play and shared arcade scores. Extracted from the deployed Axolotl News Game Studio at source revision `38719feef155e068ae8566fe21b3918f0809488b`; no newsroom stories, presentation, credentials or production records are included.

Creators describe an adventure and refine a saved game through conversation or the visual controls. Collection, dodge/Asteroids and platform games support up to eight designed levels, repeatable procedural layouts, progression, difficulty, touch controls, optional shooting/splitting/points, and named high scores. Only tested editions can be published. Published snapshots remain independent of draft changes. An administrator can pause creation without taking published games offline, manage content through the admin toggle and ellipsis menus, configure agents/modes/workflows, invite accounts, and customize service branding.

The workshop's **Asteroids** starter uses a spaceship and supports uploaded sprites for the ship, asteroids, rewards and enemies. Rocks enter from all four edges, and rewards can be shot or collected by contact in solo and cooperative games. See [sprite uploads and Asteroids behavior](docs/ASTEROID_CUSTOMIZATION.md).

The **2D Platformer** starter adds pixel worlds, walking, jumping and eight player-selected characters. Finite solo games share a drag/drop journey editor for levels, client-owned lessons/videos/exercises and an optional level home. Continuous Asteroids has separate survival settings. Clients can consume points, active play time and material completion through the SDK. See [level flows and client adapters](docs/LEVEL_FLOWS.md).

The **Multi-game** category composes complete puzzles and leveled games with generic client objects, videos and interactive objects. It uses the same drag/drop stack and selected-step editor. An optional continuous ending starts after the main result is finalized, keeping free-play scores separate. See [multi-game journeys](docs/MULTI_GAME.md).

Creators can also choose **Crossword**, **Word search**, or **Mad Libs**. Edit answers and clues, word lists, or story templates and prompts; save, playtest and acknowledge the content before publishing. Crosswords and word searches have repeatable seeded layouts. Mad Libs collects the player's words before revealing the story. All three run in the fixed isolated player, without arcade timers, lives or high-score boards. See [word-game workflow and limits](docs/WORD_GAMES.md).

Every standalone player and private playtest has a **Full screen** button. Press **F** while playing or **Alt+Enter** to toggle it; **Escape** and the visible exit button return to the page. Word-game text fields keep normal typing. Solo and cooperative play use the same mounted game while switching views. See [full-screen controls and host support](docs/FULLSCREEN.md).

Owning applications can reuse a game with their own assignment point scale, such as 25 or 100 points. The SDK supplies strict versioned policies, deterministic provisional calculations, exact publication bindings and first/latest/best attempt selection. The host owns student records, server-admitted attempts, policy approval and final awards. See [assignment scoring](docs/ASSIGNMENT_SCORING.md).

## Run locally

Requires Node 20.18+ and Python 3.12+. This preview uses browser storage, synthetic account administration and the free guided designer. It makes no AWS or model requests.

```sh
git clone https://github.com/NorthCountryEngineer/Game_Studio.git
cd Game_Studio
npm ci --no-audit --no-fund
npm run build:sdk
npm run dev
```

Open `http://127.0.0.1:5180/game-studio`. To configure local branding and a connected local host, copy `game-studio-config.example.json` to ignored `game-studio-config.json`, replace its example origins, and restart the preview. For a real second-origin integration, see [the runnable host example](examples/host/README.md).

For two-session multiplayer rehearsal, run `npm run dev:multiplayer` and open `http://127.0.0.1:8096/__multiplayer-fixture` in two browser sessions. Host a two-player game in one session and paste its invitation into the other. The loopback HTTP/WebSocket adapter uses the real Python relay with synthetic in-memory database/callback ports. `npm run test:multiplayer-preview` starts an isolated temporary preview, checks two actual WebSocket clients and stops its own servers; CI runs the same check. To check an already-running preview, use `npm run test:multiplayer-preview -- --reuse`. Stop it with Ctrl+C to discard all temporary rooms. This development fixture is never included in the production frontend; it neither creates accounts nor calls AWS, Core or models.

## Integrate an application

1. Install/deploy Game Studio for the intended Core tenant and environment. Each installation has its own data, paired Core clients and origin.
2. Approve the host's exact origin and fixed return path in deployment configuration.
3. Add a **Create games** link to the host's administrative UI using `createCreatorURL(origin, {hostId, autoLogin: true})`. It opens Game Studio as a full page and reasserts Core's current account through its own sign-in flow. Existing Core login and remembered consent are reused; first consent or expired Core login can require a Core page. Game Studio independently requires its explicit `games-create` administrative capability; publication also requires `games-publish`. Existing delegated creation/publishing administrators retain their permissions.
4. An authorized game administrator creates, tests and publishes a game. Copy its player link or SDK snippet into the host's lesson/page configuration.
5. Players use the embedded public player. Signed-in shared score submission uses Game Studio's own top-level Core login; anonymous embedded play can keep local scores. No host access token is forwarded.

The companion Core recipe is tracked in [NCE Core PR #6](https://github.com/NorthCountryEngineer/NCE_Core/pull/6). Source validation and release evidence are recorded in [validation](docs/VALIDATION.md); do not infer live acceptance from a local build.

See [integration contract](docs/INTEGRATION.md), [architecture and boundaries](docs/ARCHITECTURE.md), [Core onboarding](nce/README.md), and [AWS deployment](deployment/README.md). The SDK is framework-independent ES modules, served at `/sdk/game-studio.js`; no npm publication or subscription is required.

## Validate

```sh
npm run typecheck
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
python3 scripts/validate-deployment.py
python3 scripts/package-api.py
npm run build:preview
```

These checks use synthetic state and mocked providers. They do not establish live AWS/Core acceptance. Infrastructure scripts default to local planning; live provisioning is a separate operator action that can incur AWS charges. Existing Axolotl games and its deployment remain unchanged by this extraction. Do not point this service at Axolotl's tables or credentials.

Optional two-player cooperative arcade games preserve solo play and give each player their own character, lives, goals and points in one shared world. Private invitations remain the default. Hosts can explicitly choose **Find a partner** to offer one open seat in the Games homepage's **Looking for a partner** section. Active rooms renew their leases without a fixed 30-minute room-age cutoff. See [the multiplayer workflow, privacy and additive relay release](docs/MULTIPLAYER.md).

Asteroids games can offer periodic collectible prizes: triple shot, rapid fire, a one-hit shield and a speed boost. Configure the selection and timing, then save, playtest and publish. Prizes work in solo and cooperative play. See [prize effects, configuration and testing](docs/ASTEROID_PRIZES.md).

Advanced Asteroids drafts can opt into endless survival, three asteroid size stages, and configurable enemy ships that wander, track, or pursue and fire. Endless survival retains the authored campaign while using its first level for a continuous run, with increasing active-play difficulty and boosts that last until impact. A separate private **Finish playtest** review lets creators acknowledge that run without inventing a loss or submitting a score. These source changes require local validation and a reviewed release; see [authoring, compatibility and testing](docs/ASTEROID_CHALLENGES.md).
