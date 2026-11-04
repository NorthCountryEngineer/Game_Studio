# Mafia narration

Mafia has human narration, fixed automatic narration and an optional AI story narrator. The server owns role assignment, secret actions, votes, timers, eliminations and winners in every mode. The human narrator is selected before the round and does not receive a playing role. Automatic and AI story modes let everyone play and advance phases when their actions are complete or the phase timer expires.

The fixed automatic mode needs no generated text or provider calls. Filling a lobby with built-in AI players selects this mode so a solo host can participate. AI opponents are separate from the optional generated story vocabulary described below; its administrator enablement and generation controls are unchanged.

The AI narrator combines a reusable, AI-written atmosphere vocabulary with exact facts from the server. It does not reason about players, read discussion, select targets or decide who wins. Its eight lines cover night, discussion, voting, an elimination, a quiet morning, a tied vote and each team's victory. A quiet morning does not reveal whether a Doctor acted, Mafia votes were split or an action was missed. Canonical facts follow the atmosphere line.

## Cost and privacy boundary

An account with the existing `agents-manage` permission can generate one installation-wide vocabulary using the exact, already allowlisted `amazon.nova-micro-v1:0` model. The saved agent configuration must enable paid execution and that enabled generative model with an output limit of at least 512 tokens. The operation has a fixed prompt and explicitly caps output at the lower of the configured limit and 800 tokens. No model, agent instruction, player content or provider target can be supplied in the request.

An anonymous player cannot invoke generation. Creating or joining rooms, polling, chatting, choosing an action, voting and rematching only reuse the approved cached vocabulary; they make no model calls. Player names, avatars, messages, roles, targets and results never enter the model prompt. Turning paid execution off later prevents new generation while leaving already reviewed text usable. The separate narrator availability control can disable the cached AI option without deleting its text or receipts.

The fixed `game-mafia-narration:<organization>:<service>:` row lives in the existing published-game table. Its draft, owner identifiers and request history stay server-side and are excluded from the public game catalog. The public Mafia configuration exposes only `aiAvailable` and `aiLabel`. The server supplies only the approved inert text bank to new AI rooms. Stored text is returned as plain strings and rendered as text, never executable HTML or script.

## Generate and review

The protected operations are implemented by `backend/nce_api/mafia_narration.py`:

| Operation | Input | Result |
| --- | --- | --- |
| `admin_status(api, event)` | Current Core authorization | Current revision, attempt count, draft and sanitized request statuses |
| `generate(api, event, body)` | `requestId`, `expectedRevision` | A reserved, bounded generation and its text draft |
| `approve(api, event, body)` | `requestId`, `expectedRevision`, `reviewed: true` | Enable exactly the reviewed draft |
| `set_enabled(api, event, body)` | `expectedRevision`, `enabled` | Enable or disable an already approved vocabulary |
| `public_config(api)` | None | Public availability and display label; no draft or receipt data |
| `load_bank(api)` | None | Approved `{version, source, phrases}` or `None`; no provider call |

For a fresh installation, generation uses revision zero. A successful response normally has revision two because the durable reservation and validated result are separate writes. Inspect all eight lines, then approve using the exact returned request ID and revision. The release operator can do that review as part of the already authorized release; there is no additional player approval step. This is an administrative vocabulary review rather than publication of an authored game.

An explicitly authorized deployment may instead initialize an absent cache row with an actual generated and operator-reviewed bank. That deployment configuration must use a conditional absent-row write and retain a separate private generation reservation, prompt/response digests and review provenance. It must not invent a Core identity or application request receipt. Such an initial state has revision one, an approved bank, `enabled: true`, zero application attempts and an empty application request history. Zero application attempts does not mean zero model usage: the separately authorized deployment invocation belongs in the release receipt.

Generation accepts one compact JSON object or one inert JSON code fence. It rejects unknown or duplicate fields, tool calls, incomplete output, placeholders, markup, URLs, invisible controls and oversized text. Provider failures return a generic message without echoing provider content. The last approved bank remains available while a replacement draft is generated or fails validation.

Each application invocation is reserved atomically with an exact snapshot of the live agent registry before provider I/O. The service rechecks Core authority and registry before invocation and before saving a completed draft. A request ID is bound to its requesting administrator and is never automatically invoked again, including after timeouts. A pending interrupted request remains pending and blocks further calls; an operator must investigate it rather than assume the provider did not run. Completed and failed requests can be replayed only as cached statuses. The installation has at most three lifetime application generation reservations, further limited by the current registry's `maxModelCalls`; increasing that bound requires a separately reviewed code change.

Approval and availability changes use exact revision, tenant and payload conditions. A publication of narration never resets game rooms, roles, games, scores or another administrator's changes. Existing rooms retain their bounded copy of the vocabulary selected at creation.

## Validation

`tests/test_mafia_narration.py` uses synthetic storage, blocked sockets and mocked providers. It checks anonymous/provider-free cache reads, protected authorization, fixed prompts and model selection, durable reservation and replay, budget limits, strict output parsing, review binding, registry/permission races, tenant fences, corruption preservation and availability changes. Local test results do not establish production model acceptance; the live release must verify the exact model permissions and inspect one generated vocabulary before enabling the option.

References: [Amazon Nova model documentation](https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html), [Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html).
