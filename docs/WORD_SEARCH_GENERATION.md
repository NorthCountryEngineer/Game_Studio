# Word search word suggestions

A saved word search can generate reusable word options from its **title and description**, including a word search step inside a Multi-game journey.

1. Edit the word search title and description, then save.
2. Choose **Generate words**.
3. Review the proposed words, select the ones to use and choose **Use selected words**.
4. Save, playtest and separately acknowledge the resulting puzzle before publishing.

Existing words remain in place until the creator applies a valid selection. Applying suggestions changes only the word list: grid size, layout seed, backward-word settings, instructions, parent journey and sibling steps stay unchanged. The fixed engine accepts 3–16 unique words, with no more words than the grid size. Each word has 2–18 uppercase ASCII letters and must fit that grid. Invalid selections preserve the editable puzzle. An earlier proposal cannot be applied to a changed draft or another step.

## Nova Micro and reusable games

Generation is an explicit creator action. Opening, reloading, playing and completing a saved word search makes **no model call**. Published games reuse the reviewed word list and seeded layout. Shuffling a layout is a separate local authoring action.

The preset uses Amazon Nova Micro (`amazon.nova-micro-v1:0`) through the existing server-side Bedrock Converse integration. Word search generation caps output at 512 tokens, or a lower administrator-configured limit. A model limit of at least 256 tokens is required. The model receives only the selected puzzle's saved title and description plus fixed engine constraints; no account identity, conversation history, other step content, tools or generated code is included.

The parser accepts only a bounded JSON word list, optionally inside one exact JSON Markdown fence. It normalizes ASCII case and ordinary spaces or hyphens between letters, then validates every candidate before fitting the list to the saved grid. Up to 24 candidate words and 240 letters may be returned by the model. The server returns a valid set of 3–16 words that fits the saved grid, using only those candidates. Invalid or unsafe content is rejected, including invalid candidates that would otherwise have been filtered out. There is no additional model call to repair a list, automatic provider retry or larger-model fallback.

## Administrator setup

The word search assistant has its own selector and mode, separate from the crossword assistant and conversation designer.

1. In **Agents & workflows**, choose **Add inexpensive word search preset**. It reuses an existing Nova Micro model without changing that model's settings, or adds a bounded Nova Micro model. The new agent, workflow and mode are unsaved; the mode starts disabled with no audience.
2. Review the agent instructions, model target, output limit, mode audience, conversation budgets and paid-model authorization. Enable the mode for the intended creators and save.
3. Confirm that the deployment already authorizes the exact Nova Micro ARN. The in-region target in `us-east-1` is `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0`. Application settings cannot expand IAM permissions. No new model hosting service or browser API key is required.
4. Reload the workshop, select **Word search word assistant** in Game settings and save. Local preview reports generation unavailable and never pretends to call a model.

## Private API and recovery

`POST /games/{id}/word-search-suggestions` accepts exactly `{revision, requestId, path, title, description}`. A standalone word search uses `path: []`; one word search in a Multi-game journey uses `[stepId]`. The target and metadata must match the saved draft. The response is `{game, proposal}`, with `proposal` containing exactly `{requestId, path, title, description, words}`. Success normally advances the draft revision twice without changing its specification or conversation messages.

Current Core creator permission, ownership/content administration, creation settings, configured mode audience and paid-model authorization apply. A durable conditional reservation consumes the saved model-call budget before provider I/O. Completed identical requests return cached private suggestions. A request identifier cannot cross between crossword and word search operations. Pending or uncertain operations are never automatically replayed; an explicit saved edit or duplicate provides recovery. Authority and saved configuration are rechecked before a result is released, and concurrent edits cannot be overwritten.

Suggestion receipts and unselected options remain private, excluded from published snapshots and duplicates. Applying and saving words produces an ordinary version 3 word search; the player schema and publication review requirements are unchanged. Automated tests and the browser rehearsal use synthetic mocked responses and make no paid provider requests.
