# Common host interface, version 1

Configure exact host origins in the installation's `GAME_STUDIO_CONFIG_JSON`, using [the example](../game-studio-config.example.json). The same reviewed configuration feeds backend CORS and frontend framing policy. Do not put credentials or tenant selectors into a host URL.

## Administrative creation

```js
import { createCreatorURL } from 'https://YOUR_STUDIO_ORIGIN/sdk/game-studio.js';

// Render only in the host application's authorized administrative UI.
creatorLink.href = createCreatorURL('https://YOUR_STUDIO_ORIGIN', {
  hostId: 'academy',
  // gameId: 'EXISTING_PRIVATE_GAME_UUID' // optional: edit an existing game
});
creatorLink.target = '_blank';
creatorLink.rel = 'noopener noreferrer';
```

The creator opens as a full page, uses its own Core service audience and provides a configured **Return to application** link. The host's role is never trusted as Game Studio authority. Ask a Game Studio administrator for the delegated creation/publishing role. There is no automatic account or role provisioning.

After publication, **Use this game in APPLICATION** returns to the configured host path with `gameStudioOrigin`, `gameStudioGameId` and `gameStudioRevision` query values. `readGameSelection(location.href, expectedStudioOrigin)` validates this public selection envelope. The host must check the game is currently published through the public API and ask its administrator to attach it to the intended lesson/page. This navigation never saves host content, changes permissions or proves who made the selection.

## Published player

```js
import { mountGame } from 'https://YOUR_STUDIO_ORIGIN/sdk/game-studio.js';

const player = mountGame(document.querySelector('#lesson-game'), {
  studioOrigin: 'https://YOUR_STUDIO_ORIGIN',
  hostId: 'academy',
  gameId: 'PUBLISHED_GAME_UUID',
  title: 'Lesson practice game',
  onEvent(event) {
    if (event.type === 'completed') {
      // Advisory gameplay telemetry; host policy decides what to do with it.
      showPracticeResult(event.result);
    }
  }
});
// On page teardown:
player.destroy();
```

The SDK generates a unique channel and validates messages against the expected frame, origin, channel and game. A raw iframe snippet is also available in **Share or embed** after publication. Preserve its `referrerpolicy="strict-origin"`, approved host ID and channel. Hosts must permit the configured studio origin in their own `frame-src` and SDK URL in `script-src`. A host-wide `no-referrer` policy must not override the player's strict-origin referrer requirement.

The version 1 completion envelope contains `version`, `source`, `channel`, `type`, `gameId`, `publishedRevision` and `result`. Results contain outcome (`won`/`lost`), elapsed time, collected count in `score`, optional arcade points and reviewed level IDs. Word games report solved answers, found words or completed prompts; a crossword solution reveal reports `lost`. They use the single review item `level-1` and have no points or high-score board. No entered letters, Mad Libs answers, completed stories, user identifiers or authentication material are sent. Extra result fields are rejected. The shared SDK permits finite elapsed seconds from 0 through 86,400 for untimed puzzles; the fixed player separately checks the format-specific result. Sessions older than 24 hours must be restarted. `ready` identifies a mounted integration surface; gameplay still has its own loading state.

## Host-owned assignment points

The same SDK exports `validateScoringPolicy`, `gameObjectiveUnits`, `calculateProvisionalPoints`, `selectScoringAttempt`, `createPublicationBinding` and `scorePublishedGame`. An application can attach an immutable 25-point, 100-point or other policy to its own assignment while reusing the same game. Rules support proportional objectives, full completion or an explicit arcade-point target; whole/hundredth half-up rounding; first/latest/best attempt selection; bounded attempts; and explicit crossword reveal behavior. Calculations are provisional client observations. The host admits attempts and recalculates/stores points under its own authorization, privacy and final-award rules.

See [the complete scoring contract and host workflow](ASSIGNMENT_SCORING.md). Do not add scoring rules or identifiers to the strict version 1 result envelope. It has no attempt ID, and restarting can emit another result on the same channel. Accept one terminal result for a server-admitted attempt, then remount for another attempt. Public snapshot helpers check exact edition/hash but do not fetch current publication or validate a host runtime digest.

## HTTP API

All API endpoints are installation-scoped. Public access needs no token:

| Method and route | Purpose |
| --- | --- |
| `GET /integration` | Branding, revision, approved hosts and fixed route templates |
| `GET /games/published` | Legacy version 1/2 public catalog (`games`, optional `cursor`) |
| `GET /games/published?specVersion=all` | Public catalog including version 3 word games |
| `GET /games/published/{id}` | Current public game snapshot |
| `GET /game-scores/{id}?revision=N` | Edition-specific public top-ten board |
| `GET /health` | Availability check |

`listPublishedGames(apiOrigin)` in the current SDK requests `specVersion=all` on every page and handles public catalog pagination. Only `cursor` and `specVersion=all` are accepted catalog parameters. An empty legacy-filtered page may still have a cursor; continue until no cursor is returned. Direct ID lookup returns any supported saved version, including version 3. Hosts that render data themselves must validate the versioned union before accepting word games; see [word-game schema](WORD_GAMES.md). Existing NCAcademy imports remain version 1/2 until that separate adapter is upgraded. The native public player and current SDK support all formats.

The public board exposes arcade names and points, not account identifiers. Word games reject shared score reads and submissions. Shared arcade score submission requires a normal Game Studio Core session; embedded arcade guests can use local scores when browser storage permits.

Protected authoring/account/agent endpoints accept only access tokens issued to this installation's paired Core clients, checked by live introspection. NCAcademy or Axolotl tokens cannot be forwarded to reuse their audiences. Server integrations must use an explicitly reviewed Game Studio identity contract rather than copying a token from another service. This version ships the top-level creator workflow and public player interfaces; it does not mint arbitrary machine credentials or delegated student tickets.

## Publication lifecycle

A published game is served from the service; it is not a separate deployment per game. Store its game ID in the host lesson/page. Draft edits do not affect it until a tested revision is published. Updating that publication changes the canonical player and resets the board. Unpublishing makes it unavailable to all hosts. A copied game is a new private draft with its own ID and publication lifecycle.
