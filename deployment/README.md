# Independent AWS deployment

Game Studio is prepared as a separate Core tenant application. Its frontend is a manual Amplify site; its backend is a Lambda HTTP API with five retained on-demand DynamoDB tables and a private encrypted media bucket. Games run inside isolated browser players, so gameplay does not need a container, Fargate task or per-game server. Publishing writes a copied public edition; each publish resets that edition's shared score board. Disabling game creation leaves published games playable.

No cloud operation is performed by building, testing, packaging, or running the release script without `--execute`. Executing the steps marked **AWS operation** creates resources or deployment traffic and can incur charges. The scripts never subscribe to a provider, invoke a model, change Core grants, create a domain or modify another app. AWS API/hosting/storage/build traffic and administrator-authorized provider use still have their normal service charges.

The Core-console recipe is the intended managed path after its companion patch is installed. This guide is the independent external installation fallback and an exact description of the deployment boundaries. Do not select Core's generic `amplify-serverless` recipe for this repository.

## 1. Get the reviewed source and validate locally

Use an existing Node 22.12+ runtime, Python 3.12+ and AWS CLI v2. Do not change the laptop's global runtime to run this project. Clone the published repository and check out the reviewed commit/branch:

```sh
mkdir -p "$HOME/Developer"
cd "$HOME/Developer"
git clone https://github.com/NorthCountryEngineer/Game_Studio.git
cd Game_Studio
npm ci --no-audit --no-fund
npm test
python3 scripts/validate-deployment.py
python3 -m unittest discover -s scripts/tests -v
npm run build:preview
```

The preview uses synthetic browser-local state; it is not an authenticated production deployment. Do not use a local/demo build as the public site. Follow the root README for the local preview URL. The source must be committed and the checkout clean before a real release.

Set these operator values explicitly. The account is the destination account, not an automatically inferred ambient credential:

```sh
export GS_PROFILE="YOUR_AWS_PROFILE"
export GS_REGION="us-east-1"
export GS_ACCOUNT="YOUR_12_DIGIT_AWS_ACCOUNT"
export GS_TENANT="YOUR_CORE_ORGANIZATION_SLUG"
export GS_ENV="production"
export GS_ADMIN_EMAIL="YOUR_EXISTING_CORE_ADMIN_EMAIL"
export GS_RELEASE_DIR="$HOME/.game-studio-aws/$GS_TENANT/$GS_ENV"
export GS_FRONTEND_STACK="game-studio-$GS_TENANT-$GS_ENV-web"
export GS_API_STACK="game-studio-$GS_TENANT-$GS_ENV-api"
mkdir -p "$GS_RELEASE_DIR"
chmod 700 "$GS_RELEASE_DIR"
cp deployment/studio-config.example.json "$GS_RELEASE_DIR/studio-config.json"
```

Edit that JSON in your editor. `branding` permits plain `appName`, `badgeText`, a six-digit `accentColor`, and optional HTTPS `logoUrl`. `hosts` is initially empty, so embedding is denied. A host has exactly `id`, `name`, `origin` and `returnPath`, for example:

```json
{
  "id": "academy",
  "name": "Academy",
  "origin": "https://academy.example.com",
  "returnPath": "/lessons"
}
```

Replace the example hostname with the real existing application origin before allowing it. HTTPS origins must be exact: no wildcard, path, query or credentials. Return paths stay inside the fixed origin. Production configuration must fit within 2,048 UTF-8 bytes because Lambda's entire environment has a separate 4 KiB limit. A branding update in the UI never changes this deployment allowlist or CORS/hosting policy.

## 2. Prepare and provision independent frontend hosting

This first invocation only writes a local plan:

```sh
python3 scripts/deploy-aws.py frontend \
  --profile "$GS_PROFILE" --region "$GS_REGION" --expected-account "$GS_ACCOUNT" \
  --stack "$GS_FRONTEND_STACK" --name "game-studio-$GS_TENANT-$GS_ENV" \
  --branch "$GS_ENV" --output "$GS_RELEASE_DIR"
```

**AWS operation:** after reviewing `frontend-plan.json`, provision the new manual Amplify app and private artifact bucket:

```sh
python3 scripts/deploy-aws.py frontend \
  --profile "$GS_PROFILE" --region "$GS_REGION" --expected-account "$GS_ACCOUNT" \
  --stack "$GS_FRONTEND_STACK" --name "game-studio-$GS_TENANT-$GS_ENV" \
  --branch "$GS_ENV" --output "$GS_RELEASE_DIR" \
  --execute --authorize-aws-charges

export GS_ORIGIN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Origin"])' "$GS_RELEASE_DIR/$GS_FRONTEND_STACK-outputs.json")"
export GS_CODE_BUCKET="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ArtifactBucket"])' "$GS_RELEASE_DIR/$GS_FRONTEND_STACK-outputs.json")"
printf 'Register this Game Studio origin in Core: %s\n' "$GS_ORIGIN"
```

The generated Amplify hostname avoids a new domain or DNS dependency. A custom domain must be onboarded and independently verified before its immutable Core registration; the fallback publication script deliberately requires the generated origin. Do not register an Amplify temporary hostname and then silently switch the application origin. Nothing in these commands touches `axolotl.news` or its existing hosting.

## 3. Install and register the Core package

Complete `nce/README.md` in the trusted Core management runtime. It describes the precise marketplace package and CLI registration, new dedicated SSM path and operator boundaries. The result required here is:

- Public registration JSON saved at `$GS_RELEASE_DIR/core-public.json`.
- The private `{client_id, client_secret}` stored in the **new** SecureString `/game-studio/$GS_TENANT/$GS_ENV/core-resource-client`.
- The exact registered origin equal to `$GS_ORIGIN`.

A normal application account does not confer creating/publishing permissions. Assign the corresponding Game Studio administrative role through Core, using the same account identity. Do not reuse Axolotl's confidential client or its secret parameter.

## 4. Prepare and deploy the API first

The preparation command validates the configuration locally, packages the independent Python modules, and records the exact source commit/archive hash. It makes no AWS request:

```sh
python3 scripts/deploy-aws.py api \
  --profile "$GS_PROFILE" --region "$GS_REGION" --expected-account "$GS_ACCOUNT" \
  --stack "$GS_API_STACK" --output "$GS_RELEASE_DIR" \
  --core-public "$GS_RELEASE_DIR/core-public.json" \
  --studio-config "$GS_RELEASE_DIR/studio-config.json" \
  --credentials-parameter "/game-studio/$GS_TENANT/$GS_ENV/core-resource-client" \
  --code-bucket "$GS_CODE_BUCKET"
```

**AWS operation:** review `api-plan.json`, then repeat with execution enabled:

```sh
python3 scripts/deploy-aws.py api \
  --profile "$GS_PROFILE" --region "$GS_REGION" --expected-account "$GS_ACCOUNT" \
  --stack "$GS_API_STACK" --output "$GS_RELEASE_DIR" \
  --core-public "$GS_RELEASE_DIR/core-public.json" \
  --studio-config "$GS_RELEASE_DIR/studio-config.json" \
  --credentials-parameter "/game-studio/$GS_TENANT/$GS_ENV/core-resource-client" \
  --code-bucket "$GS_CODE_BUCKET" \
  --execute --authorize-aws-charges
```

The script confirms the account, expected bucket owner and dedicated stack tag, creates/reviews a CloudFormation change set, rejects resource removals/replacements, waits for completion and verifies the deployed Lambda archive SHA and public health route. Core placement/origin/secret-reference changes on an existing stack are rejected. A successful operation writes `api-release.json`; a frontend cannot publish with a mismatched source/configuration receipt.

The default `--concurrency 0` omits a reserved concurrency allocation for low-quota accounts. It does not disable the function and is not a spending cap. Choose `--concurrency 1` or `2` only after checking the account quota. The API throttles requests and has bounded workflow execution, but those do not guarantee a maximum AWS bill.

## 5. Publish the frontend from the same commit

Prepare the frontend archive first:

```sh
python3 scripts/deploy-aws.py publish \
  --profile "$GS_PROFILE" --region "$GS_REGION" --expected-account "$GS_ACCOUNT" \
  --stack "$GS_FRONTEND_STACK" --output "$GS_RELEASE_DIR" \
  --core-public "$GS_RELEASE_DIR/core-public.json" \
  --studio-config "$GS_RELEASE_DIR/studio-config.json" \
  --api-receipt "$GS_RELEASE_DIR/api-release.json"
```

**AWS operation:** publish that reviewed source after the matching API has succeeded:

```sh
python3 scripts/deploy-aws.py publish \
  --profile "$GS_PROFILE" --region "$GS_REGION" --expected-account "$GS_ACCOUNT" \
  --stack "$GS_FRONTEND_STACK" --output "$GS_RELEASE_DIR" \
  --core-public "$GS_RELEASE_DIR/core-public.json" \
  --studio-config "$GS_RELEASE_DIR/studio-config.json" \
  --api-receipt "$GS_RELEASE_DIR/api-release.json" \
  --execute --authorize-aws-charges
```

The script builds with the public Core registration and studio configuration, includes generated `customHttp.yml` in the artifact, confirms the API hash again, uses a private one-use Amplify upload URL without logging it, and waits for `SUCCEED`. It writes `frontend-release.json`. It never marks browser functionality live-verified merely because the hosting job succeeded.

For later releases, check out the new reviewed commit and repeat steps 4–5. Use a new private receipt subdirectory per release if retaining an immutable operator history; keep the existing stack names, origin, clients, SSM reference and data resources. No automatic cleanup/delete/recreate operation is provided.

## 6. Validate actual functionality

1. Open the final origin and reload `/games`, `/game-studio` and `/oauth/callback` directly. Public games/catalog should work anonymously; a callback without valid one-use state should fail safely.
2. Sign in through Game Studio's own Core PKCE flow as a delegated Game Studio administrator. Create a private game, converse, change its levels/options, save, reload and complete the required isolated playtest. An ordinary Core user without `games-create` must be denied creation by the API.
3. Publish the test game and verify an anonymous window sees only its published copied edition. Change its private draft; confirm the public edition is unchanged until republished.
4. Verify the arcade options, score submission from a signed-in player, cross-browser shared board, republish board reset and stale-edition response. Unpublish the synthetic test game, keeping the private draft if useful.
5. Toggle creation off. Confirm create/edit/publish operations are rejected while existing public games remain playable. Restore the intended setting.
6. On a configured host, embed one public game and verify the SDK ready/result messages. Try an unconfigured parent origin and confirm framing is blocked. Direct creator, OAuth and settings routes must return `X-Frame-Options: DENY` and `frame-ancestors 'none'`. Only `/embed/games/**` may have configured host ancestors. Inspect the actual HTTPS response headers; local HTML cannot prove Amplify's headers.
7. Remove the test user's Game Studio role in Core and confirm the next protected operation is denied. Do not revoke a real production administrator as a test. Do not create real student accounts just to test education embedding.
8. Confirm the preexisting Axolotl frontend/API/content and any current Core/Academy deployment are unchanged. Record source SHA, Lambda SHA, Amplify job, HTTP/UI results and remaining limitations before calling a release live-verified.

Shared scores are bounded client-reported arcade scores, not server-proven anti-cheat results. Public embeddings do not imply private lesson authorization or Academy student SSO. See `nce/README.md` for the separate local-family identity boundary.

## Infrastructure review and validation status

The templates retain state, encrypt storage, block public S3 access, require TLS, scope runtime access to this installation, keep private client material server-side and restrict HTTP CORS to the exact own/host origin set. The compatibility private/public tables preserve the current assistant/media adapter contract; they are newly created empty Game Studio resources, never references to Axolotl's posts. Browser code cannot access tables or SSM directly. CloudFormation context records these constraints.

`python3 scripts/validate-deployment.py` and local guard tests are structural/security invariants, not a CloudFormation resource-schema validator or compliance certification. In this preparation session, cfn-lint/cfn-validate and cfn-guard were not installed; no dependency installation or account-aware cloud validation was performed. Before deployment use the organization's pinned cfn-lint and cfn-guard rules, then inspect CloudFormation pre-deployment events for the exact account and change set. If the destination account lacks configured CloudTrail retention, its auditability is reduced; enabling or purchasing audit infrastructure is a separate operator decision.

The IAM policies are adapted from the existing scoped Game Studio runtime policy with independent resource references. They grant no deployment, IAM or Core membership authority. For a separate deterministic baseline review of runtime source, the AWS IAM workflow supports this operator command; it downloads/runs a local tool and is **not** run by preparation or release:

```sh
uvx iam-policy-autopilot@latest generate-policies \
  "$PWD/backend/nce_api/handler.py" \
  "$PWD/backend/nce_api/agent_framework.py" \
  "$PWD/backend/nce_api/games.py" \
  "$PWD/backend/nce_api/game_scores.py" \
  "$PWD/backend/nce_api/integration.py" \
  --account "$GS_ACCOUNT" --region "$GS_REGION" \
  --service-hints dynamodb s3 ssm bedrock rekognition logs --pretty
```

Review tool output; do not apply generated policies automatically. DynamoDB transactions authorize underlying item actions, including `ConditionCheckItem`; there is no separate `dynamodb:TransactWriteItems` grant to add. Bedrock/media capabilities in the copied runtime policy do not trigger calls or subscriptions. Only current saved administrator policy authorizes actual provider operations; no live provider calls are needed for the synthetic release checks.

AWS documentation used for packaging: [Amplify custom headers](https://docs.aws.amazon.com/amplify/latest/userguide/setting-custom-headers.html), [header YAML patterns](https://docs.aws.amazon.com/amplify/latest/userguide/custom-header-YAML-format.html), [Lambda execution roles](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html), and [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

## Optional multiplayer relay

The additive managed WebSocket relay is an application-owned extension with a separate release script. It preserves this Core-managed stack and shared permission boundary. Follow [MULTIPLAYER.md](../docs/MULTIPLAYER.md) to deploy the relay, record its public endpoint, and then release the normal frontend/API. Backend changes require updating both Lambdas.
