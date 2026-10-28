# Crossword word suggestions

A saved crossword can generate a reusable set of answer-and-clue options from its **title and description**. The creator chooses which options to use, saves the edited puzzle, playtests it and separately publishes it. The same option works for a crossword step inside a Multi-game journey.

1. Edit the crossword title and description, then save.
2. Choose **Generate words & clues**.
3. Review the proposed answers and clues. Select 3–16 words and choose **Use selected words**.
4. Save and playtest the resulting connected grid before publishing.

The existing answers stay in place until the creator explicitly applies a selection. A disconnected selection is rejected with its current puzzle preserved. Changing the saved revision, title, description, seed or other puzzle content makes an earlier proposal inapplicable. Applying suggestions creates an ordinary edited version 3 crossword; it does not change the runtime or published-game schema.

## Cost and variation

Generation occurs only when an authorized creator presses the button. There is no model request when a player opens, reloads or completes a game. Published words are reviewed and reused; **Shuffle puzzle layout** provides a new saved arrangement without AI. This version does not choose an unreviewed random vocabulary subset at player load.

The optional preset uses Amazon Nova Micro (`amazon.nova-micro-v1:0`) through the existing server-side Bedrock Converse integration, with at most 1,200 output tokens per request. The model proposes about 12 pairs. Saved per-game conversation turn/model-call limits also cover these requests; the title and description are bounded to 80 and 300 characters. No automatic provider retry or larger-model fallback is performed.

For scale, the AWS US East (N. Virginia) Price List API checked October 28, 2026 listed standard Nova Micro input at $0.035 per million tokens and output at $0.14 per million tokens. A hypothetical request using 1,000 input and 1,000 output tokens would therefore cost $0.000175 in model usage (about $0.175 per 1,000 such requests), excluding hosting, taxes and other AWS charges. This is an illustrative estimate, not a spending guarantee. Verify current [Bedrock prices](https://aws.amazon.com/bedrock/pricing/) before activation. The [Nova Micro model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html) documents its text/Converse support; generation quality still needs an authorized live smoke test.

## Administrator setup

The crossword assistant is separate from the general conversation designer, so an inexpensive model can handle this task without replacing another configured assistant.

1. In **Agents & workflows**, choose **Add inexpensive crossword preset**. It adds an unsaved model, agent, workflow and mode. Existing definitions, budgets and paid authorization are retained. The new mode starts disabled with no audience.
2. Review the model target, output cap, agent instructions, mode audience and per-conversation limits. Enable the mode and assign the intended creators. Authorize paid model execution only if desired, then save the configuration.
3. In the deployment policy, authorize only the intended Bedrock model ARN. For the in-region preset in `us-east-1`, that is `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0`. Existing platform permissions boundaries must also allow the call. A UI setting cannot expand IAM permissions. Cross-region inference profiles need their own reviewed profile and destination model permissions.
4. Reload the workshop, select **Crossword word assistant** in Game settings, and save. The status shown to creators checks the enabled model/mode, audience and saved paid policy. AWS can still deny a call if deployment permissions, quotas or model availability differ.

Other enabled Bedrock writing modes, including a suitably configured small Claude model, can be selected instead. There is no additional API key in the browser, no new model hosting service and no automatic subscription. The free local preview reports generation as unavailable; it does not pretend a model ran.

## Private operation contract

`POST /games/{id}/crossword-suggestions` requires live `games-create` access, ownership or content administration, and creation enabled. The body is exactly `{revision, requestId, path, title, description}`. `path` is `[]` for a standalone crossword or `[stepId]` for one saved crossword inside a Multi-game journey. The title and description must match that saved target.

The response is `{game, proposal}`, where `proposal` contains exactly `requestId`, `path`, `title`, `description` and validated `entries`. The normal successful reservation/finalization advances the draft revision twice without changing its specification or conversation messages. A fresh playtest is conservatively required. The browser retains editable content while updating this operation metadata.

A durable conditional reservation records the request fingerprint and consumes its model-call budget before provider I/O. Repeating an identical completed request returns the private cached result without invoking the model. An interrupted or uncertain request is never replayed automatically. Editing and saving or duplicating the draft provides an explicit recovery path. Current Core authority and saved configuration are rechecked before releasing a result; concurrent edits prevent a stale result from replacing a newer draft.

Only the selected crossword's title and description are sent as user context. There is no identity, token, conversation history, other game content, tools or generated code in the model request. The fixed parser accepts only bounded JSON answer/clue pairs and validates the complete proposed pool using the existing connected crossword algorithm. Unselected proposals and usage receipts remain private and are excluded from publication and duplication. Existing published snapshots stay unchanged.

The synthetic browser rehearsal at `/tests/browser/crossword-suggestions.html` uses prewritten mocked replies to check the editor and nested builder. It is a development-only entry point and is excluded from production builds. Automated tests make no paid provider requests.
