# Assignment points owned by a host application

Pixel platformers report 10 gameplay points per collectible and support these assignment policies. Custom level flows also report material completion and separate active/total timing. Use `scorePublishedFlow` for a flow and independently verify its required client activities before accepting credit. Game Studio supplies the adapter contract; it does not create class leaderboards or write NCAcademy records. See [level flow integration](LEVEL_FLOWS.md).

An application can use the same published game for a 25-point assignment, a 100-point assignment, or another approved scale. The assignment owns its scoring rules. Changing those rules does not edit the reusable game, its publication or its casual arcade board.

Game Studio's SDK provides deterministic calculations for the owning application. It does not store student identities, enforce enrollment or write an application's gradebook. The host admits and stores attempts under its own current permissions and, where applicable, student-data encryption. Browser gameplay is an observation: these calculations are provisional until the host's authorized review or award process accepts them.

## Repeatable policy

```js
import {
  validateScoringPolicy,
  calculateProvisionalPoints,
  selectScoringAttempt,
  createPublicationBinding,
  scorePublishedGame
} from 'https://YOUR_STUDIO_ORIGIN/sdk/game-studio.js';

const policy = validateScoringPolicy({
  version: 1,
  max_points: 25,
  method: 'proportional',
  rounding: 'hundredth',
  attempt_policy: 'best',
  max_attempts: 3,
  reveal_policy: 'zero'
});
```

Store an immutable approved revision of this policy with the assignment. A 100-point variant changes `max_points` to `100`; a different assignment can reuse the same game without affecting existing assignments or attempts. Any new policy revision applies through the host's explicit review/version process, preserving the rule used for every historical calculation.

| Field | Accepted values |
| --- | --- |
| `version` | `1` |
| `max_points` | Whole number 1–10,000 |
| `method` | `proportional`, `completion`, `arcade_target` |
| `arcade_target` | Required only for `arcade_target`; whole number 1–1,000,000 |
| `rounding` | `whole` or `hundredth`; half-up rounding |
| `attempt_policy` | `first`, `latest`, `best` |
| `max_attempts` | Whole number 1–100 |
| `reveal_policy` | `zero` or `earned`; omitted normalizes to `zero` |

Unknown fields, invalid combinations, non-numeric values and unsupported policy versions are rejected. `arcade_target` is rejected on another method rather than silently ignored.

## What earns points

`proportional` uses `observed objective units / total game objective units × max_points`. The denominator always comes from the complete validated definition, including all arcade levels. It never comes from a browser-supplied maximum or only the levels reached before a loss. For example, 5 collected objectives in a 30-objective game earn 4.17 of 25 or 16.67 of 100.

| Format | Objective units |
| --- | --- |
| Arcade | Collected objectives; denominator sums every saved level's goal |
| Crossword | Solved entries; denominator is every answer |
| Word search | Found words; denominator is the complete word list |
| Mad Libs | Filled prompts; denominator is the declared prompt count |

Mad Libs measures participation. It does not assess grammar, factual accuracy or the quality of a student's words. No entered words, crossword letters or completed stories need to leave the player. Word searches and Mad Libs currently emit terminal results only after completing their activity; there is no partial-credit result on closing an unfinished player.

A crossword solution reveal reports `lost` with the count solved before revealing. Its default policy awards zero. Choosing `reveal_policy: 'earned'` allows proportional credit for that pre-reveal count. It cannot turn a reveal into a win. All other formats ignore this reveal setting because they have no corresponding solution-reveal result.

`completion` awards the maximum only for a terminal full-game `won` result; `lost` awards zero. Intermediate arcade `level-complete` messages cannot be scored as completed attempts.

`arcade_target` uses `min(observed arcade points, arcade_target) / arcade_target × max_points`. It requires a game with arcade scoring enabled. Choose an explicit meaningful target for the assignment. The engine's internal maximum-point bound is a conservative validation limit, not an achievable target or a suitable grading denominator. Arcade scoreboards and assignment scales remain independent.

Whole points round 2.5 to 3. Hundredths round 16.666… to 16.67. The calculation uses integer half-up arithmetic before converting the final amount to points, so the same rule is reproducible in other languages. There is no hidden time bonus or penalty.

## Bind an attempt to an exact publication

The SDK has a pure calculator for an already validated, pinned definition:

```js
const provisional = calculateProvisionalPoints(pinnedSpec, observedResult, policy);
// { earned_points, max_points, numerator, denominator, method, provisional: true }
```

For a public Game Studio snapshot, the asynchronous helper verifies its ID, edition and definition hash:

```js
// At assignment preparation, from the exact reviewed public snapshot:
const binding = await createPublicationBinding(reviewedPublishedSnapshot);
// Store { game_id, published_revision, spec_sha256 } with the approved policy.

// After the host has independently admitted the student's attempt:
const provisional = await scorePublishedGame(
  admittedPublishedSnapshot, binding, observedResult, policy
);
```

The binding hashes the validated definition using UTF-8 SHA-256 over sorted-key compact JSON with literal Unicode. Every supported numeric definition field is an integer. This matches the Game Studio and Academy canonical definition hashes; tests compare all supported formats, including Unicode text, directly with Python. Invalid lone Unicode surrogates are rejected instead of silently replacing bytes. Public snapshot helpers reject private fields, drafts and mismatched revision/publication values. A changed title, content, edition or game ID fails the binding check. Inputs are frozen by validation before asynchronous hashing yields.

This checks the provided snapshot. It does not itself fetch current publication status, prove who played or check the host's pinned runtime contract. The host must perform those checks. The canonical remote embed follows the latest published edition; the host must reject an event from a different admitted edition and retrieve/review a replacement explicitly. A pinned local host player must retain its validated snapshot, runtime digest and current approval checks.

## Admit, retain and select attempts

Keep the authoritative workflow in the owning application's backend:

1. Check the current student's enrollment/assignment access and the current human-approved policy, game snapshot and runtime. Allocate an opaque attempt ID and a monotonically increasing server ordinal within that assignment/policy revision. Enforce the maximum before starting play.
2. Keep the student ID, assignment ID, attempt authority, session and private records inside the host. The public game iframe needs none of them.
3. Accept at most one terminal result for that admitted attempt. Verify the exact player origin, frame window, channel, game ID and published edition; validate the result against the complete admitted definition. Recalculate points on the host server using the frozen policy rather than trusting browser-calculated awards.
4. Store the unchanged observation, edition/hash/runtime binding, policy revision, ordinal, calculated provisional points and receipt in the host's protected audit records. An identical retry returns the same receipt; changing the result for an already completed attempt must be rejected.
5. Select eligible completed attempts using server ordinals and retain explicit authorized review/award decisions separately. Re-check current authority on finalization and audit any staff override with a reason.

```js
const selected = selectScoringAttempt(
  [{ ordinal: 3, earned_points: 20 }, { ordinal: 1, earned_points: 15 },
   { ordinal: 2, earned_points: 20 }],
  policy
);
// best -> ordinal 2; a tie keeps the earlier server ordinal.
```

`first` selects the lowest eligible completed ordinal; `latest` selects the highest; `best` selects the largest point amount, choosing the lowest ordinal on ties. Input order and browser timestamps do not change the selection. Duplicate ordinals, out-of-range attempts, excessive history, points outside the approved scale and wrong rounding precision are rejected. Empty history returns `undefined`. This utility does not allocate ordinals or establish that supplied history is genuine.

The version 1 completion envelope stays unchanged. It has no student ID, assignment ID, attempt ID, grade or policy. A restarted player can report another terminal result on the same channel. After the first accepted result, the host must stop accepting additional results for that attempt and destroy/remount the player for a new server-admitted attempt. The SDK does not enforce attempt limits inside a player's practice controls.

## Validation and integration scope

Run `node --import tsx --test tests/game-scoring.test.ts tests/integration.test.ts tests/integration-boundary.test.ts`, `npm run typecheck` and `npm run build:sdk` with the project's supported Node version. The scoring tests cover strict rules, 25/100 scales, whole-game partial completion, half-up rounding, explicit arcade targets, crossword reveals, Mad Libs participation, invalid observations, deterministic selection, stale snapshots, Unicode/hash parity and asynchronous input mutation. Tests use synthetic definitions and no model or cloud calls.

The SDK supports every native Game Studio format. Each owning application must explicitly consume the scoring contract, persist attempts and expose its own assignment controls. NCAcademy's currently pinned import/runtime compatibility is a separate host release; adding scoring helpers here does not by itself upgrade that adapter's supported formats or create student grade records.

Cooperative-enabled version 4 editions are excluded from this single-player scoring policy, including solo sessions of those editions. Per-player cooperative observations need an explicit future admission/result contract; combined team points must never silently become one student’s assignment credit. Versions 1–3 retain their existing behavior.
