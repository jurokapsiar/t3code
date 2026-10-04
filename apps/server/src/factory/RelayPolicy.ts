import {
  FactoryRegistrationId,
  FactoryControlDenialReason,
  type FactoryControlOperation,
  type FactoryControlAdmission,
  ORCHESTRATION_PROTOCOL_VERSION,
  type AuthEnvironmentScope,
  type ExecutionEnvironmentCapabilities,
  FactoryRemoteTarget,
  type OrchestrationV2Command,
  type ProjectMutation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as Config from "../config.ts";
import * as Connections from "./Connections.ts";
import * as SourceShell from "./SourceShell.ts";

const isRegistrationId = Schema.is(FactoryRegistrationId);
const isRemoteTarget = Schema.is(FactoryRemoteTarget);

const DenialReason = FactoryControlDenialReason;
type DenialReason = typeof DenialReason.Type;

export class RelayDenied extends Schema.TaggedError<RelayDenied>()("RelayDenied", {
  reason: DenialReason,
}) {
  override get message(): string {
    return `The source relay denied this request: ${this.reason}.`;
  }
}

interface RelayRule {
  readonly factoryScope: "factory:read" | "factory:control" | "factory:admin";
  readonly sourceScope: AuthEnvironmentScope;
  readonly action: boolean;
  readonly capability?: keyof ExecutionEnvironmentCapabilities;
}

const rpc = (
  method: keyof typeof RPC_REQUIRED_SCOPES,
  factoryScope: RelayRule["factoryScope"],
  action = factoryScope !== "factory:read",
): RelayRule => ({
  factoryScope,
  sourceScope: requiredScopeForRpcMethod(method),
  action,
});

/** Static opt-in list. New source RPCs do not gain relay access automatically. */
export const relayPolicy = {
  "server.getConfig": rpc("server.getConfig", "factory:read"),
  subscribeServerConfig: rpc("subscribeServerConfig", "factory:read"),
  "server.getSettings": rpc("server.getSettings", "factory:read"),
  "server.updateSettings": rpc("server.updateSettings", "factory:admin"),
  "server.getUsageSummary": rpc("server.getUsageSummary", "factory:read"),
  "orchestration.subscribeShell": rpc("orchestration.subscribeShell", "factory:read"),
  "orchestration.subscribeThread": rpc("orchestration.subscribeThread", "factory:read"),
  "orchestration.getWorkflowScript": rpc("orchestration.getWorkflowScript", "factory:read"),
  "orchestration.getTurnDiff": rpc("orchestration.getTurnDiff", "factory:read"),
  "orchestration.getFullThreadDiff": rpc("orchestration.getFullThreadDiff", "factory:read"),
  "orchestration.launchThread": rpc("orchestration.launchThread", "factory:control"),
  "orchestration.dispatchCommand": rpc("orchestration.dispatchCommand", "factory:control"),
  "projects.listEntries": rpc("projects.listEntries", "factory:read"),
  "projects.readFile": rpc("projects.readFile", "factory:read"),
  "projects.searchContents": rpc("projects.searchContents", "factory:read"),
  "projects.searchEntries": rpc("projects.searchEntries", "factory:read"),
  "projects.mutate": rpc("projects.mutate", "factory:control"),
  "vcs.refreshStatus": rpc("vcs.refreshStatus", "factory:read"),
  subscribeVcsStatus: rpc("subscribeVcsStatus", "factory:read"),
  "vcs.listRefs": rpc("vcs.listRefs", "factory:read"),
  "review.getDiffPreview": rpc("review.getDiffPreview", "factory:read"),
  "review.getDiffFileContents": rpc("review.getDiffFileContents", "factory:read"),
  "terminal.attach": rpc("terminal.attach", "factory:read"),
  subscribeTerminalEvents: rpc("subscribeTerminalEvents", "factory:read"),
  subscribeTerminalMetadata: rpc("subscribeTerminalMetadata", "factory:read"),
  "terminal.open": rpc("terminal.open", "factory:control"),
  "terminal.write": rpc("terminal.write", "factory:control"),
  "terminal.resize": rpc("terminal.resize", "factory:control"),
  "terminal.clear": rpc("terminal.clear", "factory:control"),
  "terminal.restart": rpc("terminal.restart", "factory:control"),
  "terminal.close": rpc("terminal.close", "factory:control"),
  "assets.createUrl": rpc("assets.createUrl", "factory:read"),
  "attachments.createUploadUrl": {
    ...rpc("attachments.createUploadUrl", "factory:control"),
    capability: "attachmentUploads",
  },
} as const satisfies Partial<Record<keyof typeof RPC_REQUIRED_SCOPES, RelayRule>>;

// These keys name source routes, not arbitrary forwarding roots. S9c must match
// the exact route and verb before passing its key to the shared authorization.
export const relayHttpPolicy = {
  "GET /api/projects": {
    factoryScope: "factory:read",
    sourceScope: "orchestration:read",
    action: false,
  },
  "GET /api/orchestration/threads/:threadId": {
    factoryScope: "factory:read",
    sourceScope: "orchestration:read",
    action: false,
  },
  "GET /api/orchestration/threads/:threadId/bounded": {
    factoryScope: "factory:read",
    sourceScope: "orchestration:read",
    action: false,
  },
  "GET /api/orchestration/threads/:threadId/history": {
    factoryScope: "factory:read",
    sourceScope: "orchestration:read",
    action: false,
  },
  "GET /api/assets/*": {
    factoryScope: "factory:read",
    sourceScope: "orchestration:read",
    action: false,
  },
  "HEAD /api/assets/*": {
    factoryScope: "factory:read",
    sourceScope: "orchestration:read",
    action: false,
  },
  "POST /api/attachments/upload/*": {
    factoryScope: "factory:control",
    sourceScope: "orchestration:operate",
    action: true,
    capability: "attachmentUploads",
  },
} as const satisfies Record<string, RelayRule>;

type OperationRule = { readonly capability?: keyof ExecutionEnvironmentCapabilities };
// The native dispatch RPC requires orchestration:operate for every command,
// including visit/read markers. There are no read-authorized dispatch tags.
const dispatchOperations = {
  "thread.create": {},
  "thread.archive": {},
  "thread.unarchive": {},
  "thread.delete": {},
  "thread.settle": { capability: "threadSettlement" },
  "thread.unsettle": { capability: "threadSettlement" },
  "thread.snooze": { capability: "threadSnooze" },
  "thread.unsnooze": { capability: "threadSnooze" },
  "thread.auto-settle.set": { capability: "threadAutoSettleOptOut" },
  "thread.pin": { capability: "threadPinning" },
  "thread.unpin": { capability: "threadPinning" },
  "thread.pin.reorder": { capability: "threadPinReorder" },
  "thread.active.reorder": { capability: "threadActiveReorder" },
  "thread.metadata.update": {},
  "thread.runtime-mode.set": {},
  "thread.interaction-mode.set": {},
  "thread.model-selection.set": {},
  "provider-session.detach": {},
  "message.dispatch": {},
  "run.interrupt": {},
  "queued-message.promote-to-steer": {},
  "queue.resume": {},
  "queued-run.reorder": {},
  "queued-run.cancel": {},
  "queued-run.edit": {},
  "runtime-request.respond": {},
  "thread.user-input.dismiss": {},
  "checkpoint.rollback": {},
  "thread.fork": {},
  "thread.merge_back": {},
  "provider.switch": {},
} as const satisfies Partial<Record<OrchestrationV2Command["type"], OperationRule>>;

const projectOperations = {
  "project.create": {},
  "project.update": {},
  "project.delete": {},
} as const satisfies Record<ProjectMutation["type"], OperationRule>;

export const RELAY_ROUTE_PREFIX = "/factory/env/";
export const relayRoutePrefix = (registrationId: FactoryRegistrationId): string => {
  if (!isRegistrationId(registrationId) || registrationId === "." || registrationId === "..")
    throw new RelayDenied({ reason: "invalid-target" });
  return `${RELAY_ROUTE_PREFIX}${encodeURIComponent(registrationId)}/`;
};

interface Request {
  readonly method: string;
  readonly payload?: unknown;
  readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
}

type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenialReason };
const denied = (reason: DenialReason): Decision => ({ allowed: false, reason });
const ownRule = <T extends object>(rules: T, key: string): T[keyof T] | undefined =>
  Object.hasOwn(rules, key) ? rules[key as keyof T] : undefined;
const ruleFor = (method: string): RelayRule | undefined =>
  ownRule(relayPolicy, method) ?? ownRule(relayHttpPolicy, method);
const operationFor = (request: Request): OperationRule | undefined => {
  if (
    request.payload === null ||
    typeof request.payload !== "object" ||
    !("type" in request.payload) ||
    typeof request.payload.type !== "string"
  )
    return undefined;
  return ownRule(
    request.method === "projects.mutate" ? projectOperations : dispatchOperations,
    request.payload.type,
  );
};

/** Pure checks only. Transports must use the service for target, lease and freshness. */
export const authorizeRelayRequest = (
  input: Request & {
    readonly sourceScopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly synchronized: boolean;
    readonly capabilities?: ExecutionEnvironmentCapabilities;
  },
): Decision => {
  const rule = ruleFor(input.method);
  if (rule === undefined) return denied("method-not-allowed");
  const dispatch =
    input.method === "orchestration.dispatchCommand" || input.method === "projects.mutate";
  const operation = dispatch ? operationFor(input) : undefined;
  if (dispatch && operation === undefined) return denied("operation-not-allowed");
  if (!input.callerScopes.includes(rule.factoryScope)) return denied("scope-required");
  if (!input.sourceScopes?.includes(rule.sourceScope)) return denied("source-scope-required");
  if (rule.action && !input.synchronized) return denied("source-stale");
  const capability = operation?.capability ?? rule.capability;
  if (capability !== undefined && input.capabilities?.[capability] !== true)
    return denied("capability-required");
  if (
    input.method === "orchestration.subscribeThread" &&
    (input.payload === null ||
      typeof input.payload !== "object" ||
      !("acceptBoundedSnapshot" in input.payload) ||
      input.payload.acceptBoundedSnapshot !== true)
  )
    return denied("bounded-detail-required");
  return { allowed: true };
};

export class RelayPolicy extends Context.Service<
  RelayPolicy,
  {
    readonly observeControl: (input: {
      readonly target: FactoryRemoteTarget;
      readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly operation: FactoryControlOperation;
    }) => Effect.Effect<FactoryControlAdmission>;
    readonly authorize: (
      input: Request & { readonly target: FactoryRemoteTarget },
    ) => Effect.Effect<Connections.SourceAccess, RelayDenied>;
  }
>()("t3/factory/RelayPolicy") {}

const sourceDenial = (error: Connections.SourceFailure) =>
  new RelayDenied({
    reason:
      error.reason === "identity"
        ? "target-mismatch"
        : error.reason === "unavailable"
          ? "source-unavailable"
          : error.reason === "authentication"
            ? "source-authentication"
            : error.reason === "protocol"
              ? "source-protocol"
              : error.reason === "credential-store"
                ? "source-credential-store"
                : "source-transport",
  });

const make = Effect.gen(function* () {
  const settings = yield* Config.ServerConfig;
  const connections = yield* Connections.Connections;
  const shell = yield* SourceShell.SourceShell;
  const authorize = Effect.fnUntraced(function* (
    input: Request & { readonly target: FactoryRemoteTarget },
  ) {
    if (!settings.factoryEnabled) return yield* new RelayDenied({ reason: "feature-disabled" });
    const rule = ruleFor(input.method);
    if (rule === undefined) return yield* new RelayDenied({ reason: "method-not-allowed" });
    if (!input.callerScopes.includes(rule.factoryScope))
      return yield* new RelayDenied({ reason: "scope-required" });
    if (
      !isRemoteTarget(input.target) ||
      input.target.registrationId === "." ||
      input.target.registrationId === ".."
    )
      return yield* new RelayDenied({ reason: "invalid-target" });
    const access = yield* connections
      .resolveTarget(input.target)
      .pipe(Effect.mapError(sourceDenial));
    if (
      access.target.registrationId !== input.target.registrationId ||
      access.target.environmentId !== input.target.environmentId ||
      access.config.environment.environmentId !== input.target.environmentId
    )
      return yield* new RelayDenied({ reason: "target-mismatch" });
    if (
      access.config.environment.orchestrationProtocolVersion !== undefined &&
      access.config.environment.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION
    )
      return yield* new RelayDenied({ reason: "source-protocol" });
    yield* access.checkCurrent.pipe(Effect.mapError(sourceDenial));
    const synchronized = yield* shell.isSynchronized(access);
    const decision = authorizeRelayRequest({
      ...input,
      synchronized,
      sourceScopes: access.sourceScopes,
      capabilities: access.config.environment.capabilities,
    });
    if (!decision.allowed) return yield* new RelayDenied({ reason: decision.reason });
    return access;
  });
  const observeControl = Effect.fnUntraced(function* (input: {
    readonly target: FactoryRemoteTarget;
    readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly operation: FactoryControlOperation;
  }) {
    return yield* authorize({
      target: input.target,
      callerScopes: input.callerScopes,
      method:
        input.operation === "launch"
          ? "orchestration.launchThread"
          : "orchestration.dispatchCommand",
      ...(input.operation === "launch" ? {} : { payload: { type: input.operation } }),
    }).pipe(
      Effect.match({
        onSuccess: (): FactoryControlAdmission => ({ allowed: true }),
        onFailure: (error): FactoryControlAdmission => ({ allowed: false, reason: error.reason }),
      }),
    );
  });
  return RelayPolicy.of({ authorize, observeControl });
});

export const layer = Layer.effect(RelayPolicy, make);
