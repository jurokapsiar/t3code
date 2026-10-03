import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FACTORY_MAX_SNAPSHOT_BYTES,
  EnvironmentId,
  FactoryEndpoint,
  FactoryOverviewEvent,
  FactoryEnvironmentView,
  FactoryOverviewSnapshot,
  FactoryRegistrationId,
  FactoryProjectKey,
  FactoryProjectSummary,
  FactoryRemoteTarget,
  FactorySourceFreshness,
  FactoryThreadKey,
  FactoryThreadSummary,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Metadata from "./Metadata.ts";
import * as Overview from "./Overview.ts";
import * as SourceShell from "./SourceShell.ts";

const at = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
const encodeOverviewEvent = Schema.encodeEffect(FactoryOverviewEvent);
const encodeOverviewSnapshot = Schema.encodeEffect(FactoryOverviewSnapshot);
const encodeOverviewJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeOverviewSnapshotJson = Schema.encodeSync(
  Schema.fromJsonString(FactoryOverviewSnapshot),
);
const encodedSnapshotBytes = (snapshot: typeof FactoryOverviewSnapshot.Type) =>
  new TextEncoder().encode(encodeOverviewSnapshotJson(snapshot)).byteLength;

const target = (registrationId: string, environmentId: string) =>
  FactoryRemoteTarget.make({
    registrationId: FactoryRegistrationId.make(registrationId),
    environmentId: EnvironmentId.make(environmentId),
  });

const project = (
  remote: FactoryRemoteTarget,
  projectId: string,
  title = `Project ${projectId}`,
  workspaceRoot = `/work/${projectId}`,
) =>
  FactoryProjectSummary.make({
    key: FactoryProjectKey.make({
      environmentId: remote.environmentId,
      projectId: ProjectId.make(projectId),
    }),
    target: remote,
    title,
    workspaceRoot,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });

const thread = (remote: FactoryRemoteTarget, threadId: string, projectId: string) =>
  FactoryThreadSummary.make({
    key: FactoryThreadKey.make({
      environmentId: remote.environmentId,
      threadId: ThreadId.make(threadId),
    }),
    target: remote,
    project: FactoryProjectKey.make({
      environmentId: remote.environmentId,
      projectId: ProjectId.make(projectId),
    }),
    title: `Thread ${threadId}`,
    sourceStatus: "running",
    classification: "active",
    providerInstanceId: ProviderInstanceId.make("test-provider"),
    model: "test-model",
    branch: null,
    worktreePath: null,
    settled: false,
    settledAt: null,
    settledOverride: null,
    providerCompletedAt: null,
    finalizedAt: null,
    createdAt: at,
    updatedAt: at,
  });

const sourceState = (
  remote: FactoryRemoteTarget,
  projects: ReadonlyArray<FactoryProjectSummary> = [],
  threads: ReadonlyArray<FactoryThreadSummary> = [],
  state: "synchronizing" | "fresh" | "stale" | "offline" | "blocked" = "fresh",
): SourceShell.SourceShellState => ({
  target: remote,
  appliedCursor: 0,
  freshness: FactorySourceFreshness.make({
    target: remote,
    state,
    reason: state === "stale" ? "transport" : null,
    updatedAt: state === "fresh" ? at : null,
    retryAt: null,
  }),
  projects,
  threads,
});

const makeHarness = (
  sources: ReadonlyArray<SourceShell.SourceShellState> = [],
  metadataService?: Metadata.Metadata["Service"],
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const changes = yield* PubSub.unbounded<SourceShell.SourceShellUpdate>();
    const consumed = yield* Deferred.make<void>();
    const shell = SourceShell.SourceShell.of({
      start: Effect.void,
      getStates: Effect.succeed(sources),
      subscribe: Stream.concat(
        Stream.succeed({ kind: "snapshot" as const, sources }),
        Stream.fromPubSub(changes).pipe(
          Stream.ensuring(Deferred.succeed(consumed, undefined).pipe(Effect.asVoid)),
        ),
      ),
    });
    const dependencies = Layer.mergeAll(
      metadataService === undefined
        ? Metadata.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory))
        : Layer.succeed(Metadata.Metadata, metadataService),
      Layer.succeed(SourceShell.SourceShell, shell),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const services = yield* Layer.buildWithScope(
      Overview.layer.pipe(Layer.provideMerge(dependencies)),
      scope,
    );
    const overview = Context.get(services, Overview.Overview);
    const metadata = Context.get(services, Metadata.Metadata);
    yield* overview.start;
    return {
      metadata,
      overview,
      publish: (update: SourceShell.SourceShellUpdate) =>
        PubSub.publish(changes, update).pipe(Effect.asVoid),
      finish: PubSub.shutdown(changes).pipe(Effect.andThen(Deferred.await(consumed))),
    };
  });

describe("checkOverviewLimits", () => {
  it("rejects an overview with more than 10,000 threads", () => {
    expect(
      Overview.checkOverviewLimits({
        threadCount: 10_001,
        encodedBytes: 1,
      }),
    ).toEqual({ ok: false, reason: "overview-too-large" });
  });

  it("accepts exactly 10,000 threads and 8 MiB", () => {
    expect(
      Overview.checkOverviewLimits({
        threadCount: 10_000,
        encodedBytes: 8 * 1024 * 1024,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects one byte over the 8 MiB limit", () => {
    expect(
      Overview.checkOverviewLimits({
        threadCount: 10_000,
        encodedBytes: 8 * 1024 * 1024 + 1,
      }),
    ).toEqual({ ok: false, reason: "overview-too-large" });
  });
});

describe("Factory overview", () => {
  it.effect("returns standalone projects and source freshness in a full snapshot", () =>
    Effect.gen(function* () {
      const remote = target("registration", "environment");
      const projectOnly = project(remote, "empty-project");
      const harness = yield* makeHarness([sourceState(remote, [projectOnly])]);
      const snapshot = yield* harness.overview.getSnapshot;

      expect(snapshot.projects).toEqual([projectOnly]);
      expect(snapshot.threads).toEqual([]);
      expect(snapshot.sourceFreshness).toEqual([sourceState(remote).freshness]);
      expect(snapshot.generation).toBeTruthy();
      expect(snapshot.revision).toBe(0);
    }),
  );

  it.effect("publishes committed metadata as a contiguous overview patch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 4 });
      const initial = yield* Queue.take(queue);
      const group = yield* harness.metadata.createGroup({ name: "Review" });
      const event = yield* Queue.take(queue);
      const persisted = yield* harness.metadata.getSnapshot;

      expect(event).toMatchObject({
        type: "patch",
        generation: initial.type === "snapshot" ? initial.snapshot.generation : "",
        revision: initial.type === "snapshot" ? initial.snapshot.revision + 1 : -1,
        patch: { kind: "metadata", groups: [group] },
      });
      expect(persisted.groups).toContainEqual(group);
    }),
  );

  it.effect("projects environment, favorite, and group commits without credential references", () =>
    Effect.gen(function* () {
      const remote = target("metadata-projection", "metadata-projection-env");
      const harness = yield* makeHarness();
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 8 });
      yield* Queue.take(queue);
      const environment = FactoryEnvironmentView.make({
        registrationId: remote.registrationId,
        environmentId: remote.environmentId,
        endpoint: FactoryEndpoint.make("https://source.example"),
        label: "Source",
        platform: null,
        enabled: false,
        state: "pending",
        credentialStorage: null,
        credentialExpiresAt: null,
        renewal: "unsupported",
        cleanupPending: false,
        lastSeenAt: null,
        revision: 0,
      });
      yield* harness.metadata.createEnvironment(environment);
      const environmentCreated = yield* Queue.take(queue);
      const group = yield* harness.metadata.createGroup({ name: "Favorite group" });
      const groupCreated = yield* Queue.take(queue);
      yield* harness.metadata.setFavorite({
        target: { kind: "group", groupId: group.id },
        favorite: true,
      });
      const favoriteSet = yield* Queue.take(queue);
      yield* harness.metadata.markEnrollment({
        registrationId: remote.registrationId,
        credentialStorage: "protected-file",
        credentialItemKey: "private-credential-reference",
        credentialExpiresAt: null,
      });
      const enrollmentUpdated = yield* Queue.take(queue);
      const snapshot = yield* harness.overview.getSnapshot;

      expect(environmentCreated).toMatchObject({
        type: "patch",
        revision: 1,
        patch: { kind: "environments", upserts: [{ registrationId: remote.registrationId }] },
      });
      expect(groupCreated).toMatchObject({
        type: "patch",
        revision: 2,
        patch: { kind: "metadata", groups: [group] },
      });
      expect(favoriteSet).toMatchObject({
        type: "patch",
        revision: 3,
        patch: { kind: "metadata", favorites: [{ target: { kind: "group", groupId: group.id } }] },
      });
      expect(enrollmentUpdated).toMatchObject({
        type: "patch",
        revision: 4,
        patch: {
          kind: "environments",
          upserts: [{ registrationId: remote.registrationId, credentialStorage: "protected-file" }],
        },
      });
      expect(snapshot.groups).toContainEqual(group);
      expect(snapshot.favorites).toEqual([
        { target: { kind: "group", groupId: group.id }, order: 0 },
      ]);
      const encodedEvents = yield* Effect.forEach(
        [environmentCreated, groupCreated, favoriteSet, enrollmentUpdated],
        (event) => encodeOverviewEvent(event),
      );
      const encodedSnapshot = yield* encodeOverviewSnapshot(snapshot);
      const encodedJson = yield* encodeOverviewJson([...encodedEvents, encodedSnapshot]);
      expect(encodedJson).not.toContain("private-credential-reference");
    }),
  );

  it.effect("keeps source rows while marking their freshness stale", () =>
    Effect.gen(function* () {
      const remote = target("stale-source", "stale-env");
      const expectedProject = project(remote, "project");
      const expectedThread = thread(remote, "thread", "project");
      const harness = yield* makeHarness([
        sourceState(remote, [expectedProject], [expectedThread]),
      ]);
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 4 });
      yield* Queue.take(queue);

      yield* harness.publish({
        kind: "source",
        source: sourceState(remote, [], [], "stale"),
      });
      const event = yield* Queue.take(queue);
      const snapshot = yield* harness.overview.getSnapshot;

      expect(event).toMatchObject({
        type: "patch",
        patch: { kind: "sourceFreshness", upserts: [{ state: "stale" }] },
      });
      expect(snapshot.projects).toEqual([expectedProject]);
      expect(snapshot.threads).toEqual([expectedThread]);
      expect(snapshot.sourceFreshness[0]?.state).toBe("stale");
    }),
  );

  it.effect("replaces one source snapshot without changing other sources or metadata", () =>
    Effect.gen(function* () {
      const first = target("first", "env-first");
      const second = target("second", "env-second");
      const oldProject = project(first, "old-project");
      const oldThread = thread(first, "old-thread", "old-project");
      const otherProject = project(second, "other-project");
      const otherThread = thread(second, "other-thread", "other-project");
      const harness = yield* makeHarness([
        sourceState(first, [oldProject], [oldThread]),
        sourceState(second, [otherProject], [otherThread]),
      ]);
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 8 });
      yield* Queue.take(queue);
      const group = yield* harness.metadata.createGroup({ name: "Keep group" });
      yield* Queue.take(queue);
      const nextProject = project(first, "next-project");
      const nextThread = thread(first, "next-thread", "next-project");

      yield* harness.publish({
        kind: "frame",
        frame: {
          kind: "snapshot",
          target: first,
          sequence: 7,
          projects: [nextProject],
          threads: [nextThread],
        },
      });
      const projectPatch = yield* Queue.take(queue);
      const threadPatch = yield* Queue.take(queue);
      const snapshot = yield* harness.overview.getSnapshot;

      expect(projectPatch).toMatchObject({
        type: "patch",
        revision: 2,
        patch: { kind: "projects", upserts: [nextProject], removals: [{ key: oldProject.key }] },
      });
      expect(threadPatch).toMatchObject({
        type: "patch",
        revision: 3,
        patch: { kind: "threads", upserts: [nextThread], removals: [oldThread.key] },
      });
      expect(snapshot.projects).toEqual([nextProject, otherProject]);
      expect(snapshot.threads).toEqual([nextThread, otherThread]);
      expect(snapshot.groups).toContainEqual(group);
    }),
  );

  it.effect("removes only rows owned by a disconnected source", () =>
    Effect.gen(function* () {
      const first = target("disconnect-first", "disconnect-env-first");
      const second = target("disconnect-second", "disconnect-env-second");
      const retainedProject = project(second, "retained");
      const retainedThread = thread(second, "retained-thread", "retained");
      const harness = yield* makeHarness([
        sourceState(
          first,
          [project(first, "removed")],
          [thread(first, "removed-thread", "removed")],
        ),
        sourceState(second, [retainedProject], [retainedThread]),
      ]);
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 4 });
      yield* Queue.take(queue);

      yield* harness.publish({ kind: "removed", target: first });
      const projectPatch = yield* Queue.take(queue);
      const threadPatch = yield* Queue.take(queue);
      const freshnessPatch = yield* Queue.take(queue);
      const snapshot = yield* harness.overview.getSnapshot;

      expect(projectPatch).toMatchObject({
        type: "patch",
        patch: { kind: "projects", removals: [{ key: { projectId: "removed" } }] },
      });
      expect(threadPatch).toMatchObject({
        type: "patch",
        patch: { kind: "threads", removals: [{ threadId: "removed-thread" }] },
      });
      expect(freshnessPatch).toMatchObject({
        type: "patch",
        patch: { kind: "sourceFreshness", removals: [first] },
      });
      expect(snapshot.projects).toEqual([retainedProject]);
      expect(snapshot.threads).toEqual([retainedThread]);
      expect(snapshot.sourceFreshness.map((item) => item.target)).toEqual([second]);
    }),
  );

  it.effect("merges enrichment snapshots without removing authoritative rows", () =>
    Effect.gen(function* () {
      const remote = target("enrichment", "enrichment-env");
      const existing = project(remote, "existing", "Existing", "/work/existing");
      const existingThread = thread(remote, "existing-thread", "existing");
      const harness = yield* makeHarness([sourceState(remote, [existing], [existingThread])]);
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 4 });
      yield* Queue.take(queue);
      const enriched = project(remote, "enriched", "Enriched", "/work/enriched");

      yield* harness.publish({
        kind: "frame",
        frame: {
          kind: "snapshot",
          target: remote,
          sequence: 0,
          projects: [enriched],
          threads: [],
          resolvedRepositoryIdentityRoots: ["/work/enriched"],
        },
      });
      yield* Queue.take(queue);
      const snapshot = yield* harness.overview.getSnapshot;

      expect(snapshot.projects).toEqual([enriched, existing]);
      expect(snapshot.threads).toEqual([existingThread]);
    }),
  );

  it.effect("keys duplicate local IDs by environment and replaces duplicate domain keys", () =>
    Effect.gen(function* () {
      const first = target("first", "env-first");
      const second = target("second", "env-second");
      const harness = yield* makeHarness([
        sourceState(
          first,
          [project(first, "shared", "Earlier"), project(first, "shared", "Later")],
          [thread(first, "shared-thread", "shared"), thread(first, "shared-thread", "shared")],
        ),
        sourceState(
          second,
          [project(second, "shared")],
          [thread(second, "shared-thread", "shared")],
        ),
      ]);
      const snapshot = yield* harness.overview.getSnapshot;

      expect(snapshot.projects).toHaveLength(2);
      expect(snapshot.threads).toHaveLength(2);
      expect(
        snapshot.projects.find((item) => item.key.environmentId === first.environmentId)?.title,
      ).toBe("Later");
      expect(snapshot.projects.map((item) => item.key.environmentId)).toEqual([
        first.environmentId,
        second.environmentId,
      ]);
    }),
  );

  it.effect("starts with an empty remote cache after restart and retains metadata", () =>
    Effect.gen(function* () {
      const remote = target("restart", "restart-env");
      const first = yield* makeHarness([
        sourceState(
          remote,
          [project(remote, "remote-project")],
          [thread(remote, "remote-thread", "remote-project")],
        ),
      ]);
      const firstSnapshot = yield* first.overview.getSnapshot;
      const group = yield* first.metadata.createGroup({ name: "Retained" });
      const second = yield* makeHarness([], first.metadata);
      const restarted = yield* second.overview.getSnapshot;

      expect(restarted.generation).not.toBe(firstSnapshot.generation);
      expect(restarted.projects).toEqual([]);
      expect(restarted.threads).toEqual([]);
      expect(restarted.groups).toContainEqual(group);
    }),
  );

  it.effect("enforces the 10,000 thread limit across source snapshots", () =>
    Effect.gen(function* () {
      const first = target("first", "env-first");
      const second = target("second", "env-second");
      const exactThreads = Array.from({ length: 10_000 }, (_, index) =>
        thread(first, `thread-${index}`, "project"),
      );
      const exact = yield* makeHarness([sourceState(first, [], exactThreads)]);
      expect((yield* exact.overview.getSnapshot).threads).toHaveLength(10_000);

      const overflow = yield* makeHarness([
        sourceState(first, [], exactThreads),
        sourceState(second, [], [thread(second, "thread-over", "project")]),
      ]);
      const error = yield* Effect.flip(overflow.overview.getSnapshot);
      expect(error).toMatchObject({ code: "overview-too-large" });
    }),
  );

  it.effect("rechecks snapshot limits after metadata growth", () =>
    Effect.gen(function* () {
      const remote = target("metadata-growth", "metadata-growth-env");
      const baselineHarness = yield* makeHarness([
        sourceState(remote, [project(remote, "large", "x")]),
      ]);
      const baseline = yield* baselineHarness.overview.getSnapshot;
      const titleLength = 1 + FACTORY_MAX_SNAPSHOT_BYTES - encodedSnapshotBytes(baseline);
      const exact = yield* makeHarness([
        sourceState(remote, [project(remote, "large", "x".repeat(titleLength))]),
      ]);
      const subscriber = yield* Stream.toQueue(exact.overview.subscribe, { capacity: 1 });
      const snapshotEvent = yield* Queue.take(subscriber);
      expect(snapshotEvent.type).toBe("snapshot");
      expect(
        snapshotEvent.type === "snapshot" ? encodedSnapshotBytes(snapshotEvent.snapshot) : -1,
      ).toBe(FACTORY_MAX_SNAPSHOT_BYTES);

      yield* exact.metadata.createGroup({ name: "Push over the limit" });
      const streamError = yield* Effect.flip(Stream.runCollect(Stream.fromQueue(subscriber)));
      const snapshotError = yield* Effect.flip(exact.overview.getSnapshot);
      expect(streamError).toMatchObject({ code: "overview-too-large" });
      expect(snapshotError).toMatchObject({ code: "overview-too-large" });
    }),
  );

  it.effect("fails an overloaded item queue with a typed resubscribe error", () =>
    Effect.gen(function* () {
      const remote = target("item-overflow", "item-overflow-env");
      const harness = yield* makeHarness([sourceState(remote)]);
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 1 });
      const initial = yield* Queue.take(queue);
      expect(initial.type).toBe("snapshot");

      for (let index = 0; index < 300; index++) {
        const next = project(remote, `project-${index}`);
        yield* harness.publish({
          kind: "frame",
          frame: {
            kind: "project.updated",
            target: remote,
            sequence: index + 1,
            project: next,
          },
        });
      }
      yield* harness.finish;

      const error = yield* Effect.flip(Stream.runCollect(Stream.fromQueue(queue)));
      expect(error).toMatchObject({ code: "overview-stream-overflow" });
      const recoveryQueue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 1 });
      const recovered = yield* Queue.take(recoveryQueue);
      expect(recovered.type).toBe("snapshot");
      if (recovered.type === "snapshot") {
        expect(recovered.snapshot.projects).toHaveLength(300);
      }
    }),
  );

  it.effect("fails a byte-overloaded subscriber without partial success", () =>
    Effect.gen(function* () {
      const remote = target("byte-queue-overflow", "byte-queue-overflow-env");
      const harness = yield* makeHarness([sourceState(remote)]);
      const queue = yield* Stream.toQueue(harness.overview.subscribe, { capacity: 1 });
      const initial = yield* Queue.take(queue);
      expect(initial.type).toBe("snapshot");
      const largeProject = project(remote, "large", "x".repeat(1024 * 1024 + 1));
      yield* harness.publish({
        kind: "frame",
        frame: {
          kind: "project.updated",
          target: remote,
          sequence: 1,
          project: largeProject,
        },
      });
      yield* harness.finish;

      const error = yield* Effect.flip(Stream.runCollect(Stream.fromQueue(queue)));
      expect(error).toMatchObject({ code: "overview-stream-overflow" });
      const snapshot = yield* harness.overview.getSnapshot;
      expect(snapshot.projects).toEqual([largeProject]);
    }),
  );

  it.effect("enforces the exact encoded 8 MiB snapshot boundary", () =>
    Effect.gen(function* () {
      const remote = target("byte-limit", "byte-env");
      const small = yield* makeHarness([sourceState(remote, [project(remote, "large", "x")])]);
      const smallQueue = yield* Stream.toQueue(small.overview.subscribe, { capacity: 4 });
      const initial = yield* Queue.take(smallQueue);
      const group = yield* small.metadata.createGroup({ name: "Included metadata" });
      yield* Queue.take(smallQueue);
      const baseline = yield* small.overview.getSnapshot;
      expect(baseline.groups).toContainEqual(group);
      const baselineBytes = encodedSnapshotBytes(baseline);
      const titleLength = 1 + FACTORY_MAX_SNAPSHOT_BYTES - baselineBytes;
      const exact = yield* makeHarness(
        [sourceState(remote, [project(remote, "large", "x".repeat(titleLength))])],
        small.metadata,
      );
      const exactSnapshot = yield* exact.overview.getSnapshot;
      expect(encodedSnapshotBytes(exactSnapshot)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);

      const over = yield* makeHarness(
        [sourceState(remote, [project(remote, "large", "x".repeat(titleLength + 1))])],
        small.metadata,
      );
      const error = yield* Effect.flip(over.overview.getSnapshot);
      expect(error).toMatchObject({ code: "overview-too-large" });
      expect(initial.type).toBe("snapshot");
    }),
  );

  it.effect("rejects a patch when revision ten makes an exact snapshot too large", () =>
    Effect.gen(function* () {
      const remote = target("revision-boundary", "revision-boundary-env");
      const baselineHarness = yield* makeHarness([
        sourceState(remote, [project(remote, "filler", "x"), project(remote, "mutable", "x")]),
      ]);
      const baseline = yield* baselineHarness.overview.getSnapshot;
      const titleLength = 1 + FACTORY_MAX_SNAPSHOT_BYTES - encodedSnapshotBytes(baseline);
      const exact = yield* makeHarness([
        sourceState(remote, [
          project(remote, "filler", "x".repeat(titleLength)),
          project(remote, "mutable", "x"),
        ]),
      ]);
      const queue = yield* Stream.toQueue(exact.overview.subscribe, { capacity: 4 });
      const initial = yield* Queue.take(queue);
      expect(initial).toMatchObject({ type: "snapshot", snapshot: { revision: 0 } });

      for (let revision = 1; revision <= 9; revision++) {
        const title = revision % 2 === 0 ? "x" : "y";
        yield* exact.publish({
          kind: "frame",
          frame: {
            kind: "project.updated",
            target: remote,
            sequence: revision,
            project: project(remote, "mutable", title),
          },
        });
        expect(yield* Queue.take(queue)).toMatchObject({ type: "patch", revision });
      }

      const revisionNine = yield* exact.overview.getSnapshot;
      expect(revisionNine.revision).toBe(9);
      expect(encodedSnapshotBytes(revisionNine)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);
      yield* exact.publish({
        kind: "frame",
        frame: {
          kind: "project.updated",
          target: remote,
          sequence: 10,
          project: project(remote, "mutable", "z"),
        },
      });

      const streamResult = yield* Effect.exit(
        Effect.flip(Stream.runCollect(Stream.fromQueue(queue).pipe(Stream.take(1)))),
      );
      expect(Exit.isSuccess(streamResult)).toBe(true);
      if (!Exit.isSuccess(streamResult)) return;
      expect(streamResult.value).toMatchObject({ code: "overview-too-large" });
      const snapshotResult = yield* Effect.exit(exact.overview.getSnapshot);
      expect(Exit.isSuccess(snapshotResult)).toBe(true);
      if (!Exit.isSuccess(snapshotResult)) return;
      const recovery = snapshotResult.value;
      expect(recovery.revision).toBe(9);
      expect(encodedSnapshotBytes(recovery)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);
      expect(encodedSnapshotBytes({ ...recovery, revision: 10 })).toBe(
        FACTORY_MAX_SNAPSHOT_BYTES + 1,
      );
      const recoveryQueue = yield* Stream.toQueue(exact.overview.subscribe, { capacity: 1 });
      const recoveredEvent = yield* Queue.take(recoveryQueue);
      expect(recoveredEvent.type).toBe("snapshot");
      if (recoveredEvent.type === "snapshot") {
        expect(recoveredEvent.snapshot.revision).toBe(9);
        expect(encodedSnapshotBytes(recoveredEvent.snapshot)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);
      }
    }),
  );

  it.effect("preflights every patch in a batch against its final revision", () =>
    Effect.gen(function* () {
      const remote = target("batch-boundary", "batch-boundary-env");
      const fillerTarget = target("batch-filler", "batch-filler-env");
      const existingThread = thread(remote, "large-thread", "large");
      const baselineHarness = yield* makeHarness([
        sourceState(fillerTarget, [project(fillerTarget, "filler", "x")]),
        sourceState(remote, [project(remote, "mutable", "x")], [existingThread]),
      ]);
      const baseline = yield* baselineHarness.overview.getSnapshot;
      const titleLength = 1 + FACTORY_MAX_SNAPSHOT_BYTES - encodedSnapshotBytes(baseline);
      const exact = yield* makeHarness([
        sourceState(fillerTarget, [project(fillerTarget, "filler", "x".repeat(titleLength))]),
        sourceState(remote, [project(remote, "mutable", "x")], [existingThread]),
      ]);
      const queue = yield* Stream.toQueue(exact.overview.subscribe, { capacity: 4 });
      yield* Queue.take(queue);

      for (let revision = 1; revision <= 8; revision++) {
        const title = revision % 2 === 0 ? "x" : "y";
        yield* exact.publish({
          kind: "frame",
          frame: {
            kind: "project.updated",
            target: remote,
            sequence: revision,
            project: project(remote, "mutable", title),
          },
        });
        expect(yield* Queue.take(queue)).toMatchObject({ type: "patch", revision });
      }
      const revisionEight = yield* exact.overview.getSnapshot;
      expect(encodedSnapshotBytes(revisionEight)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);

      yield* exact.publish({
        kind: "frame",
        frame: {
          kind: "snapshot",
          target: remote,
          sequence: 9,
          projects: [project(remote, "mutable", "z")],
          threads: [{ ...existingThread, title: "thread large-thread" }],
        },
      });

      const streamResult = yield* Effect.exit(
        Effect.flip(Stream.runCollect(Stream.fromQueue(queue).pipe(Stream.take(1)))),
      );
      expect(Exit.isSuccess(streamResult)).toBe(true);
      if (!Exit.isSuccess(streamResult)) return;
      expect(streamResult.value).toMatchObject({ code: "overview-too-large" });
      const snapshotResult = yield* Effect.exit(exact.overview.getSnapshot);
      expect(Exit.isSuccess(snapshotResult)).toBe(true);
      if (!Exit.isSuccess(snapshotResult)) return;
      const recovery = snapshotResult.value;
      expect(recovery.revision).toBe(8);
      expect(encodedSnapshotBytes(recovery)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);
      expect(encodedSnapshotBytes({ ...recovery, revision: 10 })).toBe(
        FACTORY_MAX_SNAPSHOT_BYTES + 1,
      );
      const recoveryQueue = yield* Stream.toQueue(exact.overview.subscribe, { capacity: 1 });
      const recoveredEvent = yield* Queue.take(recoveryQueue);
      expect(recoveredEvent.type).toBe("snapshot");
      if (recoveredEvent.type === "snapshot") {
        expect(recoveredEvent.snapshot.revision).toBe(8);
        expect(encodedSnapshotBytes(recoveredEvent.snapshot)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);
      }
    }),
  );
});
