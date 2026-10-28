# Multi-game journeys

**Multi-game** composes complete games and client-owned objects into one published experience. It sits above each game's own levels. Game Studio supplies the sequence, fixed game players, completion observations and client handoff. Clients choose the subject matter, access rules and how to use those observations.

## Build a journey

Choose **Multi-game** in the workshop. The starter contains a crossword followed by a word search. The same left-stack and selected-step layout used by the leveled builder lets you drag palette items, drag existing steps, or use add buttons and move arrows with a keyboard or touch.

Available steps are Crossword, Word search, Mad Libs, 2D Platformer, finite Asteroids, Client object, Video, Interactive object, and an optional Free play ending. Selecting a game opens its complete puzzle or level editor. A leveled game retains its own levels and client-object flow. Selecting an outer client object opens its title, kind, opaque reference and required-completion setting.

You can also copy an existing finite solo game or continuous ending from the installation's draft library. Each step stores an independent copy of the actual definition. Editing the copy leaves the source unchanged; later source edits, publication or removal leave the journey unchanged. The published journey is a separate snapshot from its private draft. All copied puzzle answers and authored text become public when the journey is published, as with ordinary Game Studio games.

A journey supports up to 12 steps and eight game copies, including its ending, with at least one finite game. Its full validated definition must fit below 240,000 UTF-8 bytes. Nested multi-game journeys and cooperative games are excluded. All validators reject executable content, arbitrary URLs, unknown fields and unsupported combinations. Existing games and published snapshots are not migrated.

## Completion and free play

Main games run in order. Completing a game opens the next step; a loss ends that journey run. A required client object holds the sequence until the connected client confirms completion. Optional objects can be skipped. Objects after the last finite game still belong to the main sequence.

An optional **Free play ending** stays last and uses continuous solo Asteroids. The journey emits its completed result before offering **Continue in free play**. That result is frozen: free-play points, duration, restarts, losses and returning to the summary cannot change it or create another completion. This allows the main sequence to finish while a participant continues playing. Free play is optional for the participant and contributes no objective units, points or timing to the main result.

Each game keeps its ordinary raw result. Journey points use the game's own points when present; word games contribute 10 points per completed objective. Collection/objective counts and active time also sum across the finite games. Client objects contribute no gameplay points. Material timing and each child flow's timing stay distinct from active gameplay. The main `wallElapsed` includes navigation, loading, pauses and client waiting up to completion; time in free play is excluded.

## Third-party objects

Client objects use `content`, `video` or `interactive` kinds and an opaque reference such as `client:object-123`. The configured client resolves the reference under its own permissions, displays its content and decides when it is complete. Game Studio does not fetch arbitrary URLs or accept host credentials. A required object opened standalone clearly requests its connected client; it has no standalone completion shortcut. Private playtests provide explicit preview actions that never write client records.

Version 4 SDK events add `multi-progress` and path-bound `material-request`. A request has the journey run and request IDs plus a path: `[outerStepId]` for an outer object or `[outerGameStepId, innerNodeId]` for a child game's object. Replies bind the exact origin, source window, channel, game, publication revision, run, request and path. This keeps two child games' `step-1` nodes distinct. Old versions 1–3 remain supported.

```js
const player = mountGame(container, {
  studioOrigin, hostId, gameId,
  onMaterial(event, controls) {
    // Client-owned implementation: admit the run, resolve the reference,
    // check access and verify completion in that client's own records.
    clientObjects.open(event.node.reference, event.path).then(
      () => controls.complete(),
      () => controls.unavailable()
    );
  },
  onEvent(event) {
    if (event.version !== 4 || event.type !== 'multi-progress') return;
    const progress = event.progress;
    if (progress.status === 'completed') {
      // Store once per server-admitted run and exact publication.
      clientRuns.observeCompletion(progress.runId, progress.result);
    }
  }
});
```

The SDK exports `validateMultiGameSpec`, `defaultMultiGameSpec`, `parseMultiGameResult`, `validateMultiGameResult`, `createPublicationBinding` and `scorePublishedMultiGame`. Authorized automation can assemble the same data-only definition through the existing protected create/save API. Core permissions and the human playtest/publication requirement apply equally. Built-in conversation edits journey metadata; the visual editor or authorized data API controls the steps. This path invokes no paid model.

The client owns identity, run admission, required-object evidence, persistence, external awards and leaderboards. Completion is client-reported observation. `scorePublishedMultiGame` checks the full finite prefix, required objects, child flows, totals and exact publication hash before applying a client-approved provisional policy. It excludes free play from every denominator and total. It cannot prove identity or the quality of third-party content.

## Review and publication

Every outer step requires review in the saved revision, including client objects and free play. Preview a selected game to review every child level; a partial loss in its first level cannot acknowledge later levels. Child object references have an explicit inspection acknowledgment. Continuous free play uses the existing five-second private review or a real terminal round. Editing any step clears review. Material references and requirements are listed for final acknowledgment; their actual client adapter needs separate client acceptance.

Version 8 carries the `multi-game` definition and copied steps. It is excluded from the legacy unversioned catalog and global casual score boards. Current catalog consumers request `specVersion=all` and must support version 8. No new infrastructure, account roles, data migrations or third-party service connections are required by these source changes.

## Rehearse locally

```sh
npm run build:sdk
npm run dev -- --port 5180
# Separate terminal:
python3 -m http.server 5181 --bind 127.0.0.1 --directory tests/browser
```

Open `http://127.0.0.1:5181/multi-host.html`. Solve the synthetic crossword, continue to the required object, exercise unavailable/retry/confirm, then solve the word search. The parent displays one frozen completion before free play. Enter Asteroids, earn points and return to the summary to verify isolation. The two origins use the real SDK and players, with synthetic definitions and no accounts or remote providers. These fixtures are absent from the production build.

Automated coverage includes TypeScript/Python parity, byte limits, snapshot independence, protected lifecycle and no-paid-model routing, authoring and drag/drop events, nested object paths, duplicate/stale messages, result/hash checks, private all-level review, and completion freezing. Local checks do not establish a deployed release or acceptance in any external client.
