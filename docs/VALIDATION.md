# Validation and release boundary

The standalone application passes 136 TypeScript tests, 174 Python backend tests and seven deployment guard tests. Typechecking, preview/production builds, deterministic Lambda packaging, registry parity and infrastructure structure/security invariants pass. A fresh offline npm installation also succeeded in an isolated temporary directory.

The companion Core recipe passes 132 offline tests, system checks, migration drift checks and its onboarding security invariants. Its reviewed production-source baseline is cf8cd458. The Core PR is https://github.com/NorthCountryEngineer/NCE_Core/pull/6.

Browser checks covered local draft creation, a completed private playtest, publication, custom branding, the creation switch, a named local score and a second-origin embedded player ready event. The public game remained playable while creation was paused. The creator's public game/edition handoff returned to the configured host. Nested-frame input could not be completed through the browser automation tool; completion-event isolation is covered by synthetic SDK tests, not a claimed full embedded-round acceptance.

GitHub verification workflow 40098905211 passed the application checks and both build modes at source 6d94a22. Later documentation-only commits must receive their own exact-source push CI before Core admits a deployment.

No new AWS resources, live Core/runner/grant/DNS changes, subscriptions or paid model calls were made. The original Axolotl application/data were not migrated or modified. Formal CloudFormation schema/compliance and AWS account-aware validation remain pending; local invariants are not a substitute. The standalone Core login, shared AWS scores and complete cloud deployment have not been live-verified for this new installation.
