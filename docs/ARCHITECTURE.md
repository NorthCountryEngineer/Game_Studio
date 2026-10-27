# Independent Game Studio service

## Ownership and deployment

Game Studio owns game definitions, private design conversations, playtest acknowledgements, publication snapshots, edition-specific high scores, agent/workflow configuration, its account invitations and branding. A host application owns its lessons, pages, course permissions, assessment policy and the association between a lesson and a Game Studio game ID. NCE Core owns identities, app membership, permissions and deployment authority.

The first implementation deliberately deploys one backend/frontend per Core tenant and environment. Tenant/service identifiers are server environment values, never selectors accepted from query parameters, messages or request bodies. Data keys and live introspection bind records to that installation. Different host applications in the same installation share its published catalog and edition boards; deploy separate installations when distinct content or score boundaries are needed.

AWS hosting uses Amplify for the static React frontend, API Gateway HTTP API and Lambda for the backend, on-demand DynamoDB tables for state, and private S3 for compatibility with the extracted assistant framework. Core resource credentials remain in the installation's SSM SecureString. No always-running Fargate service is needed for this workload. Model configuration stays separate from hosting and does not invoke a model.

The dedicated trusted Core deployment recipe is reviewed alongside this application. The generic `amplify-serverless` recipe is insufficient: it does not carry Game Studio's complete identity contract, assistant/game tables, runtime configuration and host framing policy. A marketplace identity registration alone does not provision hosting. Follow the Core onboarding guide before exposing this application in its deployment console.

## Authoring and publication

The host displays its creator link only to its own administrators. That link is a navigation convenience, not a permission grant. Game Studio performs its own normal top-level Core PKCE sign-in and checks current service-specific permissions for every protected operation. This avoids third-party cookie dependence and sending authorization codes or bearer tokens through an iframe.

`games-create` is delegated game creation administration. `games-publish` adds publication after playtesting. `games-manage` controls creation settings, branding and cross-content admin actions. `agents-manage` and `accounts-manage` independently control those workspaces. Ordinary authenticated players have no creation rights. Core organization administrators are not implicitly treated as Game Studio creators by the API.

Drafts stay private. Playtesting runs a validated data-only game specification inside a sandboxed frame with a fixed engine, nonce-bound messages and no network access. Generated content cannot add executable JavaScript, remote assets, new tools or mechanics beyond the supported engine. Agentic level planning remains constrained by the same schema. The free guided designer is deterministic; optional configured models can propose a tailored progression. All levels must be reviewed in the saved revision before a publisher can publish a copied snapshot.

`GameSpec` is a discriminated union: version 1/2 retain the existing arcade schema and version 3 carries one crossword, word search or Mad Libs definition. Word games have separate strict validators, deterministic bounded layout algorithms, and a fixed word-game sandbox. Browser and backend validators/layouts are checked against each other. The Lambda packager includes the new `word_games.py` module without changing table or identity configuration. A word game's single review item is `level-1`; editing clears its acknowledged revision, and publication still needs the separate human action. See [format definitions and limits](WORD_GAMES.md).

The optional existing model path is restricted to the current word-game format and administrator-defined usage limits. A model proposes data for that schema, never code or publication. All formats work through the free guided builder and direct editors without a model. Player letters, Mad Libs answers and completed stories are ephemeral inside the sandbox; outbound results contain only validated completion counts. Public puzzle definitions include their answers and are suitable for practice, not confidential tests. Puzzle results do not create arcade score boards.

Publishing updates one canonical live edition. Hosts embed that canonical game ID, so a later publication becomes visible there; a stale score submission receives a reload error. Boards reset with each edition. Unpublishing removes public play and its board everywhere using that installation, while retaining the private draft. Deletion is explicit and requires the administrative capability.

## Host embedding

`/embed/games/{id}` is the public player surface. Host IDs resolve only against operator-configured exact origins; the parent referrer must match. The hosting policy allows framing only by those origins. Private creation, account, settings and OAuth pages reject framing. The common SDK verifies sender origin, source window, channel, game ID, protocol version and message shape. Messages never carry identity, access tokens, roles or private drafts.

The exported completion event is a client-reported gameplay observation. It is suitable for UI feedback and an instructor's activity view; it is not proof of a student's identity, learning or grade. A host must bind activity to its own trusted session and instructor-approved assignment policy. Academy students need not become Core creators. Generated educational games remain private until an instructor/administrator reviews and publishes them.

The framework-independent SDK provides a separate version 1 assignment scoring policy and deterministic provisional calculators for all supported game formats. A host can reuse the same game on 25-point, 100-point or other bounded scales without editing the definition or casual board. Whole-game objective totals come from the validated snapshot; explicit arcade targets do not reuse the engine's conservative point ceiling. Optional publication hashing checks exact ID, edition and canonical definition bytes. Attempt selection uses host-issued ordinals, never browser time. Identity, enrollment, immutable policy review, attempt admission/idempotency, protected audit storage and final credit remain host responsibilities. Existing game specifications and version 1 completion messages are unchanged. See [assignment scoring](ASSIGNMENT_SCORING.md).

Public games and their arcade nicknames are publicly accessible. Approved embedding origins are a framing and integration boundary, not content confidentiality. Do not publish sensitive student information into game titles, descriptions, level text or nicknames. This release does not add private enrollment-based game distribution or automatically modify NCAcademy's lessons/accounts.

The unversioned public catalog remains compatible with legacy hosts by returning only version 1/2 games. Game Studio and its current SDK opt in to all formats with `specVersion=all`. Filtered pages retain their cursor even when empty. Direct published-ID lookup returns the saved versioned definition. NCAcademy's pinned data-import player remains a separate version 1/2 consumer; supporting version 3 there requires its own importer/player update and acceptance.

## Branding

An installation starts with its configured application name, badge, accent and optional public logo URL. A host keeps its own page chrome; the embedded service badge identifies the configured Game Studio installation. Hosts sharing that installation share its badge and catalog. Separate configured Core application installations can use different brands and data boundaries. An authorized Game Studio administrator can change branding in the UI using optimistic revision checks. Branding is plain text and an optional validated image URL. Host origins and return paths remain deployment settings because they must match API CORS and the CDN framing policy; a branding edit cannot change those security settings.

## Extraction and migration

The original Axolotl deployment and data are preserved. This repository contains the engine and authoring behavior, not a copy of live records. A host can adopt the standalone service incrementally through public links and the SDK. Moving existing drafts, accounts or score boards requires an explicit, reviewed data migration; changing endpoints alone is not such a migration.

References: [Amplify custom headers](https://docs.aws.amazon.com/amplify/latest/userguide/setting-custom-headers.html), [browser messaging security](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#security_concerns).

## Optional multiplayer extension

Version 4 arcade editions opt in to two-player cooperative play while retaining saved levels and solo play. The parent page connects through an additive application-owned HTTP/WebSocket relay; the opaque game iframe remains network-disabled. A dedicated encrypted TTL table stores anonymous capability hashes and leases, never snapshots or student identities. The extension can read/condition-check the exact public-edition table and cannot access private drafts or Core credentials. The existing Core stack and shared permission boundary stay unchanged. Legacy catalogs still expose only versions 1–2; cooperative editions do not enter the old solo leaderboard, SDK completion or assignment scoring contract. See [MULTIPLAYER.md](MULTIPLAYER.md) for lifecycle, testing and both release steps.

Version 5 adds strictly configured Asteroids prizes and can be solo or cooperative. Its per-ship effects and bounded shared pickups are fixed engine data; snapshots retain the existing size and authority boundaries. Solo prize games retain normal completion/scoring; cooperative ones remain excluded from those solo contracts. Existing saved formats are unchanged. See [ASTEROID_PRIZES.md](ASTEROID_PRIZES.md).
