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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
        cleanupPending: false,
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
    register,
    start,
    nextUpdate,
    nextFrame,
    state,
    scope,
  };
});

it("does not advance the applied cursor when a source update fails", () => {
  expect(SourceShell.nextAppliedCursor({ previous: 10, incoming: 11, applied: false })).toBe(10);
});

it.effect("maps the authoritative active shell and acknowledges only applied frames", () =>
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
      ...snapshot(4, [], []),
      resetReason: "invalid-cursor",
    } as OrchestrationV2ShellStreamItem);
    yield* h.nextFrame("snapshot", "env-a");

    const states = yield* h.sourceShell.getStates;
    expect(states.find((source) => source.target.environmentId === "env-a")?.projects).toEqual([]);
    expect(states.find((source) => source.target.environmentId === "env-a")?.threads).toEqual([]);
    expect(
      states.find((source) => source.target.environmentId === "env-b")?.projects[0]?.title,
    ).toBe("B");
    expect(states.find((source) => source.target.environmentId === "env-b")?.threads).toHaveLength(
      1,
    );
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
