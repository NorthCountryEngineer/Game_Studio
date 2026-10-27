# Asteroids survival and enemy ships

Open an Asteroids draft with **Shoot asteroids** enabled. Under **Survival and enemy ships**, choose endless survival, the asteroid size stages, and optional enemy ships. Changing a control creates a private draft change. Save, playtest the saved version, acknowledge the review, and publish to update what players see. Opening these controls does not change an existing game.

## Endless survival

**Endless survival** replaces the timer and collection goal with a continuous survival run. The challenge increases after the configured interval of active play; pause does not advance that interval. Choose **Increase difficulty every** from 10 through 120 seconds. The initial setting is 30 seconds.

The first saved level supplies the starting world, difficulty, lives, and layout. The complete authored level plan, progression, goals, timers and saved seeds remain stored. Goal and time controls are disabled and labeled as unused during endless play. Other levels stay visible as the retained campaign. Turning endless survival off restores the level-by-level adventure with those saved settings; it does not generate a replacement plan or delete levels.

Endless runs have no collection-based win. Players keep surviving until their lives run out, or deliberately restart. Points still reflect the enabled arcade scoring choices.

The elapsed-time ramp applies only to endless survival. Timed campaigns keep each level's authored difficulty when you enable enemy ships or three asteroid sizes.

## Asteroid stages

With **Split large asteroids into smaller pieces** enabled, choose:

| Setting | Stages |
| --- | --- |
| Two sizes | Large → small. This retains the existing splitting behavior. |
| Three sizes | Large → medium → small. Each stage takes one shot before splitting or being destroyed. |

If splitting is disabled, the stage selector is disabled and each rock is destroyed directly. Its saved size choice remains available when splitting is enabled again.

With scoring enabled, a hit on a large rock earns 20 points, a medium rock 30, and a small rock 50. A three-stage large rock can therefore yield 280 points when it and all its descendants are cleared. Each collectible earns 10 points.

## Enemy ships

Turn on **Add enemy ships**, then configure their behavior independently of asteroid stages:

| Behavior | Movement |
| --- | --- |
| Easy | Wanders through the field. |
| Medium | Gently tracks the player’s ship. |
| Hard | Pursues, aims and fires. |

Choose 1–10 shots to defeat an enemy, a 5–60-second spawn interval, and at most 1–6 enemy ships at once. The initial settings are easy behavior, one hit point, a 15-second interval, and two ships. Enemy ships work with finite campaigns as well as endless survival.

Defeating an enemy awards 100 points on easy behavior, 200 on medium, or 300 on hard when arcade scoring is enabled. Merely damaging an enemy does not award that defeat bonus.

## Prizes and impact

In endless survival, collected triple shot, rapid fire and speed boost effects remain active until a damaging impact. Effects can be combined. Any damaging hit clears every active boost. A shield absorbs one such hit, is consumed, and clears the other boosts too. The saved temporary-effect duration is hidden because endless play ignores it; that timing is restored when endless survival is turned off.

Finite games retain their existing timed prizes and one-hit shield behavior. In a cooperative game, effects belong to the ship that collects the pickup. See [periodic prizes](ASTEROID_PRIZES.md) for the available effects and [multiplayer](MULTIPLAYER.md) for shared play.

Solo endless play has no gameplay timer. Two-player games keep the existing 30-minute live-room expiry and connection rules; choosing endless survival does not extend a room's credentials or lifetime.

## Private review and publication

The endless playtest starts the continuous run from its first saved level. Play for at least five seconds of active time, then choose **Finish playtest** inside the isolated player. Review the behavior and choose **Acknowledge endless playtest** in the workshop. A real loss can also complete a round for review.

**Finish playtest** emits a private review with elapsed time and the reviewed starting-level ID. It does not invent a loss, award points, submit a high score, or emit a public completion event. The remaining saved campaign levels do not need separate endless playtests because they are not entered during that run. Finite campaigns still require every level to be reviewed. Changes to saved rules invalidate the previous acknowledgement; publication continues to require a separate human action.

## Host completion and assignment points

Version 6 uses an explicit version 2 public completion envelope with `specVersion: 6` and `mode: endless` or `mode: levels`. Endless terminal results represent a real loss and identify only the starting level. Existing game formats retain the version 1 completion envelope. Older host adapters can still display the public embed, but ignore the new advisory completion version until explicitly upgraded. Private playtest review never enters either public envelope.

For host-owned provisional educational points, an endless game requires an explicit `arcade_target` policy. A finite collection/completion denominator does not describe an endless run, so proportional-objective and full-completion policies are unavailable for it. Cooperative editions remain excluded from these solo scoring and completion contracts. The host still owns trusted attempt admission and final awards. NCAcademy’s reviewed assignment importer continues to accept only its supported game versions 1–2; this change does not silently upgrade that importer or alter Academy lessons. See [assignment scoring](ASSIGNMENT_SCORING.md) and [integration](INTEGRATION.md).

## Compatibility and local validation

These explicit settings use GameSpec version 6 with a required saved level plan and progression, an `asteroids` configuration, and optional existing prizes/cooperation. Enabling or disabling prizes or cooperation preserves the advanced settings and authored levels. Switching to an incompatible genre or disabling shooting removes incompatible Asteroids settings. Existing versions 1–5 retain their saved behavior until deliberately edited; no existing game or high-score record is migrated or republished by this source change.

Run the focused authoring checks and the complete application checks with Node 20.18 or newer:

```sh
node --import tsx --test tests/asteroid-challenge-authoring.test.ts tests/game-prize-authoring.test.ts
npm run typecheck
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run build:preview
```

In local preview, open an existing multi-level Asteroids draft and note its authored titles, goals, times and layout seeds. Enable endless survival, three stages, hard enemies and prizes. Save and use **Finish playtest** after five active seconds, acknowledge, and publish the local snapshot. Check that the review covers only the starting level and does not enter a score. Disable prizes and verify the advanced settings remain. Turn endless survival off and verify the complete original level plan and timers return. Separately test finite timed prizes, different enemy hit points, and solo/cooperative impact behavior.

This document describes source and local validation. It does not establish a production deployment or live acceptance. Release the reviewed API, supported relay runtime and frontend together through the existing deployment process; preserve saved games, published editions and score boards during release.
