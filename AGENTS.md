# Game Studio development contract

Read README.md and docs/ARCHITECTURE.md before changes. This is an independent Core application. Keep Axolotl News, NCAcademy, Proposal Studio and active Core checkouts untouched unless the user authorizes changes to them. Maintain the extracted engine's schema and publication invariants, including preservation of authored level data.

Core is the identity authority. Recheck live service-scoped permissions on protected operations; host URLs/messages cannot grant access or choose a tenant. Keep private drafts separate from public snapshots. Creation is delegated game administration. Never run generated JavaScript: models propose validated game data for the fixed sandboxed engine. Publishing requires human playtesting and review.

Use synthetic state and mocked providers for tests. Never put credentials, real users, runtime records or private configuration in Git, fixtures, screenshots or frontend variables. Game completion and casual scores are client-reported, not authoritative educational assessment. Host integration must validate exact origin, source window, channel and message shape; never forward host tokens.

Local design, reversible code edits and offline validation are permitted. Do not provision cloud resources, invoke paid models, subscribe or deploy without user authorization for that release. Deployment scripts must default to local planning. Preserve the application's original no-cost boundary when authorization is unclear; finish a concrete reviewable source package first. Do not edit Codex memories unless the user asks.
