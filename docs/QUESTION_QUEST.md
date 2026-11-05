# Quiz Circuit

Quiz Circuit is an original shared-screen board game at `/party/quiz-circuit`. One host operates the computer while four teams answer aloud. It requires no sign-in, online room, model, subscription or generated content.

## Prepare and play

1. Add your own multiple-choice questions one at a time. Each has two to four choices and exactly one correct answer. Add at least one question before continuing; a larger bank gives the group more variety.
2. Hide the question editor, then let each of the four teams enter a name and choose an icon. Questions and correct answers are absent from the team setup screen.
3. Use the random team picker to choose the first team. Turns continue in that order, skipping teams already finished.
4. Draw a card from the board's deck. The card flies into view and presents the question and choices. The host selects the answer given by the current team.
5. A correct answer earns one point and unlocks one six-sided dice roll. The team advances that many spaces. An incorrect answer earns no points or movement. The host moves to the next team after either outcome.
6. The first team to reach or pass space 28 wins and receives a celebration. Continue playing until all four teams have finished; finish order and question points remain visible separately. An exact roll is not required.

The deck is shuffled and uses every question before reshuffling. A short question bank repeats; the next cycle avoids immediately repeating the previous card when possible. There are no collision penalties or hidden special-space rules. The host's buttons control every change; there is no answer timer.

Use **Full screen** for projection and the collapsible **How to play** guide for a quick refresher. Motion follows the browser's reduced-motion setting.

## Storage and boundaries

Question banks and match progress are saved privately in the host browser's local storage. Refreshing can restore a validated match. They are not published to the catalog, sent to AWS or synchronized to another computer. Clearing browser data removes this local save; use the same browser to resume. Storage failure is reported without preventing an in-memory game.

The fixed TypeScript engine validates bounded inert question and team data, phase transitions, one answer and one roll per turn, deck order, movement, score and finish order. UI projections omit the complete question bank and correct-answer indices. The host's local browser still owns the underlying questions; this is a shared-screen party game, not confidential assessment software. Existing published GameSpecs, identity permissions, leaderboards and online party rooms are unchanged.

The visible game uses neutral labels and sans-serif headings. The original `/party/question-quest` and `/party/question-quest/host` links remain aliases. The existing local storage key and version 1 state format are retained, preserving previously saved questions, teams and match progress.
