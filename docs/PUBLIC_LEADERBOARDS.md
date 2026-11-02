# Public leaderboards

Every published game has a top-ten board on its player page and embedded player. Viewing the board and submitting a qualifying run require no account or Core token. Creation, editing, publication, private drafts and account administration retain their existing Core authorization.

The fixed game's rules select the ranking:

| Game | Ranking |
| --- | --- |
| Games with point scoring, including pixel platformers | Highest points |
| Multi-game journeys | Highest frozen main-journey points |
| Crosswords, word searches, Mad Libs and finite games without points | Fastest successful completion |
| Endless games without points | Longest survival |

A terminal point-scoring run can qualify after a win or loss, including a zero-point run while the board has space. Time boards require a successful full completion. Revealing a crossword or losing quickly cannot produce a best completion time. Active game time excludes arcade pauses and client-material time. Each game and published edition has its own board. A later tied result cannot displace the existing tenth entry.

The page refreshes the board after a round and offers a name only when the result qualifies. A new public nickname allows one to eight Unicode code points after NFC normalization and outer-whitespace trimming. Case, punctuation and emoji are preserved and displayed as text. Control characters, direction-changing controls and invisible-only names are rejected; there is no profanity filter. Names are unowned: two runs can use the same nickname without overwriting each other.

The service rechecks qualification during submission. If another run takes the last place first, the player sees that their result no longer qualifies. Request UUIDs stay fixed for each run, including uncertain retries and nickname edits, so a lost response cannot accidentally create another entry. Reusing a committed request for a different name or result fails explicitly.

## All game formats

Single games use their validated terminal `GameResult`. Leveled games require the authored level order and prior completed goals. Platformer points must equal collected rewards times ten. Cooperative pages independently observe each local player's validated snapshots, accumulate a contiguous campaign, and emit one final per-player result. Missing earlier levels, repeated final snapshots and private previews do not manufacture public completions. This does not change the cooperative relay protocol or turn cooperative results into solo SDK assessment events.

Multi-game boards validate the full finite prefix, child results, required material observations, child flows and aggregated totals. They use the existing journey point total, including its fixed completion-count conversion for children without native points. A perpetual ending starts after the result is frozen and cannot add leaderboard points or time. Standalone required client objects remain gated.

These are casual, client-reported game results. Their bounded validation is separate from identity, host attempt admission, assessment and awards. Puzzle answers, story text, Core identities and tokens never enter leaderboard reports.

## Storage and preservation

The existing published-game table stores at most ten entries and one hundred recent private request receipts per game's current edition. Public projections contain only names, points where applicable, elapsed time when known, and dates. Original sixteen-character names and point entries without historical elapsed time remain readable; names are not truncated and missing times are not invented. Existing owner hashes stay private. Old records are not eagerly rewritten or migrated.

Anonymous admission uses one fixed, bounded installation-wide rate record in the same table: 120 new submissions per source per minute, 600 per installation per minute and at most 128 hashed source buckets. Only API Gateway's request source is used; raw IP addresses are not retained. The minute's counters replace the same record rather than creating records per visitor or request. Matching retained retries do not consume another admission. This rate record is excluded from the public catalog, including filtered-page cursor handling.

New admissions atomically check the exact publication payload, revision, organization and service, compare-and-swap the board, and update the admission record. Publication changes, tenant mismatches and concurrent writes cannot silently overwrite a board. Removed or superseded publications do not expose their boards. No new table, IAM grant, model provider or runtime infrastructure is needed.

Offline preview uses version-two browser storage. It can display and copy the relevant validated version-one board when first saving, while preserving the original version-one bytes, receipts and unrelated records. The connected site always uses its public shared board; an error never silently saves an anonymous run only to that browser.

## Verification and release

Tests cover anonymous HTTP routing, every format and ranking direction, Unicode parity, qualification races and ties, request replay, bounded admission, exact publication fencing, old-score preservation, composed material gates, cooperative totals and browser response races. TypeScript and Python execute the actual validators against synthetic shared cases. Private playtest records, SDK events and authoring permissions remain independent.

Source and offline verification do not establish a live release. Deployment must follow the repository's explicit release authorization boundary, preserve existing records, compare exact deployed main API/frontend bytes, and verify anonymous public reads and a disposable qualifying run without altering existing boards. The multiplayer relay does not need deployment for this feature.
