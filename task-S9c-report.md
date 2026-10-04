# S9c round 1 review fixes

Baseline: `d1e600aaa`. Verified with Node `v24.14.0`.
The workspace had no pre-existing `task-S9c-brief.md` or `task-S9c-report.md`.

## Approved project-list route

The approved session artifact `2026-10-03-t3-serve-factory-plan.md`, S9a lines 560-562, explicitly says:

> Allow explicit source methods for bounded thread detail, projects list/read, VCS status, diffs, checkpoints, terminal attach/events, launch, and dispatch. Use S9c fixed HTTP routes for history/snapshots.

This is a policy-key distinction, not permission to relay an arbitrary path:

- `apps/server/src/factory/RelayPolicy.ts:108-113` defines `GET /api/projects` as `factory:read`, source `orchestration:read`, and `action: false`.
- `apps/server/src/factory/RelayPolicy.test.ts:117-129` verifies only declared source WsRPC methods are admitted and rejects `projects.list`, which is not the source RPC method (`projects.listEntries` is).
- `packages/contracts/src/factoryRelayUrl.ts` includes only the exact `/api/projects` source route; its resolver test and `apps/server/src/factory/http.test.ts` exercise that route.

Decision: retain `/api/projects`. S9c's abbreviated detail-route checklist does not revoke S9a's explicit project-list/read authorization. No HTTP architecture changed.

## Renewal fixture fix

Before the fix, the full web typecheck failed at the unhandled shared `renew` endpoint:

```text
test/environmentHttpTest.ts(85,11): error TS2322: Type 'Handlers<EnvironmentAuthenticatedAuth, EndpointMap<HttpApiEndpoint<"browserSession", "POST", "/api/auth/browser-session", never, never, toCodecJson<Struct<{ readonly credential: decodeTo<String, String, never, never>; }>>, ... 4 more ..., never> | ... 9 more ... | HttpApiEndpoint<...>>, "browserSession" | ... 8 more...' is not assignable to type '"Endpoint not handled: renew"'.
```

The new HTTP regression test first failed because the fixture had no renewal route:

```text
HttpServerError: RouteNotFound (POST /api/auth/renew)
```

The fixture now matches the real endpoint's supported authorization scheme and `EnvironmentAuthInvalidError` response contract. Missing/empty or unsupported-scheme authorization produces `401 missing_credential`; an accepted-scheme credential presented with the fixture's browser-cookie principal produces `401 invalid_credential`. There is no fabricated successful renewal token. The regression checks both decoded contract errors.

## Final verification

Focused tests ran under Node `v24.14.0`:

```text
./node_modules/.bin/vp test run apps/web/test/environmentHttpTest.test.ts apps/web/src/authBootstrap.test.ts apps/web/src/environments/primary/bootstrap.test.ts apps/server/src/auth/http.test.ts packages/contracts/src/environmentHttp.test.ts packages/client-runtime/src/state/environmentHttpAuth.test.ts packages/contracts/src/factoryRelayUrl.test.ts apps/server/src/factory/http.test.ts
```

```text
Test Files  8 passed (8)
Tests       111 passed (111)
Start at    03:19:51
Duration    4.36s
```

Scoped typechecks all exited 0:

- `./node_modules/.bin/vp run --filter @t3tools/web typecheck` — `tsc --noEmit`, no diagnostics.
- `./node_modules/.bin/vp run --filter t3 typecheck` — `tsc --noEmit`, no errors; TypeScript suggestions emitted.
- `./node_modules/.bin/vp run --filter @t3tools/client-runtime typecheck` — `tsc --noEmit`, no errors; TypeScript suggestions emitted.

Scoped web lint and format checks exited 0: `./node_modules/.bin/vp lint --report-unused-disable-directives apps/web/test/environmentHttpTest.ts apps/web/test/environmentHttpTest.test.ts` and `./node_modules/.bin/vp fmt --check apps/web/test/environmentHttpTest.ts apps/web/test/environmentHttpTest.test.ts` (`All matched files use the correct format.`).
