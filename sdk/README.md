# Game Studio host SDK

Finite level flows add version 3 `material-request` and `flow-progress` events. `mountGame` accepts `onMaterial(event, {complete, unavailable})`; the client resolves and verifies its own material before replying. `validateFlowCompletion` and `scorePublishedFlow` check whole-flow observations and publication-bound provisional points. See [the flow adapter and runnable rehearsal](../docs/LEVEL_FLOWS.md). Existing events remain unchanged for games without custom flows.

Build with `npm run build:sdk` from the repository root. It generates the standalone ES module at `public/sdk/game-studio.js` and an equivalent local package build under `sdk/dist/`. The SDK is served with public cross-origin module headers; it contains no tenant secrets or authentication tokens.

Exports:

- `createCreatorURL(studioOrigin, {hostId?, gameId?, autoLogin?})`: full-page administrative creator link. `autoLogin: true` requires a configured host ID and requests one bounded Core SSO redirect, using Game Studio's own audience and permissions.
- `createHostSelectionURL(hostOrigin, returnPath, studioOrigin, gameId, publishedRevision)` and `readGameSelection(locationURL, expectedStudioOrigin)`: public game selection handoff.
- `createEmbedURL(studioOrigin, gameId, {hostId?, channel?})`: public player URL.
- `mountGame(container, {studioOrigin, hostId, gameId, title?, onEvent?})`: create the frame and validated event listener; returns `{iframe, destroy()}`. The frame delegates fullscreen only to its configured studio origin; gameplay and completion messages retain their existing boundaries.
- `listPublishedGames(apiOrigin, {signal?})`: paginated public catalog.
- `parseGameStudioEvent(value)`: strict validation of version 1 events and the explicit version 2 completion envelope for advanced Asteroids (game format 6). Version 2 includes `specVersion: 6` and `mode: 'endless' | 'levels'`; endless runs report a loss when lives run out. Older hosts can keep playing embeds while ignoring unfamiliar completion events. Update the SDK before consuming these new observations.
- `validateScoringPolicy(value)`: strict normalized version 1 host assignment rules.
- `gameObjectiveUnits(spec)` and `calculateProvisionalPoints(spec, result, policy)`: full-game objective totals and deterministic provisional assignment points.
- `selectScoringAttempt([{ordinal, earned_points}], policy)`: first/latest/best selection using host-issued ordinals.
- `createPublicationBinding(publicSnapshot)` and `scorePublishedGame(publicSnapshot, expectedBinding, result, policy)`: asynchronous canonical SHA-256 edition binding and bound provisional calculation.

Assignment scoring does not change the game definition, version 1 event envelope or arcade leaderboard. The owning application must admit attempts, validate its runtime and current publication, recalculate on its backend, protect student records and approve final awards. See [assignment scoring](../docs/ASSIGNMENT_SCORING.md) for 25/100-point examples, rounding and reveal rules, replay boundaries and integration requirements.

Use [the integration contract](../docs/INTEGRATION.md) and [local two-origin example](../examples/host/README.md). Import the module from the deployed studio URL or bundle the local built package; this repository does not publish a paid or public npm package. The host must approve the studio URL in its own script/frame policy, and the Game Studio deployment must approve the host origin independently.
