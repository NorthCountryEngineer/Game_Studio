# Pixel platformers and composed level journeys

The **2D Platformer** category creates a fixed pixel game with walking left/right, jumping, repeatable platform layouts and collectible goals. The standard starter visits garden, lakeside and space themes. Each player chooses one of eight cosmetic characters inside the player; creators cannot preselect a character or give one different movement rules. Each collectible earns 10 gameplay points.

## Build a leveled game

Finite solo arcade and platformer games share **Your game flow**. The left stack shows the ordered journey; selecting a step opens its settings beside it. Drag steps or palette items into position, or use add buttons and move arrows with a keyboard or touch.

- **Game level:** title, brief, theme, goal, time, lives, difficulty and repeatable layout seed.
- **Lesson, video or exercise:** title, opaque client reference and whether client completion is required.
- **Level home:** an optional first screen with full-adventure entry and individual unlocked level practice.

There are at most eight levels and 24 total steps. Every saved level appears exactly once. A home screen stays first. A game with levels alone is a complete entertainment game and needs no education integration.

The full adventure follows authored order and reports combined points, collection counts and active gameplay time. Home-screen practice can choose any unlocked level; its results stay separate from the combined adventure and assignment completion. Required activities before a level must complete before that level can be practiced. Material after the final game level still has to complete, or be explicitly skipped if optional, before the flow reports a win.

**Continuous Asteroids** has a separate starting-world/survival editor, without level tiles, collection goals or countdowns. The underlying authored campaign stays saved when changing between timed and continuous Asteroids. A custom material flow must be explicitly removed before enabling continuous or cooperative play; the removal dialog preserves the choice and all game levels remain. Cooperative games retain their shared-world levels; interstitial material is currently a solo feature. Word games remain single puzzle activities.

## Client-owned material

A reference such as `ncacademy:lesson-123` is an identifier, never a URL. Game Studio does not fetch it, frame arbitrary content or carry authentication tokens. The connected client resolves it under its own content permissions and displays its lesson, video or exercise beside or over the embedded game. This release supplies the adapter contract and a runnable synthetic rehearsal; it does not modify NCAcademy's course UI, enrollment, videos or gradebook.

The SDK checks the exact studio origin, frame window, channel and game. Requests and responses additionally bind publication revision, run ID, request ID and node ID. A response releases one pending request. Stale, wrong-origin, wrong-window, wrong-edition and extra-field messages are ignored. Destroying/restarting the player cancels pending gates. An unavailable response leaves required material blocked and offers retry.

```js
import { mountGame } from 'https://YOUR_STUDIO_ORIGIN/sdk/game-studio.js';

const player = mountGame(container, {
  studioOrigin: 'https://YOUR_STUDIO_ORIGIN',
  gameId: reviewedGameId,
  hostId: configuredHostId,
  onMaterial(event, controls) {
    // Implement in the client: bind to an admitted run, check current access,
    // resolve event.node.reference, display it and verify real completion
    // in the client's own server records before confirming.
    clientActivityAdapter.open(event).then(
      () => controls.complete(),
      () => controls.unavailable()
    );
  },
  onEvent(event) {
    if (event.version === 3 && event.type === 'flow-progress') {
      clientActivityAdapter.observe(event);
    }
  }
});
```

Standalone players can skip optional material. Required material explains that the game must be opened from its client and cannot manufacture an exercise completion. Private playtests provide a labeled preview continuation. That preview never sends host completion events or writes client activity records. Creators acknowledge the listed material references and requirements; actual client content and completion behavior require their own acceptance review.

## Points, timing and leaderboards

Version 3 host events add `material-request` and `flow-progress`. Version 1 and advanced Asteroids version 2 completion events remain unchanged for games without custom flows. Flow hosts consume version 3. A terminal flow progress event carries its validated `result` plus:

- run ID, status, current node and completed level IDs;
- material node IDs, completed/skipped status and elapsed seconds;
- collected-object count, gameplay points and `gameplayElapsed`;
- `wallElapsed`, also including menus, loading, pauses and material waiting.

No answers, student identity, roles, tokens or grading authority cross these messages. Gameplay clocks stop during material, pause and transitions. Clients choose whether a leaderboard compares active play or total-run time, and compare admitted attempts of the same publication/policy. They own class membership, displayed names, attempt limits, persistence and ordering. Platformer points do not create a global public arcade board.

Assignment policies support platformer points through `arcade_target`, or collection proportion/completion on the client's chosen scale. `validateFlowCompletion(spec, progress, result)` checks level/material coverage, required flags, result agreement and timing consistency. `scorePublishedFlow(publication, binding, progress, result, policy)` adds exact publication hashing and provisional point calculation. The host must also verify required material against its own admitted activity records before accepting an award. The older `scorePublishedGame` validates gameplay only, so flow hosts should use the flow helper.

## Schema and compatibility

Version 7 is the fixed solo pixel platformer. Optional `flow: {version: 1, nodes: [...]}` is accepted on finite solo versions 2, 5, 6 and 7. TypeScript and Python validators enforce strict matching shapes, references and bounds. Existing snapshots are not migrated. Legacy catalogs omit version 7 and every custom-flow edition; current consumers request `specVersion=all`. Models cannot create/change client references or required gates. Small edits preserve the creator's route; requested level-count changes reconcile level nodes while retaining material.

## Local rehearsal

```sh
npm run build:sdk
npm run dev -- --port 5180
# A separate terminal:
python3 -m http.server 5181 --bind 127.0.0.1 --directory tests/browser
```

Open `http://127.0.0.1:5181/flow-host.html`. The synthetic client and real SDK/player run on separate loopback origins. Start the adventure, report the warm-up unavailable, retry and confirm it to unlock character selection and gameplay. Open `http://127.0.0.1:5180/tests/browser/flow-player.html` directly to demonstrate a blocked standalone required step. These Vite-only fixtures contain synthetic data and are absent from the production build.

Automated coverage includes schema parity, model/draft/publication preservation, reachable layouts, actual serialized keyboard/touch gameplay, characters, points, flow orchestration, home practice isolation, duplicate results, StrictMode dispatch, final optional-step cancellation and exact host bindings. Local checks and synthetic rehearsal do not establish production or authenticated NCAcademy acceptance.
