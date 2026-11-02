# Mafia: live social deduction

Mafia is a separate live-game category. Open **Mafia** from Games or the workshop to host a private room or join an invitation. It uses a server-owned room and private per-player views rather than the arcade iframe, saved level editor or two-player cooperative relay. Existing published games and authored levels remain independent.

## Start a group

1. Enter a display name and pick a built-in animal, fantasy or space avatar. Names allow one to sixteen Unicode characters and are displayed as literal text.
2. Choose human or AI narration and the playing-seat limit. A human narrator is an additional, nonplaying seat. A round needs at least five playing seats and supports up to twenty-four; the physical room therefore supports at most twenty-five people.
3. Share the private invitation with your group. Each person enters their own name and avatar. No Core account is needed to host or join a room.
4. The person who opened the room is its creator and initially its human narrator. Before starting, the creator can reassign narration to another joined person. The previous narrator then becomes a playing seat. The creator retains lobby and room-closing controls.
5. Start when everyone is present. The server shuffles the roles. Each player sees only their own role and allowed private information. The human narrator sees the roles and secret choices needed to run the game.

Invite links grant admission to that room, so share them only with the intended group. Player capabilities are separate from the shared invitation. Refreshing the same browser reuses that browser's saved seat; it does not create another player. Joining after a round starts is blocked. Different players should use separate browser profiles, private windows or devices.

The creator can remove seats in the lobby and close a room. A finished round offers a rematch in the same room. A rematch clears roles, investigation results, ballots, chat and prior-round narration before returning the present group to the lobby. Narration and room settings can then be reviewed again. Leaving marks a playing seat out; refreshing or a brief network interruption alone does not eliminate anyone. The creator and human narrator must close their room rather than leave it without controls.

## MVP rules

The server assigns one Mafia member per four playing seats, rounded down, with at least one. There is one detective and one doctor; everyone else is a civilian. A human narrator receives no playing role. In AI mode everyone, including the creator, receives a playing role.

| Phase | What happens |
| --- | --- |
| Night | Each living Mafia member chooses a town target. The doctor protects any living player, including themselves. The detective investigates one other living player. |
| Discussion | The town receives the public night result and discusses its suspicions through text chat. Living players can mark themselves ready for voting. |
| Voting | Each living player clicks a suspect or skips. A unique highest vote total eliminates that suspect; a tie or winning skip eliminates nobody. |

Night actions resolve together. A unique highest Mafia target is attacked; split Mafia choices produce no attack. A matching doctor protection prevents the elimination. Public narration never names a protected target or reveals whether protection, a split choice or an absent choice caused a quiet night. The detective privately receives **Mafia** or **not Mafia**, including an investigation completed on the detective's final night. The most recent one hundred investigations remain available in a long round. The doctor may protect the same person on successive nights. Eliminated players watch but cannot vote, make secret choices or send chat. Eliminated roles stay hidden from ordinary players until the round ends.

Mafia allies can see one another and use private Mafia chat at night. Ordinary players cannot read that channel or someone else's investigations. The human narrator can inspect private choices and Mafia chat as part of their narrator role. During the day everyone still alive, including Mafia members, may discuss and vote. Player messages and narrator announcements are plain text, at most 240 characters, with a shared twelve-message-per-minute allowance per seat. Public and private histories are bounded.

The town wins when no Mafia members remain. Mafia wins when its living members equal or outnumber the living town. The server determines the outcome and reveals the final roles. These are team-game outcomes, separate from the arcade points engine and host assignment scoring.

## Narrator modes

A human narrator writes announcements and advances the phases. They may open voting after discussion. Night and voting resolve after all required choices arrive, or after the timer expires using the explicit timeout override. Missing choices count as no action or no ballot; the narrator cannot submit a secret choice on someone else's behalf.

AI narration combines automatic phase management with a reviewed bank of short text written by Nova Micro. An authorized administrator generates and reviews that bank before enabling it. Anonymous room creation and gameplay never invoke a model. No player name, message, role, investigation or vote is sent to the model. The generated text supplies atmosphere; fixed server text supplies the actual results. It cannot choose roles, alter votes or change the winner.

In AI mode, nights and votes resolve once all required choices arrive or their timers expire. Discussion moves to voting when all living players are ready or the timer expires. A request reconciles at most one elapsed phase, giving the group a fresh timer for the next phase instead of racing through phases after an absence. Defaults are 75 seconds at night, 90 seconds for discussion and 45 seconds for voting; each can be set between 30 and 300 seconds before play.

## Storage, synchronization and privacy

The main Game Studio API owns Mafia rooms in the existing installation-scoped game table. The two-player cooperative relay, its protocol and its deployment are untouched. Room capabilities are stored as hashes, never projected into another player's view. Every action is bound to a seat capability, current phase and monotonic per-seat sequence. Repeating the most recent committed request returns its current view without repeating the action; an older sequence, a reused sequence with different contents or a stale phase fails explicitly. Concurrent writes use transaction fences over the exact previous room record.

Room admission has a fixed installation index and bounded source/global limits. Inactive rooms expire; authenticated room activity renews an active lease. Expired room rows are removed through bounded admission cleanup. Public catalog scans exclude room, admission and narration data, including continuation pages. The service does not add a public room directory, accounts, uploads, voice/video recording or model calls while people play.

The browser stores only that browser's room session and invitation where needed. The API projects each view field by field: public seats, public events and allowed chat; the caller's own role, ballot and investigation; private Mafia information only for its authorized audience; all roles and current night choices only for a human narrator. Public completed-round role reveals are intentional. No raw stored room state is sent to a player.

## Validation and release

Synthetic engine tests cover role counts, server shuffling, narrator transfer, privacy projections, doctor protection, simultaneous investigations, Mafia splits, vote ties and skips, victory, deadlines, chat limits, departure, close and rematch clearing. API journey tests play complete five-player rounds with human and AI narration through the actual dispatcher and in-memory transactions. They verify private results, reconnect, one committed action on replay, stale-action rejection after a timeout and access denial for unknown capabilities.

These tests make no network, AWS, Core or provider calls. Production readiness also requires exact deployed API/frontend verification, public category and private-room browser acceptance, a current data-preservation comparison, and explicit cleanup of only the temporary QA rooms. A local test pass alone is not a production release receipt.
