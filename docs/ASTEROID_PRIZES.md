# Periodic Asteroids prizes

In an Asteroids game with shooting enabled, turn on **Drop prizes during the game** under **Periodic prizes** in the game details. Select the prizes, how often they appear and how long temporary effects last. Save, complete the saved level playtests and publish the reviewed edition. Published players collect the falling, labeled pickups by flying into them.

| Prize | Effect |
| --- | --- |
| Triple shot | Each firing volley launches three rounds, with a center shot and two angled shots. |
| Rapid fire | Holding the shoot control fires a denser stream, with a 0.08-second firing interval instead of the normal 0.22 seconds. |
| Shield | Absorbs one additional damaging collision. The shield remains until used or the level is reset. It does not add a life or stack extra charges. |
| Speed boost | Movement is 1.6 times the normal ship speed while active. |

The default is a pickup every 12 seconds with all four prize types enabled and ten-second temporary effects. Creators can choose a 5–60-second spawn interval and 3–30-second effect duration. At least one prize must remain selected while prizes are enabled. Triple shot, rapid fire and speed boost can combine. Collecting a duplicate refreshes its timer; it does not multiply or extend an effect beyond the configured duration. Collecting another shield restores its one available hit. Pickup expiry is twelve seconds; missed pickups disappear. The HUD identifies active effects, remaining time and the shield charge.

The normal shoot control continues to fire while held. The rapid-fire prize makes that stream faster. A shield is consumed only when a collision would otherwise remove a life; normal hit protection still applies. Collecting a prize does not itself award collection progress, arcade points or assignment credit. Existing collection goals and asteroid point values remain unchanged.

Prizes work in solo and optional two-player cooperative games. In cooperative play, only the player collecting a pickup receives its effect. The shared world spawns each pickup once, projectiles retain their owner, and friendly fire remains disabled. Pause freezes the timers. New levels and restarts clear pickups, timed effects and shields. A player who has run out of lives cannot collect a prize to revive themselves.

## Compatibility and authoring

Prize-enabled games use GameSpec version 5, retaining the saved level plan, progression and seeds. They require the fixed dodge/Asteroids engine with shooting enabled. The data adds:

```json
{
  "powerUps": {
    "spawnInterval": 12,
    "duration": 10,
    "types": ["triple-shot", "rapid-fire", "shield", "speed-boost"]
  }
}
```

Version 5 can optionally include the existing two-player cooperative configuration. Turning cooperation off keeps the prizes and saved level plan. Turning prizes off returns to the ordinary solo or cooperative arcade format. Turning shooting off or switching away from the supported game style removes prizes; prize controls are available only while shooting is enabled. These changes require a fresh saved playtest and publication. Existing versions 1–4 are not rewritten or automatically given pickups. Unrelated text edits, layout planning and model proposals must preserve the creator's saved prize/cooperation choices.

Version 5 solo games keep the normal solo completion report, bounded high scores and host-owned provisional point calculations. The full saved campaign supplies the scoring denominator. Cooperative editions remain outside the single-player scoreboard, completion and assignment-credit contracts. NCAcademy's current pinned importer continues to receive only its supported versions 1–2; it does not silently import a newer runtime format.

## Runtime and verification

The fixed network-disabled sandbox implements these mechanics. Game data cannot provide scripts, URLs, textures, arbitrary effect values or new abilities. Pickup types, timing, state fields, coordinates, timers and shield charges are strictly validated in the browser and API. Cooperative snapshots include only bounded gameplay state and stay within the existing relay message limit. Version 5 limits the world to 64 weighted entities, 32 projectiles per ship (64 total in cooperative games) and three pickups. Older runtime formats retain their existing behavior and limits.

Run the normal type checks, JavaScript/API/deployment tests and preview build. Prize tests cover deterministic spawning, missing-pickup expiry, per-player collection, triple trajectories, held rapid fire, one-hit shielding, speed/timer expiry, refresh rather than stacking, restart/level reset, pause, malformed snapshots and worst-case relay sizes. Schema tests compare browser/API definitions and refinements. Scoring tests verify whole-campaign 25/100-point scales for solo prizes and reject cooperative scoring. `npm run test:multiplayer-preview` checks two actual WebSocket clients against the production relay logic using synthetic storage. `npm run dev:multiplayer` supplies a synthetic prize-enabled game for visual inspection in separate browser sessions.

Release both the additive relay Lambda and the normal Core-managed application frontend/API from the reviewed source. No new infrastructure, Core permissions, credentials, domains or provider calls are needed. Preserve existing games/media and verify source archives, publication assets and authentication boundaries after release. See [multiplayer deployment](MULTIPLAYER.md) for the existing relay release command and lifecycle.
