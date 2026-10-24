# Validation and release boundary

The standalone application passes 136 TypeScript tests, 174 Python backend tests and seven deployment guard tests. Typechecking, preview/production builds, deterministic Lambda packaging, registry parity and infrastructure structure/security invariants pass. A fresh offline npm installation also succeeded in an isolated temporary directory.

The companion Core recipe passes 132 offline tests, system checks, migration drift checks and its onboarding security invariants. Its corrected production-source baseline is c27e6a03, verified against all 459 included files of the existing Core image. The proposed recipe source is 52d8ad1; its exact-commit CI is still pending. The Core PR is https://github.com/NorthCountryEngineer/NCE_Core/pull/6.

Browser checks covered local draft creation, a completed private playtest, publication, custom branding, the creation switch, a named local score and a second-origin embedded player ready event. The public game remained playable while creation was paused. The creator's public game/edition handoff returned to the configured host. Nested-frame input could not be completed through the browser automation tool; completion-event isolation is covered by synthetic SDK tests, not a claimed full embedded-round acceptance.

GitHub verification workflow 40098905211 passed the application checks and both build modes at source 6d94a22. Later documentation-only commits must receive their own exact-source push CI before Core admits a deployment.

## Authorized rollout checkpoint — October 24, 2026

The owner authorized the AWS/Core rollout. The platform now includes the new repository and main branch, scoped DynamoDB ConditionCheckItem permission, and an empty model-ARN parameter. Existing repositories, branch permissions and resources were retained. Its runner pins were restored to their prior values while the application release is pending, matching the existing Core platform configuration.

The first Core image attempt was withdrawn after UI and load-balancer acceptance checks failed. Core is restored to its previous immutable c27e6a03 image, with a healthy target, working sign-in page and the prior interface preserved. The additive 0042 application-type migration remains applied and is backward compatible. Existing identity/platform model hashes were identical except deployment runtime rows; existing deployment counts were unchanged. The published Axolotl catalog also matches its checkpoint. The candidate passed a separate database and local HTTP health diagnostic; that does not establish why its earlier ALB health check timed out.

No Game Studio application stack, frontend URL, installation, OAuth clients, application grants or data migration has been created. Exact-source automatic push CI is missing for this new repository; a proposed alternative owner-dispatch evidence policy is inactive and awaits explicit approval. An earlier manual verification passed, but it does not satisfy the current push-only Core policy.

AWS validate-template and change-set validation succeeded for the reviewed platform update. Formal CloudFormation schema/compliance tools were unavailable and were not run. Normal AWS build/storage/diagnostic compute usage occurred under the owner's rollout authorization; no subscription, DNS change or paid model call was made. The standalone Core login, shared AWS scores and full cloud deployment have not been live-verified for this new installation.
