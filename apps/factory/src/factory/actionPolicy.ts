import type { FactoryThreadKey, FactoryThreadSummary } from "@t3tools/contracts/factory";
import { targetKey } from "./queryKeys";
import type { BoundedSnapshot } from "./sourceDetailApi";
import type * as Effect from "effect/Effect";
import type { SourceLease, SourceRpcClient } from "./sourceSessions";

export interface SourceControlState {
  readonly online: boolean;
  readonly synchronized: boolean;
  readonly allowed: boolean;
}

export function canControlSource({ online, synchronized, allowed }: SourceControlState): boolean {
  return online && synchronized && allowed;
}

export type SourceActionKind = "prompt" | "interrupt" | "resume" | "settle" | "unsettle";

export interface SourceActionEvidence {
  readonly snapshotSequence: number;
  readonly sourceStatus: FactoryThreadSummary["sourceStatus"];
  readonly settled: boolean;
  readonly hasActiveRun: boolean;
  readonly userMessageIds: readonly string[];
  readonly runs?: readonly {
    readonly id: string;
    readonly status: string;
    readonly queueHeld?: boolean;
  }[];
}

export function isSourceActionCompleted(
  action: {
    readonly kind: SourceActionKind;
    readonly acceptedSequence: number;
    readonly messageId?: string;
    readonly previousSourceStatus: FactoryThreadSummary["sourceStatus"];
    readonly previousSettled: boolean;
    readonly heldRunIds?: readonly string[];
    readonly runId?: string;
  },
  evidence: SourceActionEvidence,
): boolean {
  if (evidence.snapshotSequence < action.acceptedSequence) return false;
  switch (action.kind) {
    case "prompt":
      return action.messageId !== undefined && evidence.userMessageIds.includes(action.messageId);
    case "interrupt":
      return (
        action.runId !== undefined &&
        evidence.runs?.some(
          (run) =>
            run.id === action.runId && (run.status === "interrupted" || run.status === "cancelled"),
        ) === true
      );
    case "resume":
      return (
        action.heldRunIds !== undefined &&
        action.heldRunIds.length > 0 &&
        action.heldRunIds.every(
          (id) =>
            evidence.runs?.some(
              (run) =>
                run.id === id &&
                run.queueHeld === false &&
                run.status !== "cancelled" &&
                run.status !== "failed" &&
                run.status !== "interrupted",
            ) === true,
        )
      );
    case "settle":
      return !action.previousSettled && evidence.settled;
    case "unsettle":
      return action.previousSettled && !evidence.settled;
  }
}

type RollbackSnapshotEvidence = {
  readonly snapshotSequence: number;
  readonly sourceStatus: FactoryThreadSummary["sourceStatus"];
  readonly projection: {
    readonly thread: {
      readonly rollbackRequestId?: string | null;
      readonly rollbackCompletedRequestId?: string;
    };
  };
};

export function isRollbackCompleted(
  action: {
    readonly commandId: string;
    readonly acceptedSequence: number;
    readonly previousStatus: FactoryThreadSummary["sourceStatus"];
  },
  snapshot: RollbackSnapshotEvidence,
): boolean {
  return (
    snapshot.snapshotSequence > action.acceptedSequence &&
    snapshot.projection.thread.rollbackRequestId === action.commandId &&
    snapshot.projection.thread.rollbackCompletedRequestId === action.commandId
  );
}

export class SourceCommandUnavailableError extends Error {
  constructor(reason: "offline" | "not synchronized" | "not authorized" | "not supported") {
    super(`Source control is unavailable: the source is ${reason}.`);
    this.name = "SourceCommandUnavailableError";
  }
}

export class SourceCommandRejectedError extends Error {
  readonly commandId: string;

  constructor(commandId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "The source rejected the command.";
    super(`The source rejected command ${commandId}: ${detail}`, { cause });
    this.name = "SourceCommandRejectedError";
    this.commandId = commandId;
  }
}

export class SourceCommandUncertainError extends Error {
  readonly commandId: string;

  constructor(commandId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "The source did not return a result.";
    super(`The result of command ${commandId} is uncertain: ${detail} Do not retry it.`, { cause });
    this.name = "SourceCommandUncertainError";
    this.commandId = commandId;
  }
}

function isDefinitiveSourceRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return (
    error._tag === "EnvironmentAuthorizationError" || error._tag === "EnvironmentScopeRequiredError"
  );
}

export type SourceDispatchCommand = Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0];
export type SourceCommandId = SourceDispatchCommand["commandId"];
export type SourceMessageId = Extract<
  SourceDispatchCommand,
  { readonly type: "message.dispatch" }
>["messageId"];
export type SourceThreadId = NonNullable<
  Parameters<SourceRpcClient["orchestration.launchThread"]>[0]["threadId"]
>;

export type SourceActionScope =
  | {
      readonly type: "thread";
      readonly factoryId: string;
      readonly environmentId: string;
      readonly threadId: string;
    }
  | {
      readonly type: "launch";
      readonly factoryId: string;
      readonly environmentId: string;
      readonly projectId: string;
    };

export function sourceActionScopeKey(scope: SourceActionScope): string {
  return JSON.stringify(
    scope.type === "thread"
      ? [scope.type, scope.factoryId, scope.environmentId, scope.threadId]
      : [scope.type, scope.factoryId, scope.environmentId, scope.projectId],
  );
}

export type SourceActionIntent =
  | { readonly kind: "prompt"; readonly messageId: string }
  | { readonly kind: "interrupt"; readonly runId: string }
  | { readonly kind: "resume"; readonly heldRunIds: readonly string[] }
  | { readonly kind: "settle" | "unsettle"; readonly previousSettled: boolean }
  | { readonly kind: "runtime-response"; readonly requestId: string }
  | {
      readonly kind: "rollback";
      readonly checkpointId: string;
      readonly previousStatus: FactoryThreadSummary["sourceStatus"];
    }
  | { readonly kind: "launch"; readonly target: FactoryThreadKey };

export interface SourceActionRecord {
  readonly commandId: string;
  readonly intent: SourceActionIntent;
  readonly phase: "sending" | "accepted" | "uncertain" | "confirmed" | "failed" | "rejected";
  /** Accepted sequence, confirming snapshot sequence, or the last snapshot sequence before an uncertain send. */
  readonly sequence: number;
}

/** Authoritative source state. Pass it only when the snapshot is fresh and complete. */
export type SourceActionObservation =
  | {
      readonly type: "thread";
      readonly snapshotSequence: number;
      readonly sourceStatus: FactoryThreadSummary["sourceStatus"];
      readonly settled: boolean;
      readonly userMessageIds: readonly string[];
      readonly runs: readonly {
        readonly id: string;
        readonly status: string;
        readonly queueHeld?: boolean;
      }[];
      readonly runtimeRequests: readonly { readonly id: string; readonly status: string }[];
      readonly rollbackRequestId: string | null;
      readonly rollbackFailureRequestId: string | undefined;
      readonly rollbackCompletedRequestId?: string;
    }
  | { readonly type: "overview"; readonly threadKeys: ReadonlySet<string> };

export function threadActionObservation(
  snapshot: Pick<BoundedSnapshot, "snapshotSequence" | "projection">,
  thread: Pick<FactoryThreadSummary, "sourceStatus" | "settled">,
): SourceActionObservation {
  const { projection } = snapshot;
  return {
    type: "thread",
    snapshotSequence: snapshot.snapshotSequence,
    sourceStatus: thread.sourceStatus,
    settled: thread.settled,
    userMessageIds: projection.visibleTurnItems.flatMap(({ item }) =>
      item.type === "user_message" ? [item.messageId] : [],
    ),
    runs: projection.runs,
    runtimeRequests: projection.runtimeRequests,
    rollbackRequestId: projection.thread.rollbackRequestId ?? null,
    rollbackFailureRequestId: projection.thread.rollbackFailure?.requestId,
    rollbackCompletedRequestId: projection.thread.rollbackCompletedRequestId,
  };
}

/** A sending or uncertain command blocks new commands for its scope. An accepted launch blocks until the overview shows it. */
export function isBlockingSourceAction(record: SourceActionRecord): boolean {
  return (
    record.phase === "sending" ||
    record.phase === "uncertain" ||
    (record.phase === "accepted" && record.intent.kind === "launch")
  );
}

export function resolveSourceAction(
  record: SourceActionRecord,
  observation: SourceActionObservation,
): "confirmed" | "failed" | undefined {
  if (record.phase !== "accepted" && record.phase !== "uncertain") return undefined;
  const intent = record.intent;
  if (intent.kind === "launch") {
    return observation.type === "overview" && observation.threadKeys.has(targetKey(intent.target))
      ? "confirmed"
      : undefined;
  }
  if (observation.type !== "thread") return undefined;
  if (
    record.phase === "uncertain"
      ? observation.snapshotSequence <= record.sequence
      : observation.snapshotSequence < record.sequence
  )
    return undefined;
  switch (intent.kind) {
    case "runtime-response":
      return observation.runtimeRequests.some(
        (request) => request.id === intent.requestId && request.status !== "pending",
      )
        ? "confirmed"
        : undefined;
    case "rollback":
      if (observation.rollbackFailureRequestId === record.commandId) return "failed";
      return isRollbackCompleted(
        {
          commandId: record.commandId,
          acceptedSequence: record.sequence,
          previousStatus: intent.previousStatus,
        },
        {
          snapshotSequence: observation.snapshotSequence,
          sourceStatus: observation.sourceStatus,
          projection: {
            thread: {
              rollbackRequestId: observation.rollbackRequestId,
              rollbackCompletedRequestId: observation.rollbackCompletedRequestId,
            },
          },
        },
      )
        ? "confirmed"
        : undefined;
    default:
      return isSourceActionCompleted(
        {
          kind: intent.kind,
          acceptedSequence: record.sequence,
          previousSourceStatus: observation.sourceStatus,
          previousSettled:
            intent.kind === "settle" || intent.kind === "unsettle"
              ? intent.previousSettled
              : observation.settled,
          ...(intent.kind === "prompt" ? { messageId: intent.messageId } : {}),
          ...(intent.kind === "interrupt" ? { runId: intent.runId } : {}),
          ...(intent.kind === "resume" ? { heldRunIds: intent.heldRunIds } : {}),
        },
        { ...observation, hasActiveRun: false },
      )
        ? "confirmed"
        : undefined;
  }
}

const resolvedHistoryLimit = 8;

function isResolvedSourceAction(record: SourceActionRecord): boolean {
  return record.phase === "confirmed" || record.phase === "failed" || record.phase === "rejected";
}
const noRecords: readonly SourceActionRecord[] = [];

/**
 * Owns native source commands for one factory connection. Records outlive views, source leases,
 * and connection attempts. Only `clear()` (factory stop or authentication loss) drops them.
 */
export class SourceActionRegistry {
  private readonly scopes = new Map<
    string,
    { readonly scope: SourceActionScope; readonly records: readonly SourceActionRecord[] }
  >();
  private readonly sentCommandIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly records = (scopeKey: string): readonly SourceActionRecord[] =>
    this.scopes.get(scopeKey)?.records ?? noRecords;

  blocking(scope: SourceActionScope): SourceActionRecord | undefined {
    return this.records(sourceActionScopeKey(scope)).find(isBlockingSourceAction);
  }

  async dispatch<Result>(input: {
    readonly scope: SourceActionScope;
    readonly commandId: string;
    readonly intent: SourceActionIntent;
    readonly baseSequence: number;
    readonly state: SourceControlState;
    readonly request: (commandId: string) => Promise<Result>;
  }): Promise<Result> {
    const blocking = this.blocking(input.scope);
    if (blocking !== undefined)
      throw new SourceCommandUncertainError(
        blocking.commandId,
        new Error("Wait until the source confirms the earlier command."),
      );
    if (!input.state.online) throw new SourceCommandUnavailableError("offline");
    if (!input.state.synchronized) throw new SourceCommandUnavailableError("not synchronized");
    if (!input.state.allowed) throw new SourceCommandUnavailableError("not authorized");
    const sentKey = JSON.stringify([
      input.scope.factoryId,
      input.scope.environmentId,
      input.commandId,
    ]);
    if (this.sentCommandIds.has(sentKey)) {
      throw new Error(
        `Command ${input.commandId} has already been sent. Check the source before trying again.`,
      );
    }
    this.sentCommandIds.add(sentKey);
    const generation = this.generation;
    const key = sourceActionScopeKey(input.scope);
    const settle = (phase: SourceActionRecord["phase"], sequence: number) => {
      if (generation === this.generation)
        this.put(input.scope, key, {
          commandId: input.commandId,
          intent: input.intent,
          phase,
          sequence,
        });
    };
    this.put(input.scope, key, {
      commandId: input.commandId,
      intent: input.intent,
      phase: "sending",
      sequence: input.baseSequence,
    });
    try {
      const result = await input.request(input.commandId);
      settle(
        "accepted",
        typeof result === "object" &&
          result !== null &&
          "sequence" in result &&
          typeof result.sequence === "number"
          ? result.sequence
          : input.baseSequence,
      );
      return result;
    } catch (cause) {
      if (isDefinitiveSourceRejection(cause)) {
        settle("rejected", input.baseSequence);
        throw new SourceCommandRejectedError(input.commandId, cause);
      }
      settle("uncertain", input.baseSequence);
      throw new SourceCommandUncertainError(input.commandId, cause);
    }
  }

  /** Applies authoritative evidence. Overview evidence reaches every launch scope of the factory. */
  reconcile(scope: SourceActionScope, observation: SourceActionObservation): void {
    const targets =
      observation.type === "overview"
        ? [...this.scopes.entries()].filter(
            ([, entry]) =>
              entry.scope.type === "launch" && entry.scope.factoryId === scope.factoryId,
          )
        : [[sourceActionScopeKey(scope), this.scopes.get(sourceActionScopeKey(scope))] as const];
    for (const [key, entry] of targets) {
      if (entry === undefined) continue;
      for (const record of entry.records) {
        const outcome = resolveSourceAction(record, observation);
        if (outcome === undefined) continue;
        this.put(entry.scope, key, {
          ...record,
          phase: outcome,
          sequence: observation.type === "thread" ? observation.snapshotSequence : record.sequence,
        });
      }
    }
  }

  clear(): void {
    this.generation += 1;
    this.scopes.clear();
    this.sentCommandIds.clear();
    this.emit();
  }

  private put(scope: SourceActionScope, key: string, record: SourceActionRecord): void {
    const others = (this.scopes.get(key)?.records ?? noRecords).filter(
      (item) => item.commandId !== record.commandId,
    );
    const kept = new Set(others.filter(isResolvedSourceAction).slice(-(resolvedHistoryLimit - 1)));
    const records = [
      ...others.filter((item) => !isResolvedSourceAction(item) || kept.has(item)),
      record,
    ];
    this.scopes.set(key, { scope, records });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export async function dispatchSourceCommand(input: {
  readonly registry: SourceActionRegistry;
  readonly scope: Extract<SourceActionScope, { readonly type: "thread" }>;
  readonly lease: Pick<SourceLease, "request">;
  readonly state: SourceControlState;
  readonly command: SourceDispatchCommand;
  readonly intent: SourceActionIntent;
  readonly baseSequence: number;
  readonly support?: SourceActionSupport;
}) {
  const { command, support } = input;
  if (command.type === "checkpoint.rollback" && rollbackUnavailableReason(support) !== undefined)
    throw new SourceCommandUnavailableError("not supported");
  if (
    command.type === "queue.resume" &&
    !support?.projection?.runs.some((run) => run.status === "queued" && run.queueHeld === true)
  )
    throw new SourceCommandUnavailableError("not supported");
  return input.registry.dispatch({
    scope: input.scope,
    commandId: command.commandId,
    intent: input.intent,
    baseSequence: input.baseSequence,
    state: input.state,
    request: (commandId) => {
      if (commandId !== command.commandId)
        throw new Error("The command ID changed before dispatch.");
      return input.lease.request((client) => client["orchestration.dispatchCommand"](command));
    },
  });
}

export function createCommandId(): SourceCommandId {
  return globalThis.crypto.randomUUID() as SourceCommandId;
}

export function createMessageId(): SourceMessageId {
  return globalThis.crypto.randomUUID() as SourceMessageId;
}

export function createThreadId(): SourceThreadId {
  return globalThis.crypto.randomUUID() as SourceThreadId;
}

type SourceConfig = Effect.Success<ReturnType<SourceRpcClient["server.getConfig"]>>;
export interface SourceActionSupport {
  readonly providers?: readonly {
    readonly instanceId: string;
    readonly supportsConversationRollback?: SourceConfig["providers"][number]["supportsConversationRollback"];
  }[];
  readonly projection?: {
    readonly thread: {
      readonly modelSelection: { readonly instanceId: string };
      readonly activeProviderThreadId: string | null;
    };
    readonly providerThreads: readonly {
      readonly id: string;
      readonly providerInstanceId: string;
      readonly providerSessionId: string | null;
    }[];
    readonly providerSessions: readonly {
      readonly id: string;
      readonly providerInstanceId: string;
      readonly capabilities: { readonly threads: { readonly canRollbackThread: boolean } };
    }[];
    readonly runs: readonly {
      readonly id: string;
      readonly status: string;
      readonly queueHeld?: boolean;
    }[];
    readonly checkpoints?: readonly {
      readonly id: string;
      readonly appRunOrdinal: number | null;
    }[];
  };
}

export function rollbackUnavailableReason(evidence?: SourceActionSupport): string | undefined {
  const projection = evidence?.projection;
  if (!projection || !evidence?.providers)
    return "Conversation rollback support has not been confirmed.";
  const selectedProviderId = projection.thread.modelSelection.instanceId;
  const provider = evidence.providers.find((item) => item.instanceId === selectedProviderId);
  if (provider?.supportsConversationRollback !== true)
    return "This provider does not support conversation rollback.";
  const providerThread = projection.providerThreads.find(
    (item) =>
      item.id === projection.thread.activeProviderThreadId &&
      item.providerInstanceId === selectedProviderId,
  );
  const session = projection.providerSessions.find(
    (item) =>
      item.id === providerThread?.providerSessionId &&
      item.providerInstanceId === selectedProviderId,
  );
  if (session?.capabilities.threads.canRollbackThread !== true)
    return "The active provider session does not support conversation rollback.";
  return undefined;
}

export function sourceActionResultText(action: {
  readonly kind: SourceActionKind;
  readonly result: "accepted" | "uncertain" | "confirmed";
  readonly sequence: number;
  readonly complete: boolean;
}): string {
  const label = action.kind === "resume" ? "queue release" : action.kind;
  if (action.result === "uncertain")
    return `The result of ${label} is uncertain. Source acceptance is not confirmed.`;
  return action.complete
    ? `Source update confirms ${label} at sequence ${action.sequence}.`
    : `Source accepted ${label} at sequence ${action.sequence}. Completion is not confirmed.`;
}

const recordLabels: Record<SourceActionIntent["kind"], string> = {
  prompt: "prompt",
  interrupt: "interrupt",
  resume: "queue release",
  settle: "settle",
  unsettle: "unsettle",
  "runtime-response": "runtime request response",
  rollback: "rollback",
  launch: "session launch",
};

/** Copy for a registry record. Every view renders the same text for the same record. */
export function sourceActionRecordText(record: SourceActionRecord): string {
  const label = recordLabels[record.intent.kind];
  switch (record.phase) {
    case "sending":
      return `Sending ${label} command ${record.commandId} to the source.`;
    case "uncertain":
      return `The result of ${label} command ${record.commandId} is uncertain. Source acceptance is not confirmed. Do not repeat it. New commands stay paused until source data confirms it.`;
    case "rejected":
      return `The source rejected ${label} command ${record.commandId}.`;
    case "failed":
      return `Source update shows that ${label} command ${record.commandId} failed.`;
    case "accepted":
      return record.intent.kind === "launch"
        ? `Source accepted ${label} command ${record.commandId}. Waiting for the session in the factory overview.`
        : `Source accepted ${label} at sequence ${record.sequence}. Completion is not confirmed.`;
    case "confirmed":
      return record.intent.kind === "rollback"
        ? `The source completed rollback command ${record.commandId} at sequence ${record.sequence}.`
        : record.intent.kind === "launch"
          ? `The factory overview confirms ${label} command ${record.commandId}.`
          : `Source update confirms ${label} at sequence ${record.sequence}.`;
  }
}
