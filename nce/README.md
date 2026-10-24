# Game Studio in NCE Core

`marketplace.json` is an ordinary reviewed Core external application package. Each tenant installs its own `game-studio` authorization service, then registers an active environment and exact frontend origin. The installation creates identity metadata only. The independent AWS templates and release script in `deployment/README.md` provision hosting separately.

This repository does not borrow Axolotl's service, browser client, resource client, SSM parameter, data tables, media bucket or users. Axolotl remains unchanged until an explicitly reviewed integration/migration is deployed. A tenant gets an independent frontend/API/data placement for each environment; that is the first release isolation model, rather than selecting a tenant through a URL parameter on a shared database.

## Permissions and administrative roles

| Permission | Authority |
| --- | --- |
| `games-play` | Player account admission for shared arcade scores; no creation access |
| `games-create` | Private game creation, conversation, drafts and playtests |
| `games-publish` | Publish/unpublish reviewed games, with creation permission |
| `games-manage` | Cross-owner content actions, global creation switch and Game Studio branding administration |
| `agents-manage` | Saved agent, model, mode and workflow policy |
| `accounts-manage` | App-scoped account and invitation administration |

The invitation roles are **Player**, **Game creation administrator**, **Game publishing administrator** and **Game Studio administrator**. Player has no creation, publication, settings, model-policy or account-management permission. The three administrative roles are deliberately delegated application administrators; ordinary signed-in players receive no creation authority by signing in. They do not become Core organization administrators. Only the full Game Studio administrator has creation settings, model-policy and account-management permissions.

A host application's administrator is not automatically a Game Studio administrator. An organization administrator assigns the corresponding Game Studio role to the same Core user. Each protected operation performs fresh Core introspection against Game Studio's exact organization/service/client pair. Removing the user's grant or disabling the installation blocks the next protected operation. Host-supplied `tenant`, `role`, `admin`, subject, email or permission hints never confer access.

## Register an externally hosted installation

Use the current reviewed Core source/runtime, which supports external application packages and app-scoped account roles. Do not use an old checkout solely because a command exists there. The normal Core operator must already have an organization, active environment and existing authorized administrator. The environment's application origin must match the final Game Studio origin. Core's registered origin and client placement are immutable.

With the reviewed package available to the trusted Core management runtime, the operator runs:

```sh
python manage.py register_external_application \
  --organization "$GS_TENANT" \
  --environment "$GS_ENV" \
  --package examples/game-studio-package.json \
  --origin "$GS_ORIGIN" \
  --actor-email "$GS_ADMIN_EMAIL" \
  --credentials-parameter "/game-studio/$GS_TENANT/$GS_ENV/core-resource-client" \
  --public-config /PRIVATE_OPERATOR_DIRECTORY/game-studio-core-public.json
```

The Core onboarding patch bundles this repository's reviewed marketplace file as `examples/game-studio-package.json`. If operating locally with trusted production configuration, `--package` can instead point to the absolute path of `nce/marketplace.json` in this repository. Never mount the entire application checkout, credentials or databases into a public build.

The SSM option requires the dedicated management task's `CORE_REGISTRATION_SSM_PARAMETER` and IAM grant to match that exact new path. The Axolotl registration task cannot safely be reused without a separately reviewed scope change. The command never overwrites an existing parameter. Do not pass the private resource-client JSON to the frontend, commit it, paste it in logs or provide it as command-line text.

For a trusted local Core operator, `--credentials-file /PRIVATE_OPERATOR_DIRECTORY/game-studio-core-resource-client.json` can replace `--credentials-parameter`. A separately authorized operator then transfers it with `aws ssm put-parameter --type SecureString --name ... --value file:///absolute/private/path.json`; omit `--overwrite`. Verify the AWS profile/account before the write. The credential file must remain mode `0600`, outside every source checkout. After an uncertain failure, inspect both Core registration and the existing parameter; do not automatically recreate or rotate either.

Public registration JSON is used by `scripts/write-core-config.mjs` and the API release script. It contains public IDs/origins only. The private API gets only its dedicated SSM reference. Public frontend configuration never selects private credentials or grants.

## Core deployment-console recipe

The existing generic `amplify-serverless` recipe is insufficient for this application: it supplies a different permission vocabulary, fixed storage/environment fields and no Game Studio host configuration. A manifest that merely claims that archetype would deploy an incompatible service.

The dedicated Core onboarding work supplies the fixed reviewed `amplify-game-studio` recipe and its bounded `nce-deploy.json` contract. Use it only after the matching Core patch is installed, platform/repository permissions are onboarded, and the trusted runner commit is updated through Core's normal exact-commit release process. See `deployment/README.md` for the independent external installation fallback. Source packaging alone does not establish an installed marketplace entry or a running cloud service.

## Embedding and education hosts

The public catalog, published game definitions, isolated player and SDK are common interfaces. The creation experience lives in Game Studio's top-level administrative workspace, reached by an allowlisted host link. It can carry a reviewed host ID for branding/navigation and return to that host's fixed configured path. Creation, settings and OAuth routes reject framing; public `/embed/games/{id}` routes permit only configured exact host origins.

Do not send an Axolotl or Academy access token to Game Studio: Core resource clients accept only their paired application browser tokens. A creator signs in to Game Studio with its own PKCE flow; the existing Core session makes this familiar without merging application grants.

NCAcademy students and parents currently have platform-local identities rather than Core identities. Public embedded games therefore work without creating a Core account or exposing a student roster. Core-authenticated shared arcade scores use Game Studio sign-in. A future authenticated education player/score bridge needs its own server-to-server scoped, expiring and replay-protected contract and current Academy enrollment checks. An iframe message, query parameter or display name cannot substitute for that bridge. The first extraction does not claim student SSO or private lesson game authorization.

## Reviewed source and console setup

The companion patch is [core-onboarding.patch](core-onboarding.patch), with the exact production-source baseline and validation in [core-patch-baseline.json](core-patch-baseline.json).

It is a historical `52d8ad1` recipe snapshot with three explicitly recorded overrides from canonical Core `083617a9f282db8cb55edba2bbd1da8165396bd1` ([Core PR #6](https://github.com/NorthCountryEngineer/NCE_Core/pull/6)): the platform template, Game Studio recipe, and the platform README required by its architecture-context references. The platform supplies the scoped API grants plus a default-disabled exact Game Studio frontend binding. The recipe adds the exact default-stage/default-route Lambda permission while retaining the legacy permission and replacement safeguards. Its explicit 200 rewrite serves extensionless application routes while dotted assets and SDK files bypass the SPA rule. The complete override bytes, whole patch and all post-patch file hashes are checked. All other 16 files remain the historical snapshot; this does not import the newer Core adoption runtime or transient CI policies. Existing managed Core installations must use their current Core release process; do not reapply this old patch to a modern installation.

For the optional frontend binding, the platform owner verifies the app and branch against Game Studio's stack outputs, account, region and both ownership tags before setting `GameStudioFrontendAppId` and `GameStudioFrontendBranch`. The existing `FrontendAppId`/`FrontendBranch` binding for other applications stays unchanged. An empty Game Studio app ID creates no optional policy. Repository metadata cannot select this authority. Detailed scope and ownership checks are included in the pinned Core platform README.

The historical patch applies to Core `c27e6a03ff47adf4acc8e670ec2f240127744172`; do not apply it blindly to another revision or a dirty checkout. The patch includes the new console choice, trusted runner/template, exact repository CI admission, app identity and role registration, scoped storage permissions, optional exact-ARN model admission and regression tests. It makes no live changes by itself.

After the Core maintainer has reviewed, released and pinned that source:

1. Open **Core → organization → Platform → Deployment platforms** and edit the intended AWS platform.
2. Include `NorthCountryEngineer/Game_Studio` in **Approved GitHub repositories** and enable **Game Studio · Amplify + serverless API** for the intended environment.
3. In **Approved Game Studio integrations**, enter a repository map whose `NorthCountryEngineer/Game_Studio` value is the version/branding/hosts configuration from [the example](../game-studio-config.example.json), with real exact HTTPS host origins. Leave `allow_paid_models` absent/false for guided creation. The public projection must fit within 2,048 UTF-8 bytes.
4. Save and verify the platform. Configure the current reviewed runner commit through the existing Core release process. This requires the scoped `ConditionCheckItem` permission added by the patch; optional paid models additionally need both the onboarding model ARN parameter and the per-app exact ARN list.
5. Open **Applications → New application**, choose that configured platform/environment and `NorthCountryEngineer/Game_Studio`, choose `main`, select **Game Studio · Amplify + serverless API**, and prepare a release from the exact successful CI commit. The recipe requires **Game Studio required checks** from `.github/workflows/ci.yml`.
6. Review the release fingerprint and resources. Only an authorized operator may approve AWS charges and deploy it. Core provisions hosting, registers separate Core clients/roles, transfers resource credentials to SSM, deploys the API, then builds/publishes the frontend with trusted host framing headers.
7. Wait for every release stage to succeed, then verify public health/catalog, creator Core sign-in, Player denial of creation, branding save, publication/playtests, score submission, allowed/disallowed embeds and unpublish behavior. Local/mock checks are not live acceptance.
8. Assign an existing authorized user the Game Studio administrator role. Use **Accounts** to invite players or delegated game creation/publishing administrators. Add the connected creator link and public player SDK to the host application using [the integration guide](../docs/INTEGRATION.md).

The current repository publication is not an installed or live AWS service. It does not alter Axolotl or NCAcademy deployments, move existing data, enable a provider, or create subscriptions.
