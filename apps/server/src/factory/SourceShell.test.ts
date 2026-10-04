import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  FactoryEnvironmentView,
  FactoryRegistrationId,
  FactoryRemoteTarget,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Connections from "./Connections.ts";
import * as CredentialRenewal from "./CredentialRenewal.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as Metadata from "./Metadata.ts";
import * as SourceShell from "./SourceShell.ts";
import * as FakeSource from "./testkit/FakeSource.ts";
import { config as sourceConfig } from "./testkit/sourceConfig.ts";

const target = (registrationId: string, environmentId: string) =>
  FactoryRemoteTarget.make({
    registrationId: FactoryRegistrationId.make(registrationId),
    environmentId: EnvironmentId.make(environmentId),
  });

const project = (id: string, title: string, workspaceRoot = `/work/${id}`) =>
  ({
    id: ProjectId.make(id),
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  }) as OrchestrationProjectShell;

const thread = (id: string, projectId: string) => {
  const providerInstanceId = "test-provider" as OrchestrationV2ThreadShell["providerInstanceId"];
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: `Thread ${id}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    status: "running",
    branch: null,
    worktreePath: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    settledAt: null,
    settledOverride: null,
    latestRunCompletedAt: null,
    createdAt: DateTime.makeUnsafe("2026-10-03T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-03T00:00:00.000Z"),
    archivedAt: null,
  } as unknown as OrchestrationV2ThreadShell;
};

const snapshot = (
  sequence: number,
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell> = [],
  archivedThreads: ReadonlyArray<OrchestrationV2ThreadShell> = [],
): OrchestrationV2ShellStreamItem =>
  ({
    kind: "snapshot",
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: sequence,
      projects,
      threads,
      archivedThreads,
    },
  }) as OrchestrationV2ShellStreamItem;

const harness = Effect.gen(function* () {
  const fake = yield* FakeSource.make;
  const credentials = new Map<string, CredentialStore.StoredCredential>();
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const dependencies = Layer.mergeAll(
    Metadata.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    fake.layer,
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("factory")),
    }),
    Layer.succeed(CredentialStore.CredentialStore, {
      get: (key) => Effect.succeed(Option.fromNullishOr(credentials.get(key))),
      set: (key, credential) => Effect.sync(() => void credentials.set(key, credential)),
      remove: (key) => Effect.sync(() => void credentials.delete(key)),
    }),
    Layer.succeed(
      CredentialRenewal.CredentialRenewal,
      CredentialRenewal.CredentialRenewal.of({
        runOnce: Effect.void,
        start: Effect.void,
        subscribeRenewals: Stream.never,
      }),
    ),
  ).pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const settings = yield* Config.ServerConfig;
          return Config.layer({ ...settings, factoryEnabled: true });
        }),
      ).pipe(Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-source-shell-" }))),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const connectionLayer = Connections.layer.pipe(Layer.provideMerge(dependencies));
  const services = yield* Layer.buildWithScope(
    SourceShell.layer.pipe(Layer.provideMerge(connectionLayer)),
    scope,
  );
  const connections = Context.get(services, Connections.Connections);
  const sourceShell = Context.get(services, SourceShell.SourceShell);
  const metadata = Context.get(services, Metadata.Metadata);
  const updates = yield* Stream.toQueue(sourceShell.subscribe, { capacity: 256 });
  const connectionUpdates = yield* Stream.toQueue(connections.subscribeStates, { capacity: 64 });
  const register = Effect.fnUntraced(function* (id: string, environmentId = `env-${id}`) {
    const now = yield* DateTime.now;
    credentials.set(id, {
      token: `token-${id}`,
      sourceSessionId: AuthSessionId.make(`session-${id}`),
      scopes: ["orchestration:read"],
      issuedAt: now,
      expiresAt: DateTime.add(now, { days: 30 }),
    });
    const registrationId = FactoryRegistrationId.make(id);
    yield* metadata.createEnvironment(
      FactoryEnvironmentView.make({
        registrationId,
        environmentId: EnvironmentId.make(environmentId),
        endpoint: `https://${id}.example`,
        label: id,
        platform: null,
        enabled: false,
        state: "pending",
        credentialStorage: null,
        credentialExpiresAt: null,
        renewal: "unsupported",
        lastSeenAt: null,
        revision: 0,
      }),
    );
    yield* metadata.markEnrollment({
      registrationId,
      credentialStorage: "secure-vault",
      credentialItemKey: id,
      credentialExpiresAt: null,
    });
    return target(id, environmentId);
  });
  const start = Effect.gen(function* () {
    yield* connections.start;
    yield* sourceShell.start;
  });
  const nextUpdate = (predicate: (update: SourceShell.SourceShellUpdate) => boolean) =>
    Stream.fromQueue(updates).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  const nextFrame = (kind: SourceShell.SourceShellFrame["kind"], environmentId?: string) =>
    nextUpdate(
      (update) =>
        update.kind === "frame" &&
        update.frame.kind === kind &&
        (environmentId === undefined || update.frame.target.environmentId === environmentId),
    );
  const state = (environmentId: string) =>
    Effect.map(sourceShell.getStates, (states) =>
      states.find((entry) => entry.target.environmentId === environmentId),
    );
  return {
    fake,
    connections,
    sourceShell,
    metadata,
    updates,
    connectionUpdates,
    persistedState: Context.get(services, SqlClient.SqlClient)<{
      events: number;
      projects: number;
      threads: number;
    }>`SELECT
      (SELECT count(*) FROM orchestration_events) +
      (SELECT count(*) FROM orchestration_v2_events) AS events,
      (SELECT count(*) FROM projection_projects) AS projects,
      (SELECT count(*) FROM projection_threads) +
      (SELECT count(*) FROM orchestration_v2_projection_threads) AS threads`,
    register,
    start,
    nextUpdate,
    nextFrame,
    state,
    scope,
  };
});

it.effect("binds control freshness to the exact source connection lease", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const targetA = yield* h.register("a");
    yield* h.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(sourceConfig("env-a"));
    yield* Queue.take(attempt.shellCalls);
    const access = yield* h.connections.resolveTarget(targetA);
    expect(yield* h.sourceShell.isSynchronized(access)).toBe(false);
    yield* attempt.emitShell(snapshot(10, []));
    yield* h.nextFrame("snapshot", "env-a");
    yield* attempt.emitShell({ kind: "synchronized" });
    yield* h.nextFrame("synchronized", "env-a");
    expect(yield* h.sourceShell.isSynchronized(access)).toBe(true);
    expect(yield* h.sourceShell.isSynchronized({ ...access, connectionId: {} })).toBe(false);
    expect(yield* h.sourceShell.isSynchronized({ ...access, target: target("a", "env-b") })).toBe(
      false,
    );
    yield* attempt.fail("authentication");
    yield* h.nextUpdate(
      (update) => update.kind === "source" && update.source.freshness.state === "blocked",
    );
    expect(yield* h.sourceShell.isSynchronized(access)).toBe(false);
  }),
);

it("does not advance the applied cursor when a source update fails", () => {
  expect(SourceShell.nextAppliedCursor({ previous: 10, incoming: 11, applied: false })).toBe(10);
});

it.effect(
  "requests a full snapshot after disable and re-enable before recovering all rows as fresh",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const targetA = yield* h.register("a");
      yield* h.start;
      const first = yield* Queue.take(h.fake.attempts);
      yield* first.ready(sourceConfig("env-a"));
      yield* Queue.take(first.shellCalls);
      yield* first.emitShell(
        snapshot(
          10,
          [project("p", "Retained"), project("q", "Other")],
          [thread("t", "p"), thread("u", "q")],
        ),
      );
      yield* h.nextFrame("snapshot", "env-a");
      yield* first.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-a");
      yield* h.connections.disable(targetA.registrationId);
      yield* h.nextUpdate((update) => update.kind === "removed");
      yield* first.closed;
      expect(yield* h.state("env-a")).toBeUndefined();
      const disabled = (yield* h.metadata.listEnvironments)[0]!;
      yield* h.connections.updateEnvironment({
        registrationId: disabled.registrationId,
        revision: disabled.revision,
        enabled: true,
      });
      const second = yield* Queue.take(h.fake.attempts);
      yield* second.ready(sourceConfig("env-a"));
      const request = yield* Queue.take(second.shellCalls);
      expect(request).not.toHaveProperty("afterSequence");
      expect((yield* h.state("env-a"))?.freshness.state).toBe("synchronizing");
      yield* second.emitShell(
        snapshot(
          11,
          [project("p", "Recovered"), project("q", "Other")],
          [thread("t", "p"), thread("u", "q")],
        ),
      );
      yield* h.nextFrame("snapshot", "env-a");
      const recovered = (yield* h.state("env-a"))!;
      expect(recovered.projects.map((row) => row.key.projectId)).toEqual(["p", "q"]);
      expect(recovered.threads.map((row) => row.key.threadId)).toEqual(["t", "u"]);
      expect(recovered.freshness.state).toBe("synchronizing");
      yield* second.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-a");
      expect((yield* h.state("env-a"))?.freshness.state).toBe("fresh");
      expect(yield* h.persistedState).toEqual([{ events: 0, projects: 0, threads: 0 }]);
    }),
);

it.effect(
  "increases shell-failure backoff despite repeated successful configs and resets only after synchronization",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register("a");
      yield* h.start;
      const first = yield* Queue.take(h.fake.attempts);
      yield* first.ready(sourceConfig("env-a"));
      yield* Queue.take(first.shellCalls);
      yield* first.failShell("transport");
      yield* h.nextUpdate(
        (update) => update.kind === "source" && update.source.freshness.state === "offline",
      );
      yield* first.closed;
      yield* TestClock.adjust("499 millis");
      expect(h.fake.calls).toHaveLength(1);
      yield* TestClock.adjust("1 milli");
      const second = yield* Queue.take(h.fake.attempts);
      yield* second.ready(sourceConfig("env-a"));
      yield* Queue.take(second.shellCalls);
      yield* second.failShell("transport");
      yield* h.nextUpdate(
        (update) => update.kind === "source" && update.source.freshness.state === "offline",
      );
      yield* second.closed;
      yield* TestClock.adjust("999 millis");
      expect(h.fake.calls).toHaveLength(2);
      yield* TestClock.adjust("1 milli");
      const third = yield* Queue.take(h.fake.attempts);
      yield* third.ready(sourceConfig("env-a"));
      yield* Queue.take(third.shellCalls);
      yield* third.emitShell(snapshot(7, []));
      yield* h.nextFrame("snapshot", "env-a");
      yield* third.failShell("transport");
      yield* h.nextUpdate(
        (update) => update.kind === "source" && update.source.freshness.state === "offline",
      );
      yield* third.closed;
      yield* TestClock.adjust("1999 millis");
      expect(h.fake.calls).toHaveLength(3);
      yield* TestClock.adjust("1 milli");
      const synchronized = yield* Queue.take(h.fake.attempts);
      yield* synchronized.ready(sourceConfig("env-a"));
      expect(yield* Queue.take(synchronized.shellCalls)).toMatchObject({ afterSequence: 7 });
      const stale = yield* h.connections.resolveTarget(target("a", "env-a"));
      yield* synchronized.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-a");
      yield* synchronized.failShell("transport");
      yield* h.nextUpdate(
        (update) => update.kind === "source" && update.source.freshness.state === "offline",
      );
      yield* synchronized.closed;
      expect(yield* Effect.flip(stale.shellSynchronized)).toMatchObject({ reason: "unavailable" });
      yield* TestClock.adjust("499 millis");
      expect(h.fake.calls).toHaveLength(4);
      yield* TestClock.adjust("1 milli");
      const fourth = yield* Queue.take(h.fake.attempts);
      expect(h.fake.calls).toHaveLength(5);
      yield* fourth.ready(sourceConfig("env-a"));
      expect(yield* Queue.take(fourth.shellCalls)).toMatchObject({ afterSequence: 7 });
    }).pipe(
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => 0,
      }),
    ),
);

it.effect(
  "does not publish a fresh synchronization milestone without an authoritative baseline",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register("a");
      yield* h.start;
      const attempt = yield* Queue.take(h.fake.attempts);
      yield* attempt.ready(sourceConfig("env-a"));
      yield* Queue.take(attempt.shellCalls);
      yield* Queue.takeAll(h.updates);
      yield* attempt.emitShell({ kind: "synchronized" });
      const update = yield* Queue.take(h.updates);
      expect(update).toMatchObject({
        kind: "source",
        source: { freshness: { state: "blocked", reason: "invalid-data" } },
      });
      expect((yield* h.state("env-a"))?.appliedCursor).toBeUndefined();
      const access = yield* h.connections.resolveTarget(target("a", "env-a"));
      expect(yield* h.sourceShell.isSynchronized(access)).toBe(false);
    }),
);

it.effect(
  "maps the authoritative active shell and advances only its applied projection cursor",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const targetA = yield* h.register("a");
      yield* h.start;
      const attempt = yield* Queue.take(h.fake.attempts);
      yield* attempt.ready(sourceConfig("env-a"));
      yield* Queue.take(attempt.shellCalls);
      yield* h.nextUpdate((update) => update.kind === "snapshot");
      expect(yield* h.state("env-a")).toMatchObject({
        freshness: { state: "synchronizing" },
        projects: [],
        threads: [],
      });

      yield* attempt.emitShell(
        snapshot(10, [project("p", "Project title")], [thread("t", "p")], [thread("archive", "p")]),
      );
      const applied = yield* h.nextFrame("snapshot", "env-a");
      const source = (yield* h.state("env-a"))!;

      expect(source.target).toEqual(targetA);
      expect(source.appliedCursor).toBe(10);
      expect(source.freshness.state).toBe("synchronizing");
      expect(source.projects).toEqual([
        {
          key: { environmentId: "env-a", projectId: "p" },
          target: targetA,
          title: "Project title",
          workspaceRoot: "/work/p",
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
      ]);
      expect(source.threads).toHaveLength(1);
      expect(source.threads[0]).toMatchObject({
        key: { environmentId: "env-a", threadId: "t" },
        target: targetA,
        project: { environmentId: "env-a", projectId: "p" },
        classification: "active",
      });
      expect(applied).not.toHaveProperty("archivedThreads");

      yield* attempt.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-a");
      expect((yield* h.state("env-a"))?.freshness.state).toBe("fresh");
    }),
);

it.effect("keeps source IDs independent and does not restart a lease on config refresh", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a", "env-a");
    yield* h.register("b", "env-b");
    yield* h.start;
    const attempts = [yield* Queue.take(h.fake.attempts), yield* Queue.take(h.fake.attempts)];
    const byId = new Map(
      attempts.map((attempt) => [attempt.input.environment.registrationId, attempt]),
    );
    const a = byId.get(FactoryRegistrationId.make("a"))!;
    const b = byId.get(FactoryRegistrationId.make("b"))!;
    yield* a.ready(sourceConfig("env-a"));
    yield* Queue.take(a.shellCalls);
    yield* b.ready(sourceConfig("env-b"));
    yield* Queue.take(b.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* a.emitShell(snapshot(1, [project("same", "A")], [thread("same", "same")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* b.emitShell(snapshot(1, [project("same", "B")], [thread("same", "same")]));
    yield* h.nextFrame("snapshot", "env-b");
    yield* Queue.takeAll(h.connectionUpdates);
    yield* a.emitConfig({ version: 1, type: "providerStatuses", payload: { providers: [] } });
    const configRefresh = yield* Queue.take(h.connectionUpdates);
    expect(
      configRefresh.find(
        (state) => state.target.registrationId === a.input.environment.registrationId,
      )?.phase,
    ).toBe("online");

    const lease = yield* h.connections.resolveTarget(target("a", "env-a"));
    yield* a.emitConfig({ version: 1, type: "snapshot", config: sourceConfig("env-a") });
    yield* Queue.take(h.connectionUpdates);
    yield* lease.checkShellCurrent;
    yield* a.emitShell({ kind: "synchronized" });
    yield* h.nextFrame("synchronized", "env-a");
    expect(yield* h.sourceShell.isSynchronized(lease)).toBe(true);

    const states = yield* h.sourceShell.getStates;
    expect(
      states.map((source) => [source.target.environmentId, source.projects[0]?.title]),
    ).toEqual([
      ["env-a", "A"],
      ["env-b", "B"],
    ]);
    expect(states.map((source) => source.threads[0]?.key)).toEqual([
      { environmentId: "env-a", threadId: "same" },
      { environmentId: "env-b", threadId: "same" },
    ]);
    expect(yield* Queue.size(a.shellCalls)).toBe(0);
    expect(yield* Queue.size(b.shellCalls)).toBe(0);
  }),
);

it.effect("accepts filtered sequence gaps and applies project and thread removals", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a");
    yield* h.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(sourceConfig("env-a"));
    yield* Queue.take(attempt.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* attempt.emitShell(snapshot(10, [project("p", "Before")], [thread("t", "p")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* attempt.emitShell({
      kind: "project.updated",
      sequence: 12,
      project: project("p", "After"),
    });
    yield* h.nextFrame("project.updated", "env-a");
    yield* attempt.emitShell({
      kind: "thread.removed",
      location: "active",
      sequence: 15,
      threadId: ThreadId.make("t"),
    });
    yield* h.nextFrame("thread.removed", "env-a");
    yield* attempt.emitShell({
      kind: "project.removed",
      sequence: 19,
      projectId: ProjectId.make("p"),
    });
    yield* h.nextFrame("project.removed", "env-a");

    const source = (yield* h.state("env-a"))!;
    expect(source.appliedCursor).toBe(19);
    expect(source.projects).toEqual([]);
    expect(source.threads).toEqual([]);
  }),
);

it.effect("applies same-sequence enrichment without replacing active threads", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a");
    yield* h.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(sourceConfig("env-a"));
    yield* Queue.take(attempt.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* attempt.emitShell(snapshot(8, [project("p", "Before")], [thread("t", "p")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* attempt.emitShell({
      kind: "snapshot",
      resolvedRepositoryIdentityRoots: ["/work/p"],
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 8,
        projects: [project("p", "Enriched")],
        threads: [],
        archivedThreads: [],
      },
    } as OrchestrationV2ShellStreamItem);
    const enrichment = yield* h.nextFrame("snapshot", "env-a");
    const source = (yield* h.state("env-a"))!;

    expect(source.appliedCursor).toBe(8);
    expect(source.projects[0]?.title).toBe("Enriched");
    expect(source.threads.map((entry) => entry.key.threadId)).toEqual(["t"]);
    expect(enrichment).toMatchObject({
      frame: { kind: "snapshot", resolvedRepositoryIdentityRoots: ["/work/p"] },
    });
  }),
);

it.effect("ignores enrichment from an older cursor after a newer delta", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a");
    yield* h.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(sourceConfig("env-a"));
    yield* Queue.take(attempt.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* attempt.emitShell(snapshot(8, [project("p", "Initial")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* attempt.emitShell({
      kind: "project.updated",
      sequence: 12,
      project: project("p", "Current"),
    });
    yield* h.nextFrame("project.updated", "env-a");
    yield* attempt.emitShell({
      kind: "snapshot",
      resolvedRepositoryIdentityRoots: ["/work/p"],
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 8,
        projects: [project("p", "Late enrichment")],
        threads: [],
        archivedThreads: [],
      },
    } as OrchestrationV2ShellStreamItem);
    yield* attempt.emitShell({ kind: "synchronized" });
    yield* h.nextFrame("synchronized", "env-a");

    expect((yield* h.state("env-a"))?.projects[0]?.title).toBe("Current");
    expect((yield* h.state("env-a"))?.appliedCursor).toBe(12);
  }),
);

it.effect("does not let an older authoritative snapshot rewind an active connection", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a");
    yield* h.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(sourceConfig("env-a"));
    yield* Queue.take(attempt.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* attempt.emitShell(snapshot(10, [project("p", "Initial")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* attempt.emitShell({
      kind: "project.updated",
      sequence: 12,
      project: project("p", "Current"),
    });
    yield* h.nextFrame("project.updated", "env-a");
    yield* attempt.emitShell(snapshot(11, [project("p", "Stale snapshot")]));
    yield* attempt.emitShell({ kind: "synchronized" });
    yield* h.nextFrame("synchronized", "env-a");

    expect((yield* h.state("env-a"))?.projects[0]?.title).toBe("Current");
    expect((yield* h.state("env-a"))?.appliedCursor).toBe(12);
  }),
);

it.effect("does not apply enrichment before an authoritative snapshot", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a");
    yield* h.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(sourceConfig("env-a"));
    yield* Queue.take(attempt.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* attempt.emitShell({
      kind: "snapshot",
      resolvedRepositoryIdentityRoots: ["/work/p"],
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 8,
        projects: [project("p", "Premature enrichment")],
        threads: [],
        archivedThreads: [],
      },
    } as OrchestrationV2ShellStreamItem);
    yield* attempt.emitShell({ kind: "synchronized" });
    yield* h.nextUpdate(
      (update) => update.kind === "source" && update.source.freshness.reason === "invalid-data",
    );

    expect((yield* h.state("env-a"))?.projects).toEqual([]);
    expect((yield* h.state("env-a"))?.appliedCursor).toBeUndefined();
  }),
);

it.effect("replaces only the source shell named by an authoritative reset snapshot", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a", "env-a");
    yield* h.register("b", "env-b");
    yield* h.start;
    const attempts = [yield* Queue.take(h.fake.attempts), yield* Queue.take(h.fake.attempts)];
    const byId = new Map(
      attempts.map((attempt) => [attempt.input.environment.registrationId, attempt]),
    );
    const a = byId.get(FactoryRegistrationId.make("a"))!;
    const b = byId.get(FactoryRegistrationId.make("b"))!;
    yield* a.ready(sourceConfig("env-a"));
    yield* Queue.take(a.shellCalls);
    yield* b.ready(sourceConfig("env-b"));
    yield* Queue.take(b.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* a.emitShell(snapshot(2, [project("a", "A")], [thread("a", "a")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* b.emitShell(snapshot(3, [project("b", "B")], [thread("b", "b")]));
    yield* h.nextFrame("snapshot", "env-b");
    yield* a.emitShell({
      ...snapshot(1, [], []),
      resetReason: "invalid-cursor",
    } as OrchestrationV2ShellStreamItem);
    yield* h.nextFrame("snapshot", "env-a");

    const states = yield* h.sourceShell.getStates;
    expect(states.find((source) => source.target.environmentId === "env-a")?.projects).toEqual([]);
    expect(states.find((source) => source.target.environmentId === "env-a")?.threads).toEqual([]);
    expect(states.find((source) => source.target.environmentId === "env-a")?.appliedCursor).toBe(1);
    expect(
      states.find((source) => source.target.environmentId === "env-b")?.projects[0]?.title,
    ).toBe("B");
    expect(states.find((source) => source.target.environmentId === "env-b")?.threads).toHaveLength(
      1,
    );
  }),
);

it.effect("accepts a full authoritative baseline from a new connection lease", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const targetA = yield* h.register("a");
    yield* h.start;
    const first = yield* Queue.take(h.fake.attempts);
    yield* first.ready(sourceConfig("env-a"));
    yield* Queue.take(first.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* first.emitShell(snapshot(10, [project("p", "Old lease")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* first.emitShell({
      kind: "project.updated",
      sequence: 12,
      project: project("p", "Old lease delta"),
    });
    yield* h.nextFrame("project.updated", "env-a");
    yield* first.fail("transport");
    yield* first.closed;
    yield* Queue.take(first.shellCancellations);

    yield* h.connections.retry(targetA.registrationId);
    const second = yield* Queue.take(h.fake.attempts);
    yield* second.ready(sourceConfig("env-a"));
    expect(yield* Queue.take(second.shellCalls)).toMatchObject({ afterSequence: 12 });
    yield* second.emitShell(snapshot(8, [project("p", "New lease baseline")]));
    yield* h.nextFrame("snapshot", "env-a");

    expect((yield* h.state("env-a"))?.projects[0]?.title).toBe("New lease baseline");
    expect((yield* h.state("env-a"))?.appliedCursor).toBe(8);
  }),
);

it.effect(
  "replays into an intact projection after transport reconnect and rejects the previous lease",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const targetA = yield* h.register("a");
      yield* h.start;
      const first = yield* Queue.take(h.fake.attempts);
      yield* first.ready(sourceConfig("env-a"));
      yield* Queue.take(first.shellCalls);
      yield* first.emitShell(
        snapshot(
          10,
          [project("p", "Before"), project("q", "Unchanged")],
          [thread("t", "p"), thread("u", "q")],
        ),
      );
      yield* h.nextFrame("snapshot", "env-a");
      yield* first.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-a");
      const oldAccess = yield* h.connections.resolveTarget(targetA);
      yield* first.fail("transport");
      yield* first.closed;
      yield* Queue.take(first.shellCancellations);
      yield* h.connections.retry(targetA.registrationId);
      const second = yield* Queue.take(h.fake.attempts);
      yield* second.ready(sourceConfig("env-a"));
      expect(yield* Queue.take(second.shellCalls)).toMatchObject({ afterSequence: 10 });
      expect(yield* Effect.flip(oldAccess.checkShellCurrent)).toMatchObject({
        reason: "unavailable",
      });
      expect(yield* Effect.flip(oldAccess.shellSynchronized)).toMatchObject({
        reason: "unavailable",
      });
      yield* first.emitShell(snapshot(90, [project("p", "Late old snapshot")]));
      yield* first.emitShell({ kind: "synchronized" });
      yield* second.emitShell({
        kind: "project.updated",
        sequence: 12,
        project: project("p", "Replayed"),
      });
      yield* h.nextFrame("project.updated", "env-a");
      const replayed = (yield* h.state("env-a"))!;
      expect(replayed.appliedCursor).toBe(12);
      expect(replayed.projects.map((row) => row.title)).toEqual(["Replayed", "Unchanged"]);
      expect(replayed.threads.map((row) => row.key.threadId)).toEqual(["t", "u"]);
      expect(replayed.freshness.state).toBe("stale");
      yield* second.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-a");
      expect((yield* h.state("env-a"))?.freshness.state).toBe("fresh");
      expect(yield* h.sourceShell.isSynchronized(oldAccess)).toBe(false);
      expect(yield* h.persistedState).toEqual([{ events: 0, projects: 0, threads: 0 }]);
    }),
);

it.effect(
  "requests a new baseline after removal and re-registration even when local IDs match",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const targetA = yield* h.register("a");
      yield* h.start;
      const first = yield* Queue.take(h.fake.attempts);
      yield* first.ready(sourceConfig("env-a"));
      yield* Queue.take(first.shellCalls);
      yield* first.emitShell(snapshot(10, [project("p", "Removed")], [thread("t", "p")]));
      yield* h.nextFrame("snapshot", "env-a");
      const oldAccess = yield* h.connections.resolveTarget(targetA);
      const current = (yield* h.metadata.listEnvironments)[0]!;
      yield* h.metadata.markRemoving({
        registrationId: current.registrationId,
        revision: current.revision,
      });
      yield* h.nextUpdate((update) => update.kind === "removed");
      yield* first.closed;
      yield* h.metadata.clearCredentialReference(current.registrationId);
      const removing = (yield* h.metadata.listEnvironments)[0]!;
      yield* h.metadata.removeEnvironment({
        registrationId: removing.registrationId,
        revision: removing.revision,
      });
      yield* h.register("a", "env-replacement");
      const replacement = yield* Queue.take(h.fake.attempts);
      yield* replacement.ready(sourceConfig("env-replacement"));
      expect(yield* Queue.take(replacement.shellCalls)).not.toHaveProperty("afterSequence");
      yield* replacement.emitShell(snapshot(1, [project("p", "Replacement")], [thread("t", "p")]));
      yield* h.nextFrame("snapshot", "env-replacement");
      yield* replacement.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-replacement");
      expect(yield* h.state("env-a")).toBeUndefined();
      expect((yield* h.state("env-replacement"))?.projects[0]?.title).toBe("Replacement");
      expect(yield* Effect.flip(oldAccess.shellSynchronized)).toMatchObject({
        reason: "unavailable",
      });
    }),
);

it.effect.each(["authentication", "protocol", "identity"] as const)(
  "keeps a healthy source fresh while another source blocks on %s",
  (reason) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register("a");
      const targetB = yield* h.register("b");
      yield* h.start;
      const attempts = [yield* Queue.take(h.fake.attempts), yield* Queue.take(h.fake.attempts)];
      const a = attempts.find((attempt) => attempt.input.environment.registrationId === "a")!;
      const b = attempts.find((attempt) => attempt.input.environment.registrationId === "b")!;
      yield* b.ready(sourceConfig("env-b"));
      yield* Queue.take(b.shellCalls);
      yield* b.emitShell(snapshot(4, [project("same", "Healthy")], [thread("same", "same")]));
      yield* h.nextFrame("snapshot", "env-b");
      yield* b.emitShell({ kind: "synchronized" });
      yield* h.nextFrame("synchronized", "env-b");
      if (reason === "authentication") yield* a.fail(reason);
      else
        yield* a.ready(
          sourceConfig(
            reason === "identity" ? "env-b" : "env-a",
            true,
            reason === "protocol" ? 99 : undefined,
          ),
        );
      yield* h.nextUpdate(
        (update) =>
          update.kind === "source" &&
          update.source.target.environmentId === "env-a" &&
          update.source.freshness.state === "blocked",
      );
      yield* a.closed;
      yield* TestClock.adjust("2 minutes");
      expect(h.fake.calls).toHaveLength(2);
      const accessB = yield* h.connections.resolveTarget(targetB);
      expect(yield* h.sourceShell.isSynchronized(accessB)).toBe(true);
      expect((yield* h.state("env-b"))?.projects[0]?.title).toBe("Healthy");
      expect(yield* Queue.size(b.shellCalls)).toBe(0);
      expect(yield* h.persistedState).toEqual([{ events: 0, projects: 0, threads: 0 }]);
    }),
);

it.effect("retains the old projection and cursor when a source update cannot be applied", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a");
    yield* h.start;
    const first = yield* Queue.take(h.fake.attempts);
    yield* first.ready(sourceConfig("env-a"));
    yield* Queue.take(first.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* first.emitShell(snapshot(10, [project("p", "Retained")], [thread("t", "p")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* first.emitShell(snapshot(11, [project("p", "")], []));
    const rejected = yield* h.nextUpdate(
      (update) => update.kind === "source" && update.source.freshness.reason === "invalid-data",
    );

    expect(rejected).toMatchObject({ kind: "source", source: { appliedCursor: 10 } });
    expect((yield* h.state("env-a"))?.projects[0]?.title).toBe("Retained");
    expect((yield* h.state("env-a"))?.threads).toHaveLength(1);
    yield* first.emitShell({ kind: "synchronized" });
    const invalidMilestone = yield* h.nextUpdate(
      (update) =>
        update.kind === "frame" ||
        (update.kind === "source" && update.source.freshness.reason === "invalid-data"),
    );
    expect(invalidMilestone).toMatchObject({
      kind: "source",
      source: { appliedCursor: 10, freshness: { state: "blocked", reason: "invalid-data" } },
    });

    yield* first.fail("transport");
    yield* first.closed;
    yield* TestClock.adjust("2 seconds");
    const second = yield* Queue.take(h.fake.attempts);
    yield* second.ready(sourceConfig("env-a"));
    expect(yield* Queue.take(second.shellCalls)).toMatchObject({ afterSequence: 10 });
  }),
);

it.effect("retains stale rows after a source disconnect", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a");
    yield* h.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(sourceConfig("env-a"));
    yield* Queue.take(attempt.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* attempt.emitShell(snapshot(5, [project("p", "Keep stale")], [thread("t", "p")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* attempt.emitShell({ kind: "synchronized" });
    yield* h.nextFrame("synchronized", "env-a");
    yield* attempt.fail("transport");
    const stale = yield* h.nextUpdate(
      (update) =>
        update.kind === "source" &&
        update.source.target.environmentId === "env-a" &&
        update.source.freshness.state === "stale",
    );
    expect(stale).toMatchObject({
      source: { projects: [{ title: "Keep stale" }], appliedCursor: 5 },
    });
    yield* attempt.closed;
  }),
);

it.effect("cancels shell consumers and removes only disabled or deleted source rows", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const targetA = yield* h.register("a", "env-a");
    yield* h.start;
    const attemptA = yield* Queue.take(h.fake.attempts);
    yield* attemptA.ready(sourceConfig("env-a"));
    yield* Queue.take(attemptA.shellCalls);
    yield* h.nextUpdate((update) => update.kind === "snapshot");
    yield* attemptA.emitShell(snapshot(1, [project("p", "A")]));
    yield* h.nextFrame("snapshot", "env-a");
    yield* h.connections.disable(targetA.registrationId);
    yield* Queue.take(attemptA.shellCancellations);
    yield* h.nextUpdate(
      (update) =>
        update.kind === "removed" && update.target.registrationId === targetA.registrationId,
    );
    expect(yield* h.state("env-a")).toBeUndefined();

    yield* h.register("b", "env-b");
    const attemptB = yield* Queue.take(h.fake.attempts);
    yield* attemptB.ready(sourceConfig("env-b"));
    yield* Queue.take(attemptB.shellCalls);
    yield* attemptB.emitShell(snapshot(2, [project("p", "B")]));
    yield* h.nextFrame("snapshot", "env-b");
    const current = (yield* h.metadata.listEnvironments).find(
      (environment) => environment.registrationId === "b",
    )!;
    yield* h.metadata.markRemoving({
      registrationId: current.registrationId,
      revision: current.revision,
    });
    yield* Queue.take(attemptB.shellCancellations);
    yield* h.nextUpdate(
      (update) =>
        update.kind === "removed" && update.target.registrationId === current.registrationId,
    );
    yield* h.metadata.clearCredentialReference(current.registrationId);
    const removing = (yield* h.metadata.listEnvironments).find(
      (environment) => environment.registrationId === "b",
    )!;
    yield* h.metadata.removeEnvironment({
      registrationId: removing.registrationId,
      revision: removing.revision,
    });
    expect(yield* h.sourceShell.getStates).toEqual([]);
  }),
);
