import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  FactoryRegistrationId,
  FactoryRemoteTarget,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as Config from "../config.ts";
import * as Connections from "./Connections.ts";
import * as SourceShell from "./SourceShell.ts";
import * as RelayPolicy from "./RelayPolicy.ts";
import { config } from "./testkit/sourceConfig.ts";

const target = FactoryRemoteTarget.make({
  registrationId: FactoryRegistrationId.make("source-a"),
  environmentId: EnvironmentId.make("env-a"),
});
const grants: ReadonlyArray<AuthEnvironmentScope> = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
];
const callerScopes: ReadonlyArray<AuthEnvironmentScope> = [
  "factory:read",
  "factory:control",
  "factory:admin",
];
const capabilities = ExecutionEnvironmentCapabilities.make({
  repositoryIdentity: true,
  connectionProbe: true,
  threadSettlement: true,
  attachmentUploads: true,
  questionAttachments: true,
  fileAttachments: { maxUploadBytes: 1024 },
  pullRequests: true,
  pullRequestChecks: true,
  inlineMessageContext: true,
  requiredWorktreeBootstrap: true,
  threadAutoSettlement: true,
  storageCleanup: true,
  projectWorktreeCleanup: true,
  threadRestartContinuation: true,
  projectSettingsOverrides: true,
  threadSnooze: true,
  environmentThemes: true,
  usageLimitSources: true,
  usagePriceOverrides: true,
  threadPinning: true,
  threadPinReorder: true,
  threadActiveReorder: true,
  threadAutoSettleOptOut: true,
  threadTitleRegeneration: true,
  threadVisitedTracking: true,
  threadPullRequestLinking: true,
  serverResolvedCommandContext: true,
  threadPullRequests: true,
  pullRequestStackActions: true,
  serverSelfUpdate: "boot-service",
  serverSelfUpdateProgress: true,
  serverUpdateThreadContinuation: true,
  agentActivityPublishing: true,
  projectCloneTracking: true,
  environmentIcon: true,
  desktopAppUpdate: true,
  factory: true,
  factoryRenewal: true,
  batchedReplay: true,
});
const noOptionalCapabilities = ExecutionEnvironmentCapabilities.make({ repositoryIdentity: false });
const authorize = (method: string, payload?: unknown, synchronized = true) =>
  RelayPolicy.authorizeRelayRequest({
    method,
    payload,
    callerScopes,
    sourceScopes: grants,
    synchronized,
    capabilities,
  });

it("requires terminal authority even for read visualization", () => {
  expect(RelayPolicy.relayPolicy["terminal.attach"].sourceScope).toBe("terminal:operate");
  expect(
    RelayPolicy.authorizeRelayRequest({
      method: "terminal.write",
      callerScopes: ["factory:read"],
      synchronized: true,
    }),
  ).toEqual({ allowed: false, reason: "scope-required" });
  expect(
    RelayPolicy.authorizeRelayRequest({
      method: "terminal.attach",
      callerScopes: ["factory:control"],
      sourceScopes: ["orchestration:read"],
      synchronized: false,
    }),
  ).toEqual({ allowed: false, reason: "source-scope-required" });
  expect(authorize("terminal.attach", {}, false)).toEqual({
    allowed: false,
    reason: "source-stale",
  });
  expect(authorize("subscribeTerminalEvents", {}, false)).toEqual({ allowed: true });
  expect(authorize("terminal.write", {}, false)).toEqual({
    allowed: false,
    reason: "source-stale",
  });
});

it.each([
  {},
  { cwd: "/workspace" },
  { env: { FACTORY_TEST: "value" } },
  { cols: 80 },
  { rows: 24 },
  { restartIfNotRunning: true },
])("denies read-only terminal attach before interpreting its fields: %s", (payload) => {
  expect(
    RelayPolicy.authorizeRelayRequest({
      method: "terminal.attach",
      payload: { threadId: "thread", terminalId: "existing", ...payload },
      callerScopes: ["factory:read"],
      sourceScopes: ["terminal:operate"],
      synchronized: true,
    }),
  ).toEqual({ allowed: false, reason: "scope-required" });
});

it("admits the native client's connection health probe as a read", () => {
  // The shared client probes a live session on wakeup when the source advertises
  // connectionProbe. Rejecting it closes the embedded chat's relay.
  expect(authorize("server.probe", {}, false)).toEqual({ allowed: true });
  expect(
    RelayPolicy.authorizeRelayRequest({
      method: "server.probe",
      payload: {},
      callerScopes: ["factory:read"],
      sourceScopes: [],
      synchronized: true,
    }),
  ).toEqual({ allowed: false, reason: "source-scope-required" });
});

it("only admits explicit methods declared by the actual source RPC group", () => {
  for (const [method, policy] of Object.entries(RelayPolicy.relayPolicy)) {
    expect(WsRpcGroup.requests.has(method)).toBe(true);
    expect(policy.sourceScope).toBe(requiredScopeForRpcMethod(method));
  }
  for (const method of [
    "unknown",
    "toString",
    "constructor",
    "__proto__",
    "projects.list",
    "provider.auth.start",
    "server.updateServer",
    "orchestration.getThreadProjection",
  ]) {
    expect(authorize(method)).toEqual({ allowed: false, reason: "method-not-allowed" });
  }
});

it.each([
  ["terminal.attach", "factory:control"],
  ["projects.readFile", "factory:read"],
  ["review.getDiffPreview", "factory:read"],
  ["orchestration.launchThread", "factory:control"],
  ["server.updateSettings", "factory:admin"],
] as const)("requires the exact factory scope for %s", (method, scope) => {
  for (const candidate of callerScopes) {
    expect(
      RelayPolicy.authorizeRelayRequest({
        method,
        callerScopes: [candidate],
        sourceScopes: grants,
        synchronized: true,
      }),
    ).toEqual(
      candidate === scope ? { allowed: true } : { allowed: false, reason: "scope-required" },
    );
  }
});

it("denies missing internal source grants, including review scopes", () => {
  expect(
    RelayPolicy.authorizeRelayRequest({
      method: "projects.readFile",
      callerScopes,
      synchronized: true,
    }),
  ).toEqual({ allowed: false, reason: "source-scope-required" });
  expect(
    RelayPolicy.authorizeRelayRequest({
      method: "review.getDiffPreview",
      callerScopes,
      sourceScopes: ["orchestration:read"],
      synchronized: true,
    }),
  ).toEqual({ allowed: false, reason: "source-scope-required" });
});

it("checks exact dispatch tags and never treats unknown commands as reads", () => {
  for (const payload of [
    undefined,
    {},
    { type: "unknown" },
    { type: "toString" },
    { type: "checkpoint.rollback.fail" },
    { type: "checkpoint.rollback.complete" },
    { type: "prepared-run.fail" },
    { type: "thread.auto-settle" },
    { operation: "message.dispatch" },
  ]) {
    expect(authorize("orchestration.dispatchCommand", payload)).toEqual({
      allowed: false,
      reason: "operation-not-allowed",
    });
  }
  for (const type of [
    "message.dispatch",
    "runtime-request.respond",
    "checkpoint.rollback",
    "run.interrupt",
    "thread.unsettle",
  ]) {
    const payload = { type, commandId: "unchanged", threadId: "same-local-id" };
    expect(authorize("orchestration.dispatchCommand", payload)).toEqual({ allowed: true });
    expect(authorize("orchestration.dispatchCommand", payload, false)).toEqual({
      allowed: false,
      reason: "source-stale",
    });
    expect(
      RelayPolicy.authorizeRelayRequest({
        method: "orchestration.dispatchCommand",
        payload,
        callerScopes: ["factory:read"],
        sourceScopes: grants,
        synchronized: true,
        capabilities,
      }),
    ).toEqual({ allowed: false, reason: "scope-required" });
  }
  expect(authorize("projects.mutate", { type: "project.update" })).toEqual({ allowed: true });
  expect(authorize("projects.mutate", { type: "project.read" })).toEqual({
    allowed: false,
    reason: "operation-not-allowed",
  });
});

it.each([true, false])(
  "keeps source inspection separate from control with optional capabilities=%s",
  (optional) => {
    const caps = optional ? capabilities : noOptionalCapabilities;
    for (const synchronized of [true, false]) {
      for (const method of [
        "vcs.refreshStatus",
        "subscribeVcsStatus",
        "vcs.listRefs",
        "review.getDiffFileContents",
        "orchestration.getTurnDiff",
        "orchestration.getFullThreadDiff",
        "server.getUsageSummary",
      ]) {
        expect(
          RelayPolicy.authorizeRelayRequest({
            method,
            callerScopes,
            sourceScopes: grants,
            synchronized,
            capabilities: caps,
          }),
        ).toEqual({ allowed: true });
      }
      expect(
        RelayPolicy.authorizeRelayRequest({
          method: "orchestration.dispatchCommand",
          payload: { type: "thread.settle" },
          callerScopes,
          sourceScopes: grants,
          synchronized,
          capabilities: caps,
        }),
      ).toEqual(
        !synchronized
          ? { allowed: false, reason: "source-stale" }
          : optional
            ? { allowed: true }
            : { allowed: false, reason: "capability-required" },
      );
      expect(
        RelayPolicy.authorizeRelayRequest({
          method: "orchestration.dispatchCommand",
          payload: { type: "checkpoint.rollback" },
          callerScopes,
          sourceScopes: grants,
          synchronized,
          capabilities: caps,
        }),
      ).toEqual(synchronized ? { allowed: true } : { allowed: false, reason: "source-stale" });
    }
  },
);

it("requires bounded thread subscription and leaves HTTP history under one fixed prefix", () => {
  expect(authorize("orchestration.subscribeThread", {})).toEqual({
    allowed: false,
    reason: "bounded-detail-required",
  });
  expect(
    authorize("orchestration.subscribeThread", { acceptBoundedSnapshot: true }, false),
  ).toEqual({ allowed: true });
  expect(RelayPolicy.relayRoutePrefix(target.registrationId)).toBe("/factory/env/source-a/");
  expect(RelayPolicy.relayRoutePrefix(FactoryRegistrationId.make("source/a"))).toBe(
    "/factory/env/source%2Fa/",
  );
  expect(() => RelayPolicy.relayRoutePrefix(FactoryRegistrationId.make(".."))).toThrow();
  expect(authorize("GET /api/orchestration/threads/:threadId/bounded", {}, false)).toEqual({
    allowed: true,
  });
  expect(authorize("GET /api/orchestration/threads/:threadId/history", {}, false)).toEqual({
    allowed: true,
  });
  expect(authorize("GET /api/auth/session")).toEqual({
    allowed: false,
    reason: "method-not-allowed",
  });
});

const policyConfigLayer = (enabled = true) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const base = yield* Config.ServerConfig;
      return Config.layer({ ...base, factoryEnabled: enabled });
    }),
  ).pipe(
    Layer.provide(
      Config.layerTest(process.cwd(), { prefix: "t3-relay-policy-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const policyLayer = (
  input: {
    synchronized?: boolean;
    unavailable?: boolean;
    wrongIdentity?: boolean;
    expiredLease?: boolean;
    enabled?: boolean;
    sourceScopes?: ReadonlyArray<AuthEnvironmentScope>;
    capabilities?: ExecutionEnvironmentCapabilities;
  } = {},
) => {
  const access: Connections.SourceAccess = {
    target: input.wrongIdentity
      ? { ...target, environmentId: EnvironmentId.make("replacement") }
      : target,
    connectionId: {},
    config: {
      ...config(),
      environment: {
        ...config().environment,
        capabilities: input.capabilities ?? noOptionalCapabilities,
      },
    },
    sourceScopes: input.sourceScopes ?? grants,
    checkCurrent: input.expiredLease
      ? Effect.fail(new Connections.SourceFailure({ reason: "authentication" }))
      : Effect.void,
    shell: () => Stream.never,
    closed: Effect.never,
    checkShellCurrent: Effect.void,
    shellSynchronized: Effect.void,
  };
  return RelayPolicy.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        policyConfigLayer(input.enabled ?? true),
        Layer.mock(Connections.Connections)({
          resolveTarget: (requested) =>
            input.unavailable
              ? Effect.fail(new Connections.SourceFailure({ reason: "unavailable" }))
              : requested.environmentId !== target.environmentId ||
                  requested.registrationId !== target.registrationId
                ? Effect.fail(new Connections.SourceFailure({ reason: "identity" }))
                : Effect.succeed(access),
        }),
        Layer.mock(SourceShell.SourceShell)({
          isSynchronized: () => Effect.succeed(input.synchronized ?? true),
        }),
      ),
    ),
  );
};

it.effect("reads stale source data but rechecks authoritative freshness after the lease", () =>
  Effect.gen(function* () {
    let synchronized = true;
    const access: Connections.SourceAccess = {
      target,
      connectionId: {},
      config: config(),
      sourceScopes: grants,
      checkCurrent: Effect.sync(() => {
        synchronized = false;
      }),
      shell: () => Stream.never,
      closed: Effect.never,
      checkShellCurrent: Effect.void,
      shellSynchronized: Effect.void,
    };
    const service = yield* RelayPolicy.RelayPolicy.pipe(
      Effect.provide(
        RelayPolicy.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Connections.Connections)({ resolveTarget: () => Effect.succeed(access) }),
              Layer.mock(SourceShell.SourceShell)({
                isSynchronized: () => Effect.sync(() => synchronized),
              }),
            ),
          ),
        ),
      ),
    );
    expect(
      yield* Effect.flip(service.authorize({ target, method: "terminal.write", callerScopes })),
    ).toMatchObject({ reason: "source-stale" });
    expect(
      (yield* service.authorize({ target, method: "projects.readFile", callerScopes })).target,
    ).toEqual(target);
  }).pipe(Effect.provide(policyConfigLayer())),
);

it.effect("resolves a composite target and returns its native source lease", () =>
  Effect.gen(function* () {
    const service = yield* RelayPolicy.RelayPolicy;
    const access = yield* service.authorize({ target, method: "terminal.write", callerScopes });
    expect(access.target).toEqual(target);
    expect(
      yield* Effect.flip(
        service.authorize({
          target: { ...target, environmentId: EnvironmentId.make("env-b") },
          method: "terminal.write",
          callerScopes,
        }),
      ),
    ).toMatchObject({ reason: "target-mismatch" });
    expect(
      yield* Effect.flip(
        service.authorize({
          target: { ...target, registrationId: FactoryRegistrationId.make("other") },
          method: "terminal.write",
          callerScopes,
        }),
      ),
    ).toMatchObject({ reason: "target-mismatch" });
  }).pipe(Effect.provide(policyLayer())),
);

it.effect.each([
  { options: { enabled: false }, reason: "feature-disabled" },
  { options: { unavailable: true }, reason: "source-unavailable" },
  { options: { wrongIdentity: true }, reason: "target-mismatch" },
  { options: { expiredLease: true }, reason: "source-authentication" },
  { options: { synchronized: false }, reason: "source-stale" },
  {
    options: { sourceScopes: ["orchestration:read"] as ReadonlyArray<AuthEnvironmentScope> },
    reason: "source-scope-required",
  },
] as const)("fails closed for %s", ({ options, reason }) =>
  Effect.gen(function* () {
    const service = yield* RelayPolicy.RelayPolicy;
    expect(
      yield* Effect.flip(service.authorize({ target, method: "terminal.write", callerScopes })),
    ).toMatchObject({ reason });
  }).pipe(Effect.provide(policyLayer(options))),
);

it.effect.each([true, false])(
  "authorizes fresh, stale and unavailable source leases with optional capabilities=%s",
  (optional) =>
    Effect.gen(function* () {
      const caps = optional ? capabilities : noOptionalCapabilities;
      for (const state of ["fresh", "stale", "blocked"] as const) {
        yield* Effect.gen(function* () {
          const policy = yield* RelayPolicy.RelayPolicy;
          const request = { target, callerScopes };
          const inspection = yield* Effect.exit(
            policy.authorize({ ...request, method: "terminal.attach" }),
          );
          if (state === "blocked") {
            expect(inspection).toMatchObject({ _tag: "Failure" });
            expect(
              yield* Effect.flip(policy.authorize({ ...request, method: "terminal.write" })),
            ).toMatchObject({ reason: "source-unavailable" });
          } else {
            expect(inspection).toMatchObject(
              state === "stale" ? { _tag: "Failure" } : { _tag: "Success", value: { target } },
            );
            if (state === "stale") {
              expect(
                yield* Effect.flip(policy.authorize({ ...request, method: "terminal.write" })),
              ).toMatchObject({ reason: "source-stale" });
            } else {
              expect(
                (yield* policy.authorize({ ...request, method: "terminal.write" })).target,
              ).toEqual(target);
            }
          }
        }).pipe(
          Effect.provide(
            policyLayer({
              capabilities: caps,
              synchronized: state === "fresh",
              unavailable: state === "blocked",
            }),
          ),
        );
      }
    }),
);

it("gates signed upload grants but not signed asset inspection on freshness and capabilities", () => {
  for (const caps of [capabilities, noOptionalCapabilities]) {
    for (const synchronized of [true, false]) {
      expect(
        RelayPolicy.authorizeRelayRequest({
          method: "GET /api/assets/*",
          callerScopes,
          sourceScopes: grants,
          synchronized,
          capabilities: caps,
        }),
      ).toEqual({ allowed: true });
      expect(
        RelayPolicy.authorizeRelayRequest({
          method: "POST /api/attachments/upload/*",
          callerScopes,
          sourceScopes: grants,
          synchronized,
          capabilities: caps,
        }),
      ).toEqual(
        !synchronized
          ? { allowed: false, reason: "source-stale" }
          : caps.attachmentUploads === true
            ? { allowed: true }
            : { allowed: false, reason: "capability-required" },
      );
    }
  }
});

it.effect.each([
  { scopes: ["factory:read", "factory:control"], options: {}, expected: { allowed: true } },
  { scopes: ["factory:read"], options: {}, expected: { allowed: false, reason: "scope-required" } },
  {
    scopes: ["factory:read", "factory:control"],
    options: { sourceScopes: ["orchestration:read"] },
    expected: { allowed: false, reason: "source-scope-required" },
  },
  {
    scopes: ["factory:read", "factory:control"],
    options: { synchronized: false },
    expected: { allowed: false, reason: "source-stale" },
  },
  {
    scopes: ["factory:read", "factory:control"],
    options: { expiredLease: true },
    expected: { allowed: false, reason: "source-authentication" },
  },
] as const)(
  "observes control admission through the authoritative service: %s",
  ({ scopes, options, expected }) =>
    Effect.gen(function* () {
      const policy = yield* RelayPolicy.RelayPolicy;
      expect(
        yield* policy.observeControl({
          target,
          callerScopes: scopes,
          operation: "message.dispatch",
        }),
      ).toEqual(expected);
    }).pipe(Effect.provide(policyLayer(options))),
);
