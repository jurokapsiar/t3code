# Factory development

Factory lives in `apps/factory` in the T3 Code monorepo. Use Node 24 and
the repository's pnpm/Vite+ toolchain. Run these commands from the repository root:

```sh
vp i
vp run build:factory
node apps/server/dist/bin.mjs serve --factory
```

`build:factory` builds the native web client, Factory, and the server, then
bundles both UIs into `apps/server/dist`. Open `/factory/` on that server.
No sibling checkout, tarball handoff, separate Bun install, or manual UI path is needed.
The ordinary root `build` and desktop build also include Factory through the server dependency graph.

```sh
vp run dev:factory
vp run dev:factory:mock
vp run --filter @t3tools/factory typecheck
vp run --filter @t3tools/factory test src/factory/protocol.test.ts src/factory/transport.test.ts src/factory/routing.test.ts
```

Development serves the UI at port 3000 (read Vite's output if occupied).
The mock command uses simulated development data and requires no backend or pairing.
For real data, start an isolated Factory-enabled server, then use the proxy below.

## Workspace contracts

`@t3tools/contracts` is a `workspace:*` dependency. Factory and the server use
the same source schemas and catalog Effect version. There is no vendored contract archive.
The overview accepts at most 10,000
threads and 8 MiB of encoded snapshot data. If the overview exceeds either limit,
Nodes remains available through an independent authorized registration list.
Disable or remove a source, then retry the complete overview. Session controls
remain paused; unavailable coverage is not displayed as zero projects or sessions.

Import `@t3tools/contracts/factory`, `/factoryRpc`, and `/rpc` workspace modules.
Use the lightweight `/factoryRelayUrl` resolver with the optional `sourceAccess.httpPrefix`, `mode: "factory-relay"`, and the environment ID for native HTTP detail, asset grants, and upload grants. It preserves the registration prefix and uses only the Factory cookie. Rejected URLs raise `SourceHttpUrlError`; do not fall back to a source origin. Prefer explicit subpath imports over the package-root barrel. Use `/environmentHttp` only in lazy detail
code. Do not import another app's source or the private client-runtime
package. `FactoryRpcGroup` is separate from `WsRpcGroup`. Enrollment requires
transient `sourceCredential` input; public enrollment output has no secret.
Keep credentials out of query caches, mutation variables, logs, and URLs.
Source controls observe `factory.source.controlAuthorization` on the factory
connection. This read returns an operation admission or a typed denial, not
source credentials or access-management records. The shared relay policy
checks the factory caller, stored source grant, current lease, and freshness.
A source access-management subscription is not a control prerequisite.
Conversation rollback also needs the selected provider and active native
session to advertise rollback. Only a matching native
`thread.rollbackCompletedRequestId` confirms completion after the source rollback
effect succeeds. `rollbackRequestId` records acceptance only; provider timestamps,
ordinals, workspace events, and shell status do not prove completion. Older
servers without the optional completion marker cannot confirm rollback.
**Resume queued runs** releases held queued
runs only; it does not resume an interrupted provider turn. An uncertain
command stays blocked until a matching source update confirms its outcome;
do not send it again with a new command ID.

## One-origin development proxy and pairing

Set `FACTORY_UPSTREAM` to the factory server origin, for example
`http://localhost:3773`. Use the actual factory port. This is a server-side
Vite proxy setting. Do not put a path, credential, query, or fragment in it.
Do not set browser API or WebSocket host URLs.

Vite proxies `/ws`, `/api`, `/factory/bootstrap`, `/factory/env`, `/oauth`, and
`/.well-known` to this origin. `/ws` and `/factory/env` support WebSocket upgrades.
Factory UI paths and assets stay on Vite; there is no broad `/factory` proxy.
Browser requests use relative paths. The socket uses the current browser origin and cookie.
The one-attempt transport first checks `/api/auth/session`, reads the
environment descriptor for the required WebSocket upgrade protocol parameter,
then requests `server.getConfig` before it reports readiness. It checks the
factory capability and installed factory protocol. The U2 connection owner
controls scope lifetime, retries, and stream leases; the transport does not
reconnect or retry mutations. A failed source read stream offers an explicit
**Retry source connection** in the session pane. It replaces only that source's
shared read session; native command uncertainty remains owned by the Factory
connection, and commands are never replayed. Source authorization loss closes
leases and cancels/evicts that source's protected detail caches. Ordinary offline
or stale sources retain stale data. Blocked access requires repair/re-enrollment
in Nodes, not a read retry.

The project tree sorts loaded summaries locally by its existing name, state,
source, and updated headers (name ascending by default). Header activation toggles
ascending/descending; project membership and source-composite tie order are
preserved. Sorting is presentation-only and is not persisted.

Open the canonical factory `/pair` page on the same host as the Vite page,
using the factory port. For a LAN browser, use `http://<lan-host>:<factory-port>/pair`,
not localhost. Pair there. Return to the Vite page on that host,
and select **Retry**. Cookies apply across ports on the same host. Do not mix
`localhost` and `127.0.0.1`. The auth gate opens that canonical page in another
tab. Vite exposes only the factory port from `FACTORY_UPSTREAM` in development.
The link keeps the browser host and scheme; the proxy target hostname never
becomes a browser URL. The canonical backend port must be reachable from the
browser. For a single public HTTPS origin, use the production mount below.
Vite does not proxy pairing HTML into its asset or SPA routes. Do not configure
a pairing token URL. Phase 1 uses the paired factory connection for enrollment, source status, the live project/session overview, project groups, memberships, and favorites. These are Factory metadata; project and thread content stays on each source. The `/factory/env/<registration>/` prefix carries the source WebSocket and the fixed HTTP detail/media inventory. Phase 2 covers native detail and actions through that relay. Phase 3 covers the public embedded-route RPC, parent/child handshake helpers, signed root-relative assets, and attachment upload grants through the same origin. The automated gate starts production source and factory servers and uses this client's real connection and lease owners. Its injected message boundary does not mount React or a browser iframe, and it does not prove a rendered live thread. Use an authorized browser pass when changing rendered chat or responsive layout.

## Production serving

Run `vp run build:factory` from the repository root, then start T3 Code with
`node apps/server/dist/bin.mjs serve --factory`.
Installed distributions use `t3 serve --factory`.
`--factory-ui-dir /absolute/path/to/custom/dist` remains an optional override
for a separately deployed custom build, not a normal startup requirement.
The production asset base is `/factory/`; development keeps the Vite root.
The server hosts Factory at `/factory` and keeps T3 at `/`, with T3 assets
at `/assets` and authorization at `/pair`. The bootstrap response contains only `pairingUrl`.

A same-origin reverse proxy can serve the same build at `/factory/` instead.
Route `/ws`, `/api`, `/factory/bootstrap`, `/factory/env`, `/oauth`, and
`/.well-known` to the factory server before any Factory static/SPA fallback.
Preserve `/pair` and `/assets` on T3, and enable WebSocket upgrades on `/ws`
and factory relay routes. Keep HTTP asset, upload, bounded snapshot, and history traffic on this same origin. Embedded chat must not load a source origin or pass source credentials to the browser. Forward the public Host, or `X-Forwarded-Host` and
`X-Forwarded-Proto`, so bootstrap returns the external origin. Never use the
Factory SPA as a fallback for reserved API or relay routes.

Production pairing uses the browser origin's `/pair`; no development upstream
is embedded in the production bundle. Do not add cross-origin cookie access,
a new pairing form, or a browser-to-source network fallback.

## Automated production detail gate

From the repository root, run
`vp test run apps/server/src/factory/Factory.integration.test.ts`.
The in-repository gate runs without `T3_FACTORY_UI_CHECKOUT`. It starts two production
source servers and one factory server on ephemeral loopback ports with scoped
temporary homes. Only external provider drivers are controlled. It starts
`apps/factory/src/factory/testkit/runProductionGate.ts` directly under Node with the workspace's `tsx`, so
its milestone pipe does not collide with Vitest worker IPC. The client uses
the shared workspace contracts and a cookie-enabled Node WebSocket.
It does not start a browser or a development server.

The producer supplies `T3_FACTORY_GATE_INPUT`; do not
save or log that input, which contains test cookies. Command completion is
verified with native events and the effect worker drain, not sleeps or polling.
The normal scoped UI suite also verifies Windows drive/UNC source-root shapes
through typed native wire fixtures; it does not run a Windows source host.
