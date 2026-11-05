# 10th Grade Health: Drugs & Decision-Making

Drugs & Decision-Making is a school-branded shared-screen board game at the existing `/party/quiz-circuit` route. It supports a 10th Grade Health drug education review, with the supplied school logo and its forest green (`#004c1c`), gold (`#ffde08`) and white palette. One host operates the computer while four teams answer aloud. It requires no sign-in, online room, model, subscription or generated content.

The class identity appears throughout setup, question-file import, cards, the board, dice and results. The school logo is the original transparent PNG supplied by the user, served locally without alteration. No school name, mascot, official endorsement or curriculum standard is inferred from the mark. This presentation applies to this board game and its library card; other Game Studio games keep their own identity. Hosts continue to supply the actual questions for their class.

## Prepare and play

1. Add your own multiple-choice questions one at a time, or download a question-file template, fill it out offline and upload it during setup. Review the preview and confirm the import to add the questions to the current bank. Each has two to four choices and exactly one correct answer. Add at least one question before continuing; a larger bank gives the group more variety.
2. Hide the question editor, then let each of the four teams enter a name and choose a meme piece: Mewing Cat, Aura Farmer, Locked In, Cooked Toast, Six Seven, Side Eye, NPC Buffering or Absolute Cinema. The same original artwork appears in the picker, on the board and in the standings and winner screen. Each piece plays by the same rules. Questions and correct answers are absent from the team setup screen. See [artwork and references](MEME_PIECES.md).
3. Use the random team picker to choose the first team. Turns continue in that order, skipping teams already finished.
4. Draw a card from the board's deck. The card flies into view and presents the question and choices. The host selects the answer given by the current team.
5. A correct answer earns one point and unlocks a roll of two six-sided dice. The dice replace the question card, cycle rapidly and slow to their final faces within three seconds. Their combined total moves the team's piece along the board, one space at a time. An incorrect answer earns no points or movement. The host moves to the next team after either outcome.
6. The first team to reach or pass space 28 wins and receives a celebration. Continue playing until all four teams have finished; finish order and question points remain visible separately. An exact roll is not required.

The deck is shuffled and uses every question before reshuffling. A short question bank repeats; the next cycle avoids immediately repeating the previous card when possible. There are no collision penalties or hidden special-space rules. The host's buttons control every change; there is no answer timer.

Use **Full screen** for projection and the collapsible **How to play** guide for a quick refresher. Motion follows the browser's reduced-motion setting.

## Prepare a question file offline

The setup screen offers a [plain-text template](../public/templates/quiz-circuit-questions.txt) and a [JSON template](../public/templates/quiz-circuit-questions.json). The text format is intended for ordinary text editors such as TextEdit or Notepad. Edit the examples and copy a complete question block for each additional question. Save as UTF-8 plain text with the `.txt` extension; Word and rich-text files are not supported.

```text
Q: Someone pressures you to try a drug. Which response sets a clear boundary?
A: Trying it to avoid disagreement
B: Saying no clearly and leaving the situation
C: Accepting it because a friend offered it
D: Letting the group decide for you
ANSWER: B

---

Q: A friend is worried about their substance use. Which response offers support?
A: Making jokes about their concern
B: Sharing their concern with the whole group
C: Listening without judgment and helping them reach a trusted adult
D: Telling them they must handle it alone
ANSWER: C
```

Keep each field on one line, in the order shown. `C:` and `D:` are optional; at least `A:` and `B:` are required. Separate questions with `---` on its own line. Blank lines and lines beginning with `#` are ignored. The correct answer is a letter corresponding to an available choice. Text labels and answer letters can use either case. Do not add comments after a field value.

The JSON alternative has exactly `version` and `questions` fields; version is `1`. Each question has `question`, `choices` and `answer` fields, with an uppercase answer letter `A`–`D`.

```json
{
  "version": 1,
  "questions": [
    {
      "question": "Someone pressures you to try a drug. Which response sets a clear boundary?",
      "choices": [
        "Trying it to avoid disagreement",
        "Saying no clearly and leaving the situation",
        "Accepting it because a friend offered it",
        "Letting the group decide for you"
      ],
      "answer": "B"
    }
  ]
}
```

Files are limited to 256 KiB. The complete bank can hold up to 100 questions, each with a question of up to 300 characters and two to four distinct choices of up to 120 characters each. The entire file must pass validation before any question is added. Import appends to the existing bank and never replaces or partially imports it. The preview can be canceled without changing saved questions. Imported questions can be edited individually before team setup, and manual entry remains available. Save or cancel any unfinished manual question before importing.

File reading, validation and import happen entirely in the browser. File contents and filenames are not sent to a server or model. An import file contains questions and answers only; it cannot replace team setup, progress or game settings. Answer keys are visible in the host's setup preview and hidden when setup continues.

## Storage and boundaries

Question banks and match progress are saved privately in the host browser's local storage. Refreshing can restore a validated match. They are not published to the catalog, sent to AWS or synchronized to another computer. Clearing browser data removes this local save; use the same browser to resume. Storage failure is reported without preventing an in-memory game.

The fixed TypeScript engine validates bounded inert question and team data, phase transitions, one answer and one roll per turn, deck order, movement, score and finish order. UI projections omit the complete question bank and correct-answer indices. The host's local browser still owns the underlying questions; this is a shared-screen party game, not confidential assessment software. Existing published GameSpecs, identity permissions, leaderboards and online party rooms are unchanged.

The visible game uses mature class-review labels and sans-serif headings. The existing `/party/quiz-circuit` and `/party/quiz-circuit/host` routes, original `/party/question-quest` aliases and question-template URLs are retained. Downloaded template names identify the drug education unit, and the sample questions cover refusing peer pressure and supporting a friend. These editable examples are consistent with [NIAAA refusal guidance](https://www.niaaa.nih.gov/alcohols-effects-health/niaaa-middle-school/right-resist) and [CDC guidance on talking to a friend about drugs](https://www.cdc.gov/free-mind/teens/talk-to-a-friend.html), checked November 5, 2026. They are examples for the host to review, not a replacement for the class question bank. Previously prepared files remain valid under the same format. The existing local storage key, version 1 state format and eight internal avatar IDs are retained, preserving saved questions, teams and match progress, including completed single-die turns. The meme artwork replaces the old animal presentation for those same IDs. Branding never rewrites a saved question bank. New turns record both dice and their combined total before the animation starts, so refreshing never rerolls them. Refreshing during an animation restores the committed board position.
