# Game Studio host SDK

Finite level flows add version 3 `material-request` and `flow-progress` events. `mountGame` accepts `onMaterial(event, {complete, unavailable})`; the client resolves and verifies its own material before replying. `validateFlowCompletion` and `scorePublishedFlow` check whole-flow observations and publication-bound provisional points. See [the flow adapter and runnable rehearsal](../docs/LEVEL_FLOWS.md). Existing events remain unchanged for games without custom flows.

Multi-game journeys use version 4 `material-request` and `multi-progress` events. The same `onMaterial` callback handles both protocols. A version 4 request includes `path`: `[journeyStepId]` for an outer client object or `[journeyStepId, levelFlowNodeId]` for an object inside a child game's level flow. Resolve `event.node.reference` in the client and call `complete()` only after that client's own completion rules are satisfied. `unavailable()` keeps required objects gated and lets optional objects be skipped. References are opaque identifiers; Game Studio does not load third-party URLs, HTML, tokens or code.

```js
const player = mountGame(container, {
  studioOrigin: 'https://games.example', hostId: 'client', gameId,
  onMaterial(event, controls) {
    // Use the client's own session, object catalog and completion authority.
    client.openObject(event.node.reference, {
      onCompleted: controls.complete,
      onUnavailable: controls.unavailable,
    });
  },
  onEvent(event) {
    if (event.version === 4 && event.type === 'multi-progress') {
      // completed is emitted once before an optional free-play finale begins.
      // free-play observations carry the same frozen finite result.
      client.observeJourney(event.progress);
    }
  },
});
```

`progress.result` contains finite child results, outer object observations, total active play time (`elapsed`), total journey time (`wallElapsed`), objective counts (`score`) and gameplay `points`. Child points are used when the child reports them; other child objective counts contribute ten gameplay points each. Inner object observations remain under `result.games[].flow`, so identically named steps in different games stay distinct. Outer object observations carry their one-element path. Free play contributes no finite points or time and cannot create a second completion.

Use `validateMultiGameResult(spec, result)` to check the exact child order, valid loss prefix, required outer and inner objects, and totals. Envelope parsers check shape; definition-aware validation is still required before using an observation. `scorePublishedMultiGame(publicSnapshot, expectedBinding, result, policy)` also binds the exact immutable edition and calculates a client-owned provisional scale. Completion uses the whole journey outcome; proportional uses finite objective counts; `arcade_target` uses the combined finite gameplay points and an explicit client target. The existing crossword reveal policy applies to the lost crossword's contribution. Required client object completions must additionally be checked against the client's trusted records. `calculateProvisionalPoints` intentionally rejects multi-game definitions and directs callers to the whole-journey helper.

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
- `parseMultiGameResult(value)`, `parseMultiGameProgress(value)` and `validateMultiGameResult(spec, result)`: strict multi-game telemetry and complete finite route validation.
- `scorePublishedMultiGame(publicSnapshot, expectedBinding, result, policy)`: publication-bound provisional calculation for the full multi-game route, including required client object completion and excluding optional final free play.

Assignment scoring does not change the game definition, version 1 event envelope or arcade leaderboard. The owning application must admit attempts, validate its runtime and current publication, recalculate on its backend, protect student records and approve final awards. See [assignment scoring](../docs/ASSIGNMENT_SCORING.md) for 25/100-point examples, rounding and reveal rules, replay boundaries and integration requirements.

Use [the integration contract](../docs/INTEGRATION.md) and [local two-origin example](../examples/host/README.md). Import the module from the deployed studio URL or bundle the local built package; this repository does not publish a paid or public npm package. The host must approve the studio URL in its own script/frame policy, and the Game Studio deployment must approve the host origin independently.
