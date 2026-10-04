import {
  FACTORY_MAX_SNAPSHOT_BYTES,
  FACTORY_MAX_THREADS,
  FactoryEnvironmentView,
  FactoryError,
  FactoryFavorite,
  FactoryGenerationId,
  FactoryGroup,
  FactoryMembership,
  FactoryOverviewSnapshot,
  FactoryProjectSummary,
  FactorySourceFreshness,
  FactoryThreadSummary,
  type FactoryOverviewEvent,
  type FactoryOverviewPatch,
  type FactoryOverviewSnapshot as FactoryOverviewSnapshotType,
  type FactoryProjectReference,
  type FactoryRemoteTarget,
  type FactorySourceFreshness as FactorySourceFreshnessType,
  type FactoryThreadKey,
  type FactoryProjectKey,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Metadata from "./Metadata.ts";
import * as SourceShell from "./SourceShell.ts";

const encoder = new TextEncoder();
const MAX_SUBSCRIBER_QUEUE_ITEMS = 256;
const MAX_SUBSCRIBER_QUEUE_BYTES = 1024 * 1024;

type OverviewLimitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "overview-too-large" };

export const checkOverviewLimits = (input: {
  readonly threadCount: number;
  readonly encodedBytes: number;
}): OverviewLimitResult =>
  !Number.isSafeInteger(input.threadCount) ||
  !Number.isSafeInteger(input.encodedBytes) ||
  input.threadCount < 0 ||
  input.encodedBytes < 0 ||
  input.threadCount > FACTORY_MAX_THREADS ||
  input.encodedBytes > FACTORY_MAX_SNAPSHOT_BYTES
    ? { ok: false, reason: "overview-too-large" }
    : { ok: true };

export class Overview extends Context.Service<
  Overview,
  {
    readonly start: Effect.Effect<void>;
    readonly getSnapshot: Effect.Effect<FactoryOverviewSnapshotType, FactoryError>;
    readonly subscribe: Stream.Stream<FactoryOverviewEvent, FactoryError>;
  }
>()("t3/factory/Overview") {}

interface Projection<Value> {
  readonly values: Map<string, Value>;
  readonly itemBytes: Map<string, number>;
  totalBytes: number;
}

interface SourceProjection {
  readonly target: FactoryRemoteTarget;
  readonly projectKeys: Set<string>;
  readonly threadKeys: Set<string>;
  freshness: FactorySourceFreshnessType;
  appliedCursor: number | undefined;
}

interface Subscriber {
  readonly queue: Array<{ readonly event: FactoryOverviewEvent; readonly bytes: number }>;
  queuedBytes: number;
  // One complete snapshot has its own 8-MiB budget; delta backlog stays at 1 MiB.
  snapshotPending: boolean;
  waiting: Deferred.Deferred<void> | undefined;
  failure: FactoryError | undefined;
}

const emptyProjection = <Value>(): Projection<Value> => ({
  values: new Map(),
  itemBytes: new Map(),
  totalBytes: 0,
});

const json = (value: object): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Factory overview values must be JSON serializable.");
  return encoded;
};

const encodedJsonBytes = (value: object) => encoder.encode(json(value)).byteLength;
const sameJson = (left: object, right: object) => json(left) === json(right);
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sortValues = <Value>(values: Iterable<Value>, key: (value: Value) => string) =>
  Array.from(values).toSorted((left, right) => compareText(key(left), key(right)));
const projectIdentity = (key: FactoryProjectKey) =>
  JSON.stringify([key.environmentId, key.projectId]);
const threadIdentity = (key: FactoryThreadKey) => JSON.stringify([key.environmentId, key.threadId]);
const membershipIdentity = (value: FactoryMembership) =>
  JSON.stringify([value.groupId, value.project.environmentId, value.project.projectId]);
const favoriteIdentity = (value: FactoryFavorite) =>
  value.target.kind === "group"
    ? JSON.stringify(["group", value.target.groupId])
    : JSON.stringify([
        "project",
        value.target.project.environmentId,
        value.target.project.projectId,
      ]);
const sameTarget = (left: FactoryRemoteTarget, right: FactoryRemoteTarget) =>
  left.registrationId === right.registrationId && left.environmentId === right.environmentId;
const ownedBy = (target: FactoryRemoteTarget, source: SourceProjection) =>
  target.registrationId === source.target.registrationId &&
  target.environmentId === source.target.environmentId;

const setProjected = <Value extends object>(
  projection: Projection<Value>,
  key: string,
  value: Value,
) => {
  const size = encodedJsonBytes(value);
  const previousSize = projection.itemBytes.get(key) ?? 0;
  projection.values.set(key, value);
  projection.itemBytes.set(key, size);
  projection.totalBytes += size - previousSize;
};

const removeProjected = <Value>(projection: Projection<Value>, key: string) => {
  const value = projection.values.get(key);
  if (value === undefined) return undefined;
  projection.totalBytes -= projection.itemBytes.get(key) ?? 0;
  projection.values.delete(key);
  projection.itemBytes.delete(key);
  return value;
};

const clearProjection = <Value>(projection: Projection<Value>) => {
  projection.values.clear();
  projection.itemBytes.clear();
  projection.totalBytes = 0;
};

const replaceProjection = <Value extends object>(input: {
  readonly projection: Projection<Value>;
  readonly values: ReadonlyArray<Value>;
  readonly identity: (value: Value) => string;
}) => {
  const next = new Map<string, Value>();
  for (const value of input.values) next.set(input.identity(value), value);
  const removals = Array.from(input.projection.values.entries())
    .filter(([key]) => !next.has(key))
    .map(([, value]) => value);
  const upserts = Array.from(next.entries())
    .filter(([key, value]) => {
      const previous = input.projection.values.get(key);
      return previous === undefined || !sameJson(previous, value);
    })
    .map(([, value]) => value);
  clearProjection(input.projection);
  for (const [key, value] of next) setProjected(input.projection, key, value);
  return { upserts, removals };
};

const tooLargeError = () =>
  new FactoryError({
    code: "overview-too-large",
    message: "The factory overview exceeds its size limit.",
  });

const streamOverflowError = () =>
  new FactoryError({
    code: "overview-stream-overflow",
    message:
      "The overview changed faster than this subscription can receive it. Subscribe again for a fresh snapshot.",
  });

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const metadata = yield* Metadata.Metadata;
  const sourceShell = yield* SourceShell.SourceShell;
  const generation = FactoryGenerationId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const lock = yield* Semaphore.make(1);
  const environments = emptyProjection<typeof FactoryEnvironmentView.Type>();
  const freshness = emptyProjection<FactorySourceFreshnessType>();
  const threads = emptyProjection<typeof FactoryThreadSummary.Type>();
  const projects = emptyProjection<typeof FactoryProjectSummary.Type>();
  const groups = emptyProjection<typeof FactoryGroup.Type>();
  const memberships = emptyProjection<typeof FactoryMembership.Type>();
  const favorites = emptyProjection<typeof FactoryFavorite.Type>();
  const sources = new Map<string, SourceProjection>();
  const subscribers = new Map<number, Subscriber>();
  let nextSubscriberId = 0;
  let revision = 0;
  let metadataRevision = -1;
  let started = false;

  const snapshotBytes = (snapshotRevision = revision) => {
    const emptySnapshot = {
      generation,
      revision: snapshotRevision,
      environments: [],
      sourceFreshness: [],
      threads: [],
      projects: [],
      groups: [],
      memberships: [],
      favorites: [],
    };
    return (
      encodedJsonBytes(emptySnapshot) +
      [environments, freshness, threads, projects, groups, memberships, favorites].reduce(
        (total, projection) =>
          total + projection.totalBytes + Math.max(0, projection.values.size - 1),
        0,
      )
    );
  };

  const snapshotLocked: Effect.Effect<FactoryOverviewSnapshotType, FactoryError> = Effect.gen(
    function* () {
      const limits = checkOverviewLimits({
        threadCount: threads.values.size,
        encodedBytes: snapshotBytes(),
      });
      if (!limits.ok) return yield* Effect.fail(tooLargeError());
      return FactoryOverviewSnapshot.make({
        generation,
        revision,
        environments: sortValues(environments.values.values(), (item) => item.registrationId),
        sourceFreshness: sortValues(
          freshness.values.values(),
          (item) => item.target.registrationId,
        ),
        threads: sortValues(threads.values.values(), (item) => threadIdentity(item.key)),
        projects: sortValues(projects.values.values(), (item) => projectIdentity(item.key)),
        groups: sortValues(groups.values.values(), (item) => item.id),
        memberships: sortValues(memberships.values.values(), membershipIdentity),
        favorites: sortValues(favorites.values.values(), favoriteIdentity),
      });
    },
  );

  const wake = (subscriber: Subscriber) => {
    const waiting = subscriber.waiting;
    if (waiting === undefined) return Effect.void;
    subscriber.waiting = undefined;
    return Deferred.succeed(waiting, undefined).pipe(Effect.asVoid);
  };

  const failSubscriber = (subscriber: Subscriber, error: FactoryError) => {
    subscriber.failure = error;
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
    subscriber.snapshotPending = false;
    return wake(subscriber);
  };

  const failSubscribers = (error: FactoryError) =>
    Effect.forEach(subscribers.values(), (subscriber) => failSubscriber(subscriber, error), {
      discard: true,
    });

  const publishPatches = (patches: ReadonlyArray<FactoryOverviewPatch>) =>
    Effect.gen(function* () {
      if (subscribers.size === 0 || patches.length === 0) return;
      // Preflight the whole transaction, not chunks that can overflow in one producer burst.
      const patchEvents = patches.map((patch, index) => {
        const event: FactoryOverviewEvent = {
          type: "patch",
          generation,
          revision: revision + index + 1,
          patch,
        };
        return { event, bytes: encodedJsonBytes(event) };
      });
      const completeSnapshot =
        patches.length > MAX_SUBSCRIBER_QUEUE_ITEMS ||
        patchEvents.reduce((total, { bytes }) => total + bytes, 0) > MAX_SUBSCRIBER_QUEUE_BYTES;
      const finalRevision = revision + (completeSnapshot ? 1 : patches.length);
      const limits = checkOverviewLimits({
        threadCount: threads.values.size,
        encodedBytes: snapshotBytes(finalRevision),
      });
      if (!limits.ok) {
        yield* failSubscribers(tooLargeError());
        return;
      }
      revision = finalRevision;
      const events = completeSnapshot
        ? [{ event: { type: "snapshot" as const, snapshot: yield* snapshotLocked }, bytes: 0 }]
        : patchEvents;
      for (const { event, bytes } of events) {
        for (const subscriber of subscribers.values()) {
          if (subscriber.failure !== undefined) continue;
          if (
            subscriber.queue.length >= MAX_SUBSCRIBER_QUEUE_ITEMS ||
            bytes > MAX_SUBSCRIBER_QUEUE_BYTES - subscriber.queuedBytes ||
            (event.type === "snapshot" && subscriber.snapshotPending)
          ) {
            yield* failSubscriber(subscriber, streamOverflowError());
            continue;
          }
          const wasEmpty = subscriber.queue.length === 0;
          subscriber.queue.push({ event, bytes });
          subscriber.queuedBytes += bytes;
          if (event.type === "snapshot") subscriber.snapshotPending = true;
          if (wasEmpty) yield* wake(subscriber);
        }
      }
    });

  const checkAndPublish = (patches: ReadonlyArray<FactoryOverviewPatch>) => publishPatches(patches);

  const newSource = (
    target: FactoryRemoteTarget,
    sourceFreshness: FactorySourceFreshnessType,
    appliedCursor: number | undefined,
  ): SourceProjection => ({
    target,
    freshness: sourceFreshness,
    appliedCursor,
    projectKeys: new Set(),
    threadKeys: new Set(),
  });

  const addProject = (source: SourceProjection, value: typeof FactoryProjectSummary.Type) => {
    const key = projectIdentity(value.key);
    source.projectKeys.add(key);
    setProjected(projects, key, value);
  };

  const addThread = (source: SourceProjection, value: typeof FactoryThreadSummary.Type) => {
    const key = threadIdentity(value.key);
    source.threadKeys.add(key);
    setProjected(threads, key, value);
  };

  const removeSource = (registrationId: string, target?: FactoryRemoteTarget) => {
    const source = sources.get(registrationId);
    if (source === undefined || (target !== undefined && !sameTarget(source.target, target))) {
      return { source: undefined, projects: [], threads: [], freshness: [] };
    }
    sources.delete(registrationId);
    const removedProjects: Array<typeof FactoryProjectSummary.Type> = [];
    const removedThreads: Array<typeof FactoryThreadSummary.Type> = [];
    for (const key of source.projectKeys) {
      const current = projects.values.get(key);
      if (current !== undefined && ownedBy(current.target, source)) {
        const removed = removeProjected(projects, key);
        if (removed !== undefined) removedProjects.push(removed);
      }
    }
    for (const key of source.threadKeys) {
      const current = threads.values.get(key);
      if (current !== undefined && ownedBy(current.target, source)) {
        const removed = removeProjected(threads, key);
        if (removed !== undefined) removedThreads.push(removed);
      }
    }
    const removedFreshness = removeProjected(freshness, registrationId);
    return {
      source,
      projects: removedProjects,
      threads: removedThreads,
      freshness: removedFreshness === undefined ? [] : [removedFreshness],
    };
  };

  const sourceRemovalPatches = (removed: ReturnType<typeof removeSource>) => {
    const patches: Array<FactoryOverviewPatch> = [];
    if (removed.projects.length > 0) {
      patches.push({
        kind: "projects",
        upserts: [],
        removals: removed.projects.map((item) => ({ key: item.key, target: item.target })),
      });
    }
    if (removed.threads.length > 0) {
      patches.push({
        kind: "threads",
        upserts: [],
        removals: removed.threads.map((item) => item.key),
      });
    }
    if (removed.freshness.length > 0) {
      patches.push({
        kind: "sourceFreshness",
        upserts: [],
        removals: removed.freshness.map((item) => item.target),
      });
    }
    return patches;
  };

  const ensureSource = (
    target: FactoryRemoteTarget,
  ): { readonly source: SourceProjection; readonly patches: Array<FactoryOverviewPatch> } => {
    const existing = sources.get(target.registrationId);
    if (existing !== undefined && sameTarget(existing.target, target)) {
      return { source: existing, patches: [] as Array<FactoryOverviewPatch> };
    }
    const removed = existing === undefined ? undefined : removeSource(target.registrationId);
    const sourceFreshness = FactorySourceFreshness.make({
      target,
      state: "synchronizing",
      reason: null,
      updatedAt: null,
      retryAt: null,
    });
    const source = newSource(target, sourceFreshness, undefined);
    sources.set(target.registrationId, source);
    setProjected(freshness, target.registrationId, sourceFreshness);
    return {
      source,
      patches: [
        ...(removed === undefined ? [] : sourceRemovalPatches(removed)),
        { kind: "sourceFreshness", upserts: [sourceFreshness], removals: [] },
      ],
    };
  };

  const replaceSources = (states: ReadonlyArray<SourceShell.SourceShellState>) => {
    const previousProjects = new Map(projects.values);
    const previousThreads = new Map(threads.values);
    const previousFreshness = new Map(freshness.values);
    sources.clear();
    clearProjection(projects);
    clearProjection(threads);
    clearProjection(freshness);
    for (const state of states) {
      const source = newSource(state.target, state.freshness, state.appliedCursor);
      sources.set(state.target.registrationId, source);
      setProjected(freshness, state.target.registrationId, state.freshness);
      for (const value of state.projects) addProject(source, value);
      for (const value of state.threads) addThread(source, value);
    }
    const patches: Array<FactoryOverviewPatch> = [];
    const projectUpserts = Array.from(projects.values.entries())
      .filter(([key, value]) => {
        const previous = previousProjects.get(key);
        return previous === undefined || !sameJson(previous, value);
      })
      .map(([, value]) => value);
    const projectRemovals = Array.from(previousProjects.entries())
      .filter(([key]) => !projects.values.has(key))
      .map(
        ([, value]) => ({ key: value.key, target: value.target }) satisfies FactoryProjectReference,
      );
    if (projectUpserts.length > 0 || projectRemovals.length > 0) {
      patches.push({ kind: "projects", upserts: projectUpserts, removals: projectRemovals });
    }
    const threadUpserts = Array.from(threads.values.entries())
      .filter(([key, value]) => {
        const previous = previousThreads.get(key);
        return previous === undefined || !sameJson(previous, value);
      })
      .map(([, value]) => value);
    const threadRemovals = Array.from(previousThreads.entries())
      .filter(([key]) => !threads.values.has(key))
      .map(([, value]) => value.key);
    if (threadUpserts.length > 0 || threadRemovals.length > 0) {
      patches.push({ kind: "threads", upserts: threadUpserts, removals: threadRemovals });
    }
    const freshnessUpserts = Array.from(freshness.values.entries())
      .filter(([key, value]) => {
        const previous = previousFreshness.get(key);
        return previous === undefined || !sameJson(previous, value);
      })
      .map(([, value]) => value);
    const freshnessRemovals = Array.from(previousFreshness.entries())
      .filter(([key]) => !freshness.values.has(key))
      .map(([, value]) => value.target);
    if (freshnessUpserts.length > 0 || freshnessRemovals.length > 0) {
      patches.push({
        kind: "sourceFreshness",
        upserts: freshnessUpserts,
        removals: freshnessRemovals,
      });
    }
    return patches;
  };

  const syncMetadata = (snapshot: Metadata.FactoryMetadataSnapshot) => {
    const environmentDiff = replaceProjection({
      projection: environments,
      values: snapshot.environments,
      identity: (item) => item.registrationId,
    });
    const groupDiff = replaceProjection({
      projection: groups,
      values: snapshot.groups,
      identity: (item) => item.id,
    });
    const membershipDiff = replaceProjection({
      projection: memberships,
      values: snapshot.memberships,
      identity: membershipIdentity,
    });
    const favoriteDiff = replaceProjection({
      projection: favorites,
      values: snapshot.favorites,
      identity: favoriteIdentity,
    });
    const patches: Array<FactoryOverviewPatch> = [];
    if (environmentDiff.upserts.length > 0 || environmentDiff.removals.length > 0) {
      patches.push({
        kind: "environments",
        upserts: environmentDiff.upserts,
        removals: environmentDiff.removals.map((item) => item.registrationId),
      });
    }
    if (
      groupDiff.upserts.length > 0 ||
      groupDiff.removals.length > 0 ||
      membershipDiff.upserts.length > 0 ||
      membershipDiff.removals.length > 0 ||
      favoriteDiff.upserts.length > 0 ||
      favoriteDiff.removals.length > 0
    ) {
      patches.push({
        kind: "metadata",
        groups: sortValues(groups.values.values(), (item) => item.id),
        memberships: sortValues(memberships.values.values(), membershipIdentity),
        favorites: sortValues(favorites.values.values(), favoriteIdentity),
      });
    }
    return patches;
  };

  const applyFrame = (frame: SourceShell.SourceShellFrame, now: DateTime.DateTime | undefined) => {
    const patches: Array<FactoryOverviewPatch> = [];
    const ensured = ensureSource(frame.target);
    patches.push(...ensured.patches);
    const source = ensured.source;
    switch (frame.kind) {
      case "snapshot": {
        if (frame.resolvedRepositoryIdentityRoots !== undefined) {
          const roots = new Set(frame.resolvedRepositoryIdentityRoots);
          const upserts = new Map<string, typeof FactoryProjectSummary.Type>();
          for (const value of frame.projects) {
            if (roots.has(value.workspaceRoot)) upserts.set(projectIdentity(value.key), value);
          }
          for (const value of upserts.values()) addProject(source, value);
          if (upserts.size > 0) {
            patches.push({ kind: "projects", upserts: [...upserts.values()], removals: [] });
          }
        } else {
          const projectDiff = replaceSourceRows({
            projection: projects,
            keys: source.projectKeys,
            source,
            values: frame.projects,
            identity: (value) => projectIdentity(value.key),
          });
          const threadDiff = replaceSourceRows({
            projection: threads,
            keys: source.threadKeys,
            source,
            values: frame.threads,
            identity: (value) => threadIdentity(value.key),
          });
          if (projectDiff.upserts.length > 0 || projectDiff.removals.length > 0) {
            patches.push({
              kind: "projects",
              upserts: projectDiff.upserts,
              removals: projectDiff.removals.map((value) => ({
                key: value.key,
                target: value.target,
              })),
            });
          }
          if (threadDiff.upserts.length > 0 || threadDiff.removals.length > 0) {
            patches.push({
              kind: "threads",
              upserts: threadDiff.upserts,
              removals: threadDiff.removals.map((value) => value.key),
            });
          }
        }
        source.appliedCursor = frame.sequence;
        break;
      }
      case "project.updated":
        addProject(source, frame.project);
        source.appliedCursor = frame.sequence;
        patches.push({ kind: "projects", upserts: [frame.project], removals: [] });
        break;
      case "project.removed": {
        const key = projectIdentity(frame.key);
        const current = projects.values.get(key);
        if (current !== undefined && ownedBy(current.target, source)) {
          removeProjected(projects, key);
          source.projectKeys.delete(key);
          patches.push({
            kind: "projects",
            upserts: [],
            removals: [{ key: current.key, target: current.target }],
          });
        }
        source.appliedCursor = frame.sequence;
        break;
      }
      case "thread.updated":
        addThread(source, frame.thread);
        source.appliedCursor = frame.sequence;
        patches.push({ kind: "threads", upserts: [frame.thread], removals: [] });
        break;
      case "thread.removed": {
        const key = threadIdentity(frame.key);
        const current = threads.values.get(key);
        if (current !== undefined && ownedBy(current.target, source)) {
          removeProjected(threads, key);
          source.threadKeys.delete(key);
          patches.push({ kind: "threads", upserts: [], removals: [current.key] });
        }
        source.appliedCursor = frame.sequence;
        break;
      }
      case "synchronized": {
        if (now === undefined) throw new Error("A synchronized frame requires its receive time.");
        const sourceFreshness = FactorySourceFreshness.make({
          target: frame.target,
          state: "fresh",
          reason: null,
          updatedAt: DateTime.toUtc(now),
          retryAt: null,
        });
        source.freshness = sourceFreshness;
        source.appliedCursor = frame.appliedCursor;
        setProjected(freshness, frame.target.registrationId, sourceFreshness);
        patches.push({ kind: "sourceFreshness", upserts: [sourceFreshness], removals: [] });
        break;
      }
    }
    return patches;
  };

  const replaceSourceRows = <Value extends { readonly target: FactoryRemoteTarget }>(input: {
    readonly projection: Projection<Value>;
    readonly keys: Set<string>;
    readonly source: SourceProjection;
    readonly values: ReadonlyArray<Value>;
    readonly identity: (value: Value) => string;
  }) => {
    const next = new Map(input.values.map((value) => [input.identity(value), value]));
    const removals: Value[] = [];
    const upserts: Value[] = [];
    for (const key of input.keys) {
      if (next.has(key)) continue;
      const current = input.projection.values.get(key);
      if (current !== undefined && ownedBy(current.target, input.source)) {
        removeProjected(input.projection, key);
        removals.push(current);
      }
      input.keys.delete(key);
    }
    for (const [key, value] of next) {
      input.keys.add(key);
      const current = input.projection.values.get(key);
      if (current === undefined || !sameJson(current, value)) {
        setProjected(input.projection, key, value);
        upserts.push(value);
      }
    }
    return { upserts, removals };
  };

  const uniqueValues = <Value extends object>(
    values: ReadonlyArray<Value>,
    identity: (value: Value) => string,
  ) => {
    const unique = new Map<string, Value>();
    for (const value of values) unique.set(identity(value), value);
    return [...unique.values()];
  };

  const applySourceUpdate = (update: SourceShell.SourceShellUpdate) =>
    lock.withPermit(
      Effect.gen(function* () {
        let patches: Array<FactoryOverviewPatch> = [];
        switch (update.kind) {
          case "snapshot":
            patches = replaceSources(update.sources);
            break;
          case "source": {
            const state = update.source;
            let source = sources.get(state.target.registrationId);
            if (source !== undefined && !sameTarget(source.target, state.target)) {
              const removed = removeSource(state.target.registrationId);
              patches.push(...sourceRemovalPatches(removed));
              source = undefined;
            }
            if (source === undefined) {
              source = newSource(state.target, state.freshness, state.appliedCursor);
              sources.set(state.target.registrationId, source);
              for (const value of state.projects) addProject(source, value);
              for (const value of state.threads) addThread(source, value);
              setProjected(freshness, state.target.registrationId, state.freshness);
              if (state.projects.length > 0) {
                patches.push({
                  kind: "projects",
                  upserts: uniqueValues(state.projects, (value) => projectIdentity(value.key)),
                  removals: [],
                });
              }
              if (state.threads.length > 0) {
                patches.push({
                  kind: "threads",
                  upserts: uniqueValues(state.threads, (value) => threadIdentity(value.key)),
                  removals: [],
                });
              }
              patches.push({
                kind: "sourceFreshness",
                upserts: [state.freshness],
                removals: [],
              });
            } else {
              source.freshness = state.freshness;
              setProjected(freshness, state.target.registrationId, state.freshness);
              patches.push({
                kind: "sourceFreshness",
                upserts: [state.freshness],
                removals: [],
              });
            }
            break;
          }
          case "frame": {
            const now = update.frame.kind === "synchronized" ? yield* DateTime.now : undefined;
            patches = applyFrame(update.frame, now);
            break;
          }
          case "removed": {
            const removed = removeSource(update.target.registrationId, update.target);
            patches = sourceRemovalPatches(removed);
            break;
          }
        }
        yield* checkAndPublish(patches);
      }),
    );

  const applyMetadataCommit = (commit: Metadata.FactoryMetadataCommit) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (commit.revision <= metadataRevision) return;
        metadataRevision = commit.revision;
        const patches = syncMetadata(commit.snapshot);
        yield* checkAndPublish(patches);
      }),
    );

  const start = Effect.suspend(() => {
    if (started) return Effect.void;
    started = true;
    return Effect.gen(function* () {
      const metadataWatch = yield* metadata.subscribeWithSnapshot.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      yield* lock.withPermit(
        Effect.sync(() => {
          metadataRevision = metadataWatch.initial.revision;
          syncMetadata(metadataWatch.initial.snapshot);
        }),
      );
      yield* Stream.runForEach(metadataWatch.changes, applyMetadataCommit).pipe(
        Effect.forkIn(scope, { startImmediately: true }),
      );
      const firstSourceUpdate = yield* Deferred.make<void>();
      yield* Stream.runForEach(sourceShell.subscribe, (update) =>
        applySourceUpdate(update).pipe(
          Effect.andThen(Deferred.succeed(firstSourceUpdate, undefined)),
          Effect.asVoid,
        ),
      ).pipe(Effect.forkIn(scope, { startImmediately: true }));
      yield* Deferred.await(firstSourceUpdate);
    });
  });

  const getSnapshot = lock.withPermit(snapshotLocked);

  const takeNext = (subscriber: Subscriber): Effect.Effect<FactoryOverviewEvent, FactoryError> =>
    Effect.suspend(() =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (subscriber.failure !== undefined) {
              return { kind: "failure" as const, error: subscriber.failure };
            }
            const next = subscriber.queue.shift();
            if (next !== undefined) {
              subscriber.queuedBytes -= next.bytes;
              if (next.event.type === "snapshot") subscriber.snapshotPending = false;
              return { kind: "event" as const, event: next.event };
            }
            const waiting = yield* Deferred.make<void>();
            subscriber.waiting = waiting;
            return { kind: "waiting" as const, waiting };
          }),
        )
        .pipe(
          Effect.flatMap((result) => {
            switch (result.kind) {
              case "failure":
                return Effect.fail(result.error);
              case "event":
                return Effect.succeed(result.event);
              case "waiting":
                return Deferred.await(result.waiting).pipe(
                  Effect.flatMap(() => takeNext(subscriber)),
                );
            }
          }),
        ),
    );

  const subscribe = Stream.unwrap(
    lock.withPermit(
      Effect.gen(function* () {
        const snapshot = yield* snapshotLocked;
        const subscriber: Subscriber = {
          queue: [],
          queuedBytes: 0,
          snapshotPending: false,
          waiting: undefined,
          failure: undefined,
        };
        const id = ++nextSubscriberId;
        subscribers.set(id, subscriber);
        return Stream.concat(
          Stream.succeed({ type: "snapshot" as const, snapshot }),
          Stream.fromEffectRepeat(takeNext(subscriber)),
        ).pipe(Stream.ensuring(lock.withPermit(Effect.sync(() => void subscribers.delete(id)))));
      }),
    ),
  );

  return Overview.of({ start, getSnapshot, subscribe });
});

export const layer = Layer.effect(Overview, make);
