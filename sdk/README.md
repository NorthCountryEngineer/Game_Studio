# Game Studio host SDK

Build with `npm run build:sdk` from the repository root. It generates the standalone ES module at `public/sdk/game-studio.js` and an equivalent local package build under `sdk/dist/`. The SDK is served with public cross-origin module headers; it contains no tenant secrets or authentication tokens.

Exports:

- `createCreatorURL(studioOrigin, {hostId?, gameId?})`: full-page administrative creator link.
- `createHostSelectionURL(hostOrigin, returnPath, studioOrigin, gameId, publishedRevision)` and `readGameSelection(locationURL, expectedStudioOrigin)`: public game selection handoff.
- `createEmbedURL(studioOrigin, gameId, {hostId?, channel?})`: public player URL.
- `mountGame(container, {studioOrigin, hostId, gameId, title?, onEvent?})`: create the frame and validated event listener; returns `{iframe, destroy()}`.
- `listPublishedGames(apiOrigin, {signal?})`: paginated public catalog.
- `parseGameStudioEvent(value)`: strict version 1 event validation.

Use [the integration contract](../docs/INTEGRATION.md) and [local two-origin example](../examples/host/README.md). Import the module from the deployed studio URL or bundle the local built package; this repository does not publish a paid or public npm package. The host must approve the studio URL in its own script/frame policy, and the Game Studio deployment must approve the host origin independently.
