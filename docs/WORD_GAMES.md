# Create and publish a word game

Game Studio supports three word-game formats: **Crossword**, **Word search**, and **Mad Libs**. They use data-only GameSpec version 3 and the fixed isolated player. Existing collection, dodge, and platform games retain their version 1 or 2 definitions.

## Creator workflow

1. Open **Game Studio**, choose **New game**, and select a format. Describe the topic and audience, then choose **Build my first draft**.
2. Read the saved draft and its design reply. Edit the title, instructions, answers and clues, hidden words, or story and prompt labels in the format-specific editor. Conversation supports the explicit field examples below. Choose **Save puzzle changes** after direct edits.
3. For a crossword or word search, keep the layout seed to replay the same puzzle. **Shuffle puzzle layout** changes it explicitly. Save the new layout before testing it.
4. Start the private playtest of the saved revision. Solve the crossword or use **Reveal solution** to review it; find every word in a word search; fill every prompt and reveal the Mad Libs story. A crossword reveal reports a revealed attempt rather than a solved win.
5. Review the content and the resulting player. Acknowledge the playtest for this saved version. Each word game has one review item, `level-1`; the API requires the explicit `reviewedLevelIds: ["level-1"]` acknowledgement. A draft edit clears that review.
6. An account with both `games-create` and `games-publish` can choose **Publish** and confirm the saved, tested edition. Publication is a separate human action. Copy the player link or embed from the published game.

Draft conversations remain private. Editing a published game changes its private draft; the existing public snapshot stays available until a newly tested edition is published. A duplicate starts as a private draft with fresh review and publication state. Unpublishing removes public play while retaining the draft.

## Free guided content and optional models

The free designer makes no model calls. It uses editable curated starters for **nature**, **space**, **animals**, **garden**, and **science**. An unknown topic receives the disclosed nature starter; it does not generate researched content about an arbitrary topic. Review facts, suitability, wording, and clues before publication. Explicit edits preserve the saved content outside the requested fields; a request for a different topic or word-game format can choose a new starter.

An administrator may select the existing configured conversation assistant in Game settings. Follow-up requests use its saved model, audience, limits, and paid-execution authorization. Local preview always uses the free designer. Configured models can propose validated word-game data for these same formats; they cannot add code, remote assets, tools, new mechanics, permissions, or publication. A failed or uncertain paid request is not automatically replayed.

## Supported data and exact limits

Every version 3 definition has exactly `version`, `title`, `description`, `genre`, `instructions`, and `puzzle`. `version` is the integer `3`; `genre` is `crossword`, `word-search`, or `mad-libs`. Titles contain 1–80 characters; descriptions and instructions contain 0–300. Limits count UTF-16 units, matching browser input limits. Text must be trimmed plain text without control characters, HTML, URLs, executable snippets, or invalid Unicode. Extra fields, including arcade options, assets, tenant selectors, and code, are rejected.

| Format | Exact `puzzle` fields | Limits and behavior |
| --- | --- | --- |
| Crossword | `seed`, `entries` | Integer seed 1–2,147,483,647. 3–16 unique entries, each exactly `{answer, clue}`. Answers use 2–18 uppercase ASCII letters; clues contain 1–140 plain-text characters. At most 200 answer letters total. |
| Word search | `seed`, `size`, `allowBackwards`, `words` | Integer seed 1–2,147,483,647. Integer grid size 10–24. `allowBackwards` is boolean. 3–16 unique words of 2–18 uppercase ASCII letters; each word must fit the grid size, and word count must not exceed grid size. |
| Mad Libs | `template`, `blanks` | Plain-text template of 1–2,000 characters. 1–12 unique blanks, each exactly `{id, label}`. IDs are `blank-1` through `blank-12`; labels contain 1–60 plain-text characters. Every listed blank must appear as `{{blank-N}}`; repeated tokens are allowed. Unknown tokens and other braces are rejected. |

Crosswords use a deterministic connected, interlocking 25×25 grid. Letters must agree at crossings; parallel overlap and unintended adjacency are rejected. Search examines at most 2,000 placement nodes, up to 48 candidates per choice, and 2,000,000 counted work steps. A vocabulary that cannot be completely placed within these limits is rejected with an editing message. No answer is silently dropped. Change the words or seed and try again.

Word-search placement uses a deterministic seeded generator with at most 240 placement attempts per word. If the candidate layout cannot fit the complete vocabulary, it resets and puts one word horizontally on each separate row, then adds repeatable filler. The word-count limit guarantees this fallback. Backwards controls which directions may be generated; players may select a found word using either endpoint first.

Mad Libs asks for all prompts before showing the completed story. Each player answer contains 1–80 plain-text characters after trimming. Repeated occurrences of a token use the same answer. Answers and rendered stories remain in that isolated player session; they are not persisted or sent to the service or embedding host. Restarting clears them.

## Conversation examples

Put each field name at the start of its own line. Separate crossword entries and prompt declarations with semicolons or newlines. Keep a Mad Libs template on one line; its saved text contains no newline controls.

```text
Create a crossword about nature.
Title: Water Words
Entries: WATER | A liquid that plants need; RIVER | Water flowing toward a lake or sea; RAIN | Water falling from clouds
Seed: 17031
```

```text
Create a word search about space.
Title: Space Explorer
Words: PLANET, STAR, ORBIT, MOON, COMET
Size: 12
Backwards: off
Seed: 17031
```

```text
Create a Mad Libs story about animals.
Title: Pond Surprise
Template: A {{blank-1}} axolotl found a {{blank-2}} and began to {{blank-3}} beside a {{blank-1}} turtle.
Blanks: blank-1 | Adjective; blank-2 | Noun; blank-3 | Verb
```

## Playing, sharing, and integration boundaries

The crossword supports numbered clues, letter entry, arrow keys, checking, and solution reveal. Word search supports pointer dragging, tapping endpoints, or arrows and Enter; Escape clears the selected start. Mad Libs supports keyboard form entry and story reveal. All formats offer restart and fit inside the same sandbox and approved host-origin boundary as existing games.

Public definitions include crossword answers, word lists, and story templates. Publication therefore requires human editorial review; these games do not provide confidential exam questions or authoritative assessment. Completion is a client-reported observation: the existing message envelope carries outcome, elapsed seconds, completion count in `score`, and `reviewedLevelIds: ["level-1"]`. Crossword counts solved answers, word search counts found words, and Mad Libs counts completed prompts. Entered letters, player answers, story text, identities, and tokens are excluded. Word games have no arcade points or local/shared high-score boards.

The public catalog preserves existing consumers: `GET /games/published` returns only version 1 and 2 action games. Modern native clients and the current SDK explicitly request `GET /games/published?specVersion=all` to include all three supported versions. Public catalog parameters are only optional `cursor` and optional `specVersion=all`; filtered pages may be empty while still returning a pagination cursor. Direct lookup by a published game ID returns that edition's versioned snapshot, including version 3.

NCAcademy's existing pinned import remains a legacy version 1/2 consumer. This source change does not upgrade its importer, attach games to lessons, change school accounts, or establish Academy acceptance for word games. A host adopting version 3 must validate the new union and separately approve its content and integration workflow.

This document describes local source behavior and offline validation. It does not establish deployment, live Core authentication, or authenticated production acceptance.
