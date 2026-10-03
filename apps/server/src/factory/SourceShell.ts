import {
  FACTORY_MAX_THREADS,
  FactoryProjectSummary,
  FactoryRegistrationId,
  FactorySourceFreshness,
  FactoryThreadSummary,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  classifyFactoryState,
  factoryStateInputFromShell,
  type FactoryProjectKey,
  type FactoryProjectSummary as FactoryProjectSummaryType,
  type FactoryRemoteTarget,
  type FactorySourceFreshness as FactorySourceFreshnessType,
  type FactoryThreadKey,
  type FactoryThreadSummary as FactoryThreadSummaryType,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Connections from "./Connections.ts";

const MAX_SOURCE_PROJECTS = FACTORY_MAX_THREADS;
const isFactoryProjectSummary = Schema.is(FactoryProjectSummary);
const isFactoryThreadSummary = Schema.is(FactoryThreadSummary);

export interface SourceShellState {
  readonly target: FactoryRemoteTarget;
  readonly appliedCursor: typeof NonNegativeInt.Type | undefined;
  readonly freshness: FactorySourceFreshnessType;
  readonly projects: ReadonlyArray<FactoryProjectSummaryType>;
  readonly threads: ReadonlyArray<FactoryThreadSummaryType>;
}

export type SourceShellFrame =
  | {
      readonly kind: "synchronized";
      readonly target: FactoryRemoteTarget;
      readonly appliedCursor: typeof NonNegativeInt.Type | undefined;
    }
  | {
      readonly kind: "snapshot";
      readonly target: FactoryRemoteTarget;
      readonly sequence: typeof NonNegativeInt.Type;
      readonly projects: ReadonlyArray<FactoryProjectSummaryType>;
      readonly threads: ReadonlyArray<FactoryThreadSummaryType>;
      readonly resolvedRepositoryIdentityRoots?: ReadonlyArray<string>;
      readonly resetReason?: Extract<
        OrchestrationV2ShellStreamItem,
        { kind: "snapshot" }
      >["resetReason"];
    }
  | {
      readonly kind: "project.updated";
      readonly target: FactoryRemoteTarget;
      readonly sequence: typeof NonNegativeInt.Type;
      readonly project: FactoryProjectSummaryType;
    }
  | {
      readonly kind: "project.removed";
      readonly target: FactoryRemoteTarget;
      readonly sequence: typeof NonNegativeInt.Type;
      readonly key: FactoryProjectKey;
    }
  | {
      readonly kind: "thread.updated";
      readonly target: FactoryRemoteTarget;
      readonly sequence: typeof NonNegativeInt.Type;
      readonly thread: FactoryThreadSummaryType;
    }
  | {
      readonly kind: "thread.removed";
      readonly target: FactoryRemoteTarget;
      readonly sequence: typeof NonNegativeInt.Type;
      readonly key: FactoryThreadKey;
    };

export type SourceShellUpdate =
  | { readonly kind: "snapshot"; readonly sources: ReadonlyArray<SourceShellState> }
  | { readonly kind: "source"; readonly source: SourceShellState }
  | { readonly kind: "frame"; readonly frame: SourceShellFrame }
  | { readonly kind: "removed"; readonly target: FactoryRemoteTarget };

export class SourceShell extends Context.Service<
  SourceShell,
  {
    readonly start: Effect.Effect<void>;
    readonly getStates: Effect.Effect<ReadonlyArray<SourceShellState>>;
    /** A full initial state followed by applied shell frames and freshness changes. */
    readonly subscribe: Stream.Stream<SourceShellUpdate>;
  }
>()("t3/factory/SourceShell") {}

export const nextAppliedCursor = (input: {
  readonly previous: typeof NonNegativeInt.Type | undefined;
  readonly incoming: typeof NonNegativeInt.Type;
  readonly applied: boolean;
}): typeof NonNegativeInt.Type | undefined => (input.applied ? input.incoming : input.previous);

interface SourceProjection {
  readonly target: FactoryRemoteTarget;
  projects: Map<string, FactoryProjectSummaryType>;
  threads: Map<string, FactoryThreadSummaryType>;
  appliedCursor: typeof NonNegativeInt.Type | undefined;
  freshness: FactorySourceFreshnessType;
  invalidData: boolean;
  connectionId: object | undefined;
  firstItemOnConnection: boolean;
}

interface Consumer {
  readonly connectionId: object;
  readonly fiber: Fiber.Fiber<void>;
}

interface InternalUpdate {
  readonly revision: number;
  readonly update: SourceShellUpdate;
}

type SourceChange =
  | {
      readonly kind: "snapshot";
      readonly projects: ReadonlyArray<FactoryProjectSummaryType>;
      readonly threads: ReadonlyArray<FactoryThreadSummaryType>;
      readonly resolvedRoots: ReadonlyArray<string> | undefined;
      readonly sequence: typeof NonNegativeInt.Type;
      readonly resetReason: Extract<
        OrchestrationV2ShellStreamItem,
        { kind: "snapshot" }
      >["resetReason"];
    }
  | {
      readonly kind: "project.updated";
      readonly project: FactoryProjectSummaryType;
      readonly sequence: typeof NonNegativeInt.Type;
    }
  | {
      readonly kind: "project.removed";
      readonly projectId: ProjectId;
      readonly sequence: typeof NonNegativeInt.Type;
    }
  | {
      readonly kind: "thread.updated";
      readonly thread: FactoryThreadSummaryType;
      readonly sequence: typeof NonNegativeInt.Type;
    }
  | {
      readonly kind: "thread.removed";
      readonly threadId: ThreadId;
      readonly sequence: typeof NonNegativeInt.Type;
    }
  | { readonly kind: "ignored"; readonly sequence: typeof NonNegativeInt.Type }
  | { readonly kind: "stale" }
  | { readonly kind: "synchronized" };

const projectSummary = (
  target: FactoryRemoteTarget,
  project: OrchestrationProjectShell,
): FactoryProjectSummaryType | undefined => {
  const summary = {
    key: { environmentId: target.environmentId, projectId: project.id },
    target,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  return isFactoryProjectSummary(summary) ? summary : undefined;
};

const threadSummary = (
  target: FactoryRemoteTarget,
  thread: OrchestrationV2ThreadShell,
): FactoryThreadSummaryType | undefined => {
  const state = factoryStateInputFromShell(thread);
  const summary = {
    key: { environmentId: target.environmentId, threadId: thread.id },
    target,
    project: { environmentId: target.environmentId, projectId: thread.projectId },
    title: thread.title,
    sourceStatus: thread.status,
    classification: classifyFactoryState(state),
    providerInstanceId: thread.providerInstanceId,
    model: thread.modelSelection.model,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    settled: state.settled,
    settledAt: thread.settledAt === null ? null : DateTime.toUtc(thread.settledAt),
    settledOverride: thread.settledOverride,
    providerCompletedAt:
      thread.latestRunCompletedAt == null ? null : DateTime.toUtc(thread.latestRunCompletedAt),
    finalizedAt: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  return isFactoryThreadSummary(summary) ? summary : undefined;
};

const fresh = (target: FactoryRemoteTarget, now: DateTime.DateTime) =>
  FactorySourceFreshness.make({
    target,
    state: "fresh",
    reason: null,
    updatedAt: DateTime.toUtc(now),
    retryAt: null,
  });

const makeProjection = (target: FactoryRemoteTarget): SourceProjection => ({
  target,
  projects: new Map(),
  threads: new Map(),
  appliedCursor: undefined,
  freshness: FactorySourceFreshness.make({
    target,
    state: "synchronizing",
    reason: null,
    updatedAt: null,
    retryAt: null,
  }),
  invalidData: false,
  connectionId: undefined,
  firstItemOnConnection: false,
});

const stateOf = (source: SourceProjection): SourceShellState => ({
  target: source.target,
  appliedCursor: source.appliedCursor,
  freshness: source.freshness,
  projects: [...source.projects.values()],
  threads: [...source.threads.values()],
});

const sourceHasRows = (source: SourceProjection) =>
  source.projects.size > 0 || source.threads.size > 0;

const reasonFromConnection = (
  reason: Connections.SourceState["reason"],
): FactorySourceFreshnessType["reason"] => {
  switch (reason) {
    case "authentication":
      return "auth-required";
    case "transport":
    case "unavailable":
      return "transport";
    case "protocol":
      return "protocol-mismatch";
    case "identity":
      return "identity-mismatch";
    case "credential-store":
      return "permission";
    default:
      return null;
  }
};

const reduce = (
  source: SourceProjection,
  item: OrchestrationV2ShellStreamItem,
  firstItemOnConnection: boolean,
): SourceChange | undefined => {
  if (item.kind === "synchronized") return { kind: "synchronized" };

  if (item.kind === "snapshot") {
    const sequence = item.snapshot.snapshotSequence;
    if (item.resolvedRepositoryIdentityRoots !== undefined) {
      if (source.appliedCursor !== sequence) return { kind: "stale" };
    } else if (
      sequence < (source.appliedCursor ?? -1) &&
      (item.resetReason === undefined || item.resetReason === "thread-recreated") &&
      !firstItemOnConnection
    ) {
      return { kind: "stale" };
    }
    const projects = item.snapshot.projects.map((project) =>
      projectSummary(source.target, project),
    );
    if (projects.some((project) => project === undefined)) return undefined;
    const activeThreads = item.snapshot.threads.filter((thread) => thread.archivedAt === null);
    const threads = activeThreads.map((thread) => threadSummary(source.target, thread));
    if (threads.some((thread) => thread === undefined)) return undefined;
    const projectValues = projects.filter(
      (project): project is FactoryProjectSummaryType => project !== undefined,
    );
    const threadValues = threads.filter(
      (thread): thread is FactoryThreadSummaryType => thread !== undefined,
    );
    if (projectValues.length > MAX_SOURCE_PROJECTS || threadValues.length > FACTORY_MAX_THREADS)
      return undefined;
    if (item.resolvedRepositoryIdentityRoots !== undefined) {
      const merged = new Set(source.projects.keys());
      for (const project of projectValues) merged.add(project.key.projectId);
      if (merged.size > MAX_SOURCE_PROJECTS) return undefined;
    }
    return {
      kind: "snapshot",
      projects: projectValues,
      threads: threadValues,
      resolvedRoots: item.resolvedRepositoryIdentityRoots,
      sequence: item.snapshot.snapshotSequence,
      resetReason: item.resetReason,
    };
  }

  if (item.sequence <= (source.appliedCursor ?? -1)) return { kind: "stale" };
  switch (item.kind) {
    case "project.updated": {
      const project = projectSummary(source.target, item.project);
      if (project === undefined) return undefined;
      if (
        !source.projects.has(project.key.projectId) &&
        source.projects.size >= MAX_SOURCE_PROJECTS
      )
        return undefined;
      return { kind: "project.updated", project, sequence: item.sequence };
    }
    case "project.removed":
      return { kind: "project.removed", projectId: item.projectId, sequence: item.sequence };
    case "thread.updated": {
      if (item.location === "archive") return { kind: "ignored", sequence: item.sequence };
      if (item.thread.archivedAt !== null)
        return { kind: "thread.removed", threadId: item.thread.id, sequence: item.sequence };
      const thread = threadSummary(source.target, item.thread);
      if (thread === undefined) return undefined;
      if (!source.threads.has(thread.key.threadId) && source.threads.size >= FACTORY_MAX_THREADS)
        return undefined;
      return { kind: "thread.updated", thread, sequence: item.sequence };
    }
    case "thread.removed":
      return item.location === "active"
        ? { kind: "thread.removed", threadId: item.threadId, sequence: item.sequence }
        : { kind: "ignored", sequence: item.sequence };
  }
};

const frameForChange = (
  target: FactoryRemoteTarget,
  source: SourceProjection,
  change: SourceChange,
): SourceShellFrame | undefined => {
  switch (change.kind) {
    case "snapshot": {
      const resolvedRoots = new Set(change.resolvedRoots);
      return {
        kind: "snapshot",
        target,
        sequence: change.sequence,
        projects:
          change.resolvedRoots === undefined
            ? change.projects
            : change.projects.filter((project) => resolvedRoots.has(project.workspaceRoot)),
        threads: change.resolvedRoots === undefined ? change.threads : [],
        ...(change.resolvedRoots === undefined
          ? {}
          : { resolvedRepositoryIdentityRoots: change.resolvedRoots }),
        ...(change.resetReason === undefined ? {} : { resetReason: change.resetReason }),
      };
    }
    case "project.updated":
      return {
        kind: "project.updated",
        target,
        sequence: change.sequence,
        project: change.project,
      };
    case "project.removed":
      return {
        kind: "project.removed",
        target,
        sequence: change.sequence,
        key: { environmentId: target.environmentId, projectId: change.projectId },
      };
    case "thread.updated":
      return { kind: "thread.updated", target, sequence: change.sequence, thread: change.thread };
    case "thread.removed":
      return {
        kind: "thread.removed",
        target,
        sequence: change.sequence,
        key: { environmentId: target.environmentId, threadId: change.threadId },
      };
    case "synchronized":
      return { kind: "synchronized", target, appliedCursor: source.appliedCursor };
    case "ignored":
    case "stale":
      return undefined;
  }
};

const applyChange = (source: SourceProjection, change: SourceChange) => {
  switch (change.kind) {
    case "snapshot":
      if (change.resolvedRoots === undefined) {
        source.projects = new Map(
          change.projects.map((project) => [project.key.projectId, project]),
        );
        source.threads = new Map(change.threads.map((thread) => [thread.key.threadId, thread]));
        source.invalidData = false;
      } else {
        const roots = new Set(change.resolvedRoots);
        for (const project of change.projects) {
          if (roots.has(project.workspaceRoot)) source.projects.set(project.key.projectId, project);
        }
      }
      source.appliedCursor = nextAppliedCursor({
        previous: source.appliedCursor,
        incoming: change.sequence,
        applied: true,
      });
      break;
    case "project.updated":
      source.projects.set(change.project.key.projectId, change.project);
      source.appliedCursor = nextAppliedCursor({
        previous: source.appliedCursor,
        incoming: change.sequence,
        applied: true,
      });
      break;
    case "project.removed":
      source.projects.delete(change.projectId);
      source.appliedCursor = nextAppliedCursor({
        previous: source.appliedCursor,
        incoming: change.sequence,
        applied: true,
      });
      break;
    case "thread.updated":
      source.threads.set(change.thread.key.threadId, change.thread);
      source.appliedCursor = nextAppliedCursor({
        previous: source.appliedCursor,
        incoming: change.sequence,
        applied: true,
      });
      break;
    case "thread.removed":
      source.threads.delete(change.threadId);
      source.appliedCursor = nextAppliedCursor({
        previous: source.appliedCursor,
        incoming: change.sequence,
        applied: true,
      });
      break;
    case "ignored":
      source.appliedCursor = nextAppliedCursor({
        previous: source.appliedCursor,
        incoming: change.sequence,
        applied: true,
      });
      break;
    case "synchronized":
    case "stale":
      break;
  }
};

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const connections = yield* Connections.Connections;
  const changes = yield* PubSub.bounded<InternalUpdate>(256);
  const sources = new Map<FactoryRegistrationId, SourceProjection>();
  const consumers = new Map<FactoryRegistrationId, Consumer>();
  let revision = 0;
  let started = false;

  const snapshot = () => [...sources.values()].map(stateOf);
  const publish = (update: SourceShellUpdate) =>
    PubSub.publish(changes, { revision: ++revision, update }).pipe(Effect.asVoid);
  const publishSource = (source: SourceProjection) =>
    publish({ kind: "source", source: stateOf(source) });
  const stateFor = (target: FactoryRemoteTarget) => {
    const previous = sources.get(target.registrationId);
    if (previous !== undefined && previous.target.environmentId === target.environmentId)
      return previous;
    const next = makeProjection(target);
    sources.set(target.registrationId, next);
    return next;
  };
  const clearSource = Effect.fnUntraced(function* (
    registrationId: FactoryRegistrationId,
    target?: FactoryRemoteTarget,
  ) {
    const consumer = consumers.get(registrationId);
    if (consumer !== undefined) {
      consumers.delete(registrationId);
      yield* Fiber.interrupt(consumer.fiber);
    }
    const source = sources.get(registrationId);
    if (source !== undefined) {
      sources.delete(registrationId);
      yield* publish({ kind: "removed", target: target ?? source.target });
    }
  });
  const setConnectionFreshness = Effect.fnUntraced(function* (
    state: Connections.SourceState,
    source: SourceProjection,
  ) {
    const hasRows = sourceHasRows(source);
    const freshnessState =
      state.phase === "connecting"
        ? hasRows
          ? "stale"
          : "synchronizing"
        : state.phase === "blocked"
          ? hasRows
            ? "stale"
            : "blocked"
          : hasRows
            ? "stale"
            : "offline";
    const reason = reasonFromConnection(state.reason);
    if (source.freshness.state === freshnessState && source.freshness.reason === reason) return;
    source.freshness = FactorySourceFreshness.make({
      target: source.target,
      state: freshnessState,
      reason,
      updatedAt: source.freshness.updatedAt,
      retryAt: null,
    });
    yield* publishSource(source);
  });

  const applyItem = Effect.fnUntraced(function* (
    access: Connections.SourceAccess,
    source: SourceProjection,
    item: OrchestrationV2ShellStreamItem,
  ) {
    if (source.connectionId !== access.connectionId) return;
    const firstItemOnConnection = source.firstItemOnConnection;
    source.firstItemOnConnection = false;
    const change = reduce(source, item, firstItemOnConnection);
    if (change === undefined) {
      source.invalidData = true;
      source.freshness = FactorySourceFreshness.make({
        target: source.target,
        state: "blocked",
        reason: "invalid-data",
        updatedAt: source.freshness.updatedAt,
        retryAt: null,
      });
      yield* publishSource(source);
      return;
    }
    if (change.kind === "stale") return;

    const incoming =
      change.kind === "snapshot" ||
      change.kind === "project.updated" ||
      change.kind === "project.removed" ||
      change.kind === "thread.updated" ||
      change.kind === "thread.removed" ||
      change.kind === "ignored"
        ? change.sequence
        : undefined;
    const frame = frameForChange(access.target, source, change);
    const synchronizedAt =
      change.kind === "synchronized" && !source.invalidData ? yield* DateTime.now : undefined;
    const previous = {
      projects: new Map(source.projects),
      threads: new Map(source.threads),
      appliedCursor: source.appliedCursor,
      freshness: source.freshness,
      invalidData: source.invalidData,
    };
    const update = yield* Effect.gen(function* () {
      applyChange(source, change);
      if (change.kind === "synchronized") {
        source.freshness = source.invalidData
          ? FactorySourceFreshness.make({
              target: source.target,
              state: "blocked",
              reason: "invalid-data",
              updatedAt: source.freshness.updatedAt,
              retryAt: null,
            })
          : fresh(source.target, synchronizedAt!);
      }
      if (incoming !== undefined) {
        const acknowledgment = yield* Effect.exit(access.acknowledgeShell(incoming));
        if (Exit.isFailure(acknowledgment)) {
          source.projects = previous.projects;
          source.threads = previous.threads;
          source.appliedCursor = previous.appliedCursor;
          source.freshness = previous.freshness;
          source.invalidData = previous.invalidData;
          return yield* Effect.failCause(acknowledgment.cause);
        }
      }
      revision++;
      return {
        revision,
        update:
          frame === undefined
            ? { kind: "source" as const, source: stateOf(source) }
            : { kind: "frame" as const, frame },
      };
    });
    yield* PubSub.publish(changes, update);
  });

  const consume = Effect.fnUntraced(function* (
    access: Connections.SourceAccess,
    source: SourceProjection,
  ) {
    yield* access.shell.pipe(Stream.runForEach((item) => applyItem(access, source, item)));
  });

  const observe = Effect.fnUntraced(function* (state: Connections.SourceState) {
    const registrationId = state.target.registrationId;
    const previous = sources.get(registrationId);
    if (previous !== undefined && previous.target.environmentId !== state.target.environmentId)
      yield* clearSource(registrationId);
    if (state.phase === "disabled") {
      yield* clearSource(registrationId, state.target);
      return;
    }
    const source = stateFor(state.target);
    const currentConsumer = consumers.get(registrationId);
    if (state.phase !== "online") {
      if (currentConsumer !== undefined) {
        consumers.delete(registrationId);
        yield* Fiber.interrupt(currentConsumer.fiber);
      }
      yield* setConnectionFreshness(state, source);
      return;
    }

    const access = yield* connections.resolveTarget(state.target).pipe(
      Effect.catchTag("SourceFailure", (error) =>
        Effect.gen(function* () {
          yield* setConnectionFreshness(
            { ...state, phase: "offline", reason: error.reason },
            source,
          );
          return undefined;
        }),
      ),
    );
    if (access === undefined) return;
    if (currentConsumer?.connectionId === access.connectionId) return;
    if (currentConsumer !== undefined) {
      consumers.delete(registrationId);
      yield* Fiber.interrupt(currentConsumer.fiber);
    }
    source.connectionId = access.connectionId;
    source.firstItemOnConnection = true;
    source.freshness = FactorySourceFreshness.make({
      target: source.target,
      state: sourceHasRows(source) ? "stale" : "synchronizing",
      reason: null,
      updatedAt: source.freshness.updatedAt,
      retryAt: null,
    });
    yield* publishSource(source);
    const fiber = yield* consume(access, source).pipe(
      Effect.catchTag("SourceFailure", () => Effect.void),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    consumers.set(registrationId, { connectionId: access.connectionId, fiber });
  });

  const observeSnapshot = Effect.fnUntraced(function* (
    states: ReadonlyArray<Connections.SourceState>,
  ) {
    const registrations = new Set(states.map((state) => state.target.registrationId));
    for (const registrationId of sources.keys()) {
      if (!registrations.has(registrationId)) yield* clearSource(registrationId);
    }
    for (const registrationId of consumers.keys()) {
      if (!registrations.has(registrationId)) yield* clearSource(registrationId);
    }
    for (const state of states) yield* observe(state);
  });

  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    yield* connections.subscribeStates.pipe(
      Stream.runForEach(observeSnapshot),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const initial = yield* Effect.sync(() => ({ revision, sources: snapshot() }));
      return Stream.concat(
        Stream.succeed({ kind: "snapshot" as const, sources: initial.sources }),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((update) => update.revision > initial.revision),
          Stream.map((update) => update.update),
        ),
      );
    }),
  );

  return SourceShell.of({
    start,
    getStates: Effect.sync(snapshot),
    subscribe,
  });
});

export const layer = Layer.effect(SourceShell, make);
