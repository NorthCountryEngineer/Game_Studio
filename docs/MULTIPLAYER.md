# Optional two-player cooperative games

A creator enables **Allow two players to play together online** on an arcade game, saves it, playtests its saved levels and publishes the reviewed edition. The game keeps its normal **Play solo** option. Word games remain single-player. Existing versions 1–3 are unchanged; opting in creates version 4, retaining the version 2 level plan and layout seeds.

On the published game's page, choose **Host two-player game** and copy the private invitation to the other player. The second player opens that link in another browser session or device. The host starts the shared round once both players are connected. Both players see the same obstacles and collectibles, with two friendly characters/ships and separate controls, lives, collection goals and arcade point totals. Projectiles cannot damage a teammate. Both players must reach their own collection goal; the round ends if time expires or both players lose their lives. The host controls start, pause, restart and level progression. The second player controls their own character.

Multiplayer supports the fixed collect, dodge/shooting and platformer engines. It does not add chat, spectators, matchmaking, a public room directory or competitive play. Browser-host simulation is an advisory play observation. Cooperative-enabled editions do not submit to the existing solo leaderboard or assignment points SDK; a future host integration must explicitly bind each player's observations to its own approved assessment workflow. NCAcademy's current pinned arcade importer continues to receive only supported versions 1–2.

## Connection and lifecycle

The parent page connects to a managed WebSocket relay. The host browser advances one shared world; the guest sends only a six-button input mask. The host transmits bounded snapshots at ten per second. Every snapshot is validated against the fixed schema, edition and numerical/entity bounds. No generated code, remote assets, model calls or networking permissions enter the opaque sandbox. The iframe retains its own no-network content security policy, nonce and strict source-window checks. The existing version 1 host completion envelope is unchanged; cooperative play does not emit it.

The server binds a room to the current published game ID, edition and SHA-256 definition hash. Publication condition checks share atomic transactions with admission and relay leases; unpublishing or publishing another edition invalidates the room. A room expires after 30 minutes. The server enforces expiry even while a DynamoDB TTL record still exists. An invitation admits exactly one guest atomically. Losing a connection pauses the game and clears held inputs. The same page can reconnect briefly using the same seat capability; the host explicitly resumes. There is no host migration. Leaving/closing the host room ends it for both players. Reloading a page loses its in-memory capability, so use a new room rather than treating reload as a saved session.

Room, host, invite and guest capabilities are separate random values. Only their SHA-256 hashes are stored. The invite uses a URL fragment, which is removed before joining; capabilities travel in POST bodies and the first WebSocket message, never query parameters, public catalog data or iframe/host events. Treat an invitation as private: anyone holding an unused invitation can occupy its one guest seat. There are no names, emails, student IDs or Core access tokens in the room protocol.

Increasing sequence numbers and connection generations prevent replay and stale disconnects from controlling a replacement socket. Per-source admission limits, short connection leases, message-size/rate bounds, aggregate API throttles and logical expiration bound abuse. The initial socket stage admits 100 messages/second with a burst of 200 across the installation, so it is intended for a small number of concurrent rooms. A larger class rollout needs a reviewed aggregate limit and concurrency/load test. These controls are not a monetary spending cap. The host pauses the shared game when its tab becomes hidden; returning requires an explicit resume. Keep the host's game tab active: browser throttling, latency and device performance can affect a browser-host simulation. This is cooperative play, not an anti-cheat server or an authoritative grading service.

## Retention and authority

The additive relay has its own encrypted on-demand DynamoDB table for capability hashes, game binding, short connection leases and hashed admission counters. It stores no gameplay snapshots, chat, names or student records. TTL removes expired records asynchronously. Lambda retains infrastructure diagnostics for seven days; socket payload tracing and access logs are disabled. Application code never prints request bodies or capabilities. Normal AWS platform telemetry may still include network metadata. TLS protects HTTPS/WSS transport and DynamoDB service encryption protects stored ephemeral records.

The relay's dedicated role can read and condition-check the exact existing published-games table; it cannot write there. It can operate its own room table, send/delete connections on its own WebSocket API and write its own logs. It has no access to Core credentials, private drafts, student data, models or other application resources. The existing Core application stack and shared permission boundary remain unchanged. The extension is explicitly application-owned infrastructure and is released separately from Core's current fixed frontend/API recipe; later Core recipe adoption must preserve the existing room stack or perform a reviewed migration.

## Package and deploy

`infra/aws/multiplayer.template.json` creates the additional HTTP room API, WebSocket API, relay Lambda, retained TTL table, role and short-retention log group. It uses the same deterministic backend source archive as Game Studio. It reuses the verified application's private artifact bucket without changing its policy, DNS, domains or Core grants. API Gateway, Lambda, DynamoDB and build/storage traffic have normal usage charges; there is no always-running game server or TURN subscription.

Planning makes no cloud requests:

```sh
python3 scripts/deploy-multiplayer.py \
  --output /PRIVATE/RECEIPTS \
  --core-stack nce-YOUR-EXISTING-APPLICATION-STACK \
  --application-id YOUR-APPLICATION-UUID \
  --stack game-studio-YOUR-APPLICATION-multiplayer \
  --profile YOUR-PROFILE --expected-account YOUR-12-DIGIT-ACCOUNT
```

After reviewing the source and plan, repeat with `--execute --authorize-aws-charges` using a clean committed checkout. Execution verifies the account, exact Core application tags/identity, current origin, existing published-games table and bucket ownership. The change-set guard refuses resource removal/replacement and an existing extension cannot be reassigned to another tenant. The relay code hash and health endpoint must match before a receipt is written.

Copy the receipt's **publicConfig** into `public/multiplayer-config.json`, commit that public endpoint and release the frontend/API through the normal Core flow. The file contains only `{ "version": 1, "apiUrl": "https://..." }`; no keys, room capabilities or private settings belong there. Empty configuration leaves solo play available and explains that the relay is unavailable. For another environment, deploy a separate verified extension and use its matching configuration. Subsequent backend changes require both the extension script and the normal Core application release; deploying only the main API does not update the relay Lambda.

Rollback the frontend to a reviewed previous commit to remove the option. End/expire active rooms before changing the protocol. Keep the retained table and all existing Core application resources. The script refuses destructive changes; deleting infrastructure is a separately reviewed operation.

## Verification

Run `npm run typecheck`, `npm test`, `npm run test:api`, `python3 -m unittest discover -s scripts/tests`, `python3 scripts/validate-deployment.py`, `python3 scripts/package-api.py` and `npm run build:preview`. Engine tests check one world tick, independent inputs/collisions/goals/points, friendly-fire exclusion and strict sandbox state. Room tests cover capability storage, atomic single-guest admission, wrong seats, stale generations/sequences, expiry, publication changes, origin/rate/size bounds and private-state exclusion. Deployment tests verify the publication-only grant, callback scope, tenant immutability and retention. These local checks use synthetic data and call no model providers.

Run `npm run test:multiplayer-preview` for an isolated two-WebSocket network check; it starts and cleans up its own local servers and also runs in CI. For interactive inspection, run `npm run dev:multiplayer` and open `http://127.0.0.1:8096/__multiplayer-fixture` in two pages. This uses the production Python room logic with transient synthetic storage over actual localhost HTTP/WebSockets. A preview is not AWS acceptance. After a real deployment, independently verify Lambda archive bytes, frontend source-build bytes, the exact configured HTTPS/WSS endpoints, API route permissions, private table scope, TTL, public health and protected authoring boundaries. Review and complete the private solo level playtests before publishing an opted-in edition. Because live rooms bind only published snapshots, run an owner-approved two-device acceptance after publication and before adopting it into lessons, including guest movement/firing, separate goals/points, pause/reconnect and a third guest rejection. Do not create student identities or fabricate assessment results for acceptance.

CloudFormation structural/security checks in this repository complement formal validators. If `cfn-lint` or `cfn-guard` are unavailable, record that they did not run; service template/change-set validation and the independent runtime checks are separate evidence.

The managed relay uses AWS's documented [WebSocket lifecycle routes](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html) and scoped [connection callbacks](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html).
