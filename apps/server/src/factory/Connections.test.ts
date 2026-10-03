import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  FactoryRegistrationId,
  FactoryEnvironmentView,
  FactoryRemoteTarget,
  NonNegativeInt,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Connections from "./Connections.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as CredentialRenewal from "./CredentialRenewal.ts";
import * as Metadata from "./Metadata.ts";
import * as FakeSource from "./testkit/FakeSource.ts";
import * as Enrollment from "./Enrollment.ts";

import { config } from "./testkit/sourceConfig.ts";

const target = (id = "a", env = "env-a") =>
  FactoryRemoteTarget.make({
    registrationId: FactoryRegistrationId.make(id),
    environmentId: EnvironmentId.make(env),
  });

const harness = Effect.gen(function* () {
  const fake = yield* FakeSource.make;
  const credentials = new Map<string, CredentialStore.StoredCredential>();
  const vaultFailed = yield* Ref.make(false);
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const dependencies = Layer.mergeAll(
    Metadata.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    fake.layer,
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("factory")),
    }),
    Layer.succeed(CredentialStore.CredentialStore, {
      get: (key) =>
        Ref.get(vaultFailed).pipe(
          Effect.flatMap((failed) =>
            failed
              ? Effect.fail(
                  new CredentialStore.CredentialStoreError({
                    operation: "read",
                    backend: "secure-vault",
                  }),
                )
              : Effect.succeed(Option.fromNullishOr(credentials.get(key))),
          ),
        ),
      set: (key, value) => Effect.sync(() => void credentials.set(key, value)),
      remove: (key) => Effect.sync(() => void credentials.delete(key)),
    }),
    Layer.succeed(Enrollment.SourceCredentialExchange, {
      discover: () =>
        Effect.succeed({ environmentId: EnvironmentId.make("env-a"), platform: null }),
      exchange: () => Effect.die("Use saved credentials in connection tests."),
      renew: ({ credential }) =>
        DateTime.now.pipe(
          Effect.map((now) => ({
            ...credential,
            token: "durable-replacement",
            sourceSessionId: AuthSessionId.make("replacement"),
            issuedAt: now,
            expiresAt: DateTime.add(now, { days: 30 }),
          })),
        ),
      revoke: () => Effect.die("Read-only source sessions cannot revoke predecessors."),
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const settings = yield* Config.ServerConfig;
          return Config.layer({ ...settings, factoryEnabled: true });
        }),
      ).pipe(Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-connections-" }))),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const connectionLayer = Connections.layer.pipe(
    Layer.provideMerge(CredentialRenewal.layer.pipe(Layer.provideMerge(dependencies))),
  );
  const services = yield* Layer.buildWithScope(
    Enrollment.layer.pipe(
      Layer.provideMerge(
        Connections.registrationLifecycleLayer.pipe(Layer.provideMerge(connectionLayer)),
      ),
    ),
    scope,
  );
  const connections = Context.get(services, Connections.Connections);
  const metadata = Context.get(services, Metadata.Metadata);
  const states = yield* Stream.toQueue(connections.subscribeStates, { capacity: 64 });
  const wait = (id: string, phase: Connections.SourceState["phase"]) =>
    Stream.fromQueue(states).pipe(
      Stream.flatMap((snapshot) => Stream.fromIterable(snapshot)),
      Stream.filter((state) => state.target.registrationId === id && state.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  const register = Effect.fnUntraced(function* (id = "a", env = "env-a") {
    const now = yield* DateTime.now;
    credentials.set(id, {
      token: `test-token-${id}`,
      sourceSessionId: AuthSessionId.make(id),
      issuedAt: now,
      expiresAt: DateTime.add(now, { days: 30 }),
      scopes: ["orchestration:read"],
    });
    const pending = FactoryEnvironmentView.make({
      ...target(id, env),
      endpoint: `https://${id}.example`,
      label: id,
      platform: null,
      enabled: false,
      state: "pending",
      credentialStorage: null,
      credentialExpiresAt: null,
      cleanupPending: false,
      renewal: "unsupported",
      lastSeenAt: null,
      revision: 0,
    });
    yield* metadata.createEnvironment(pending);
    return yield* metadata.markEnrollment({
      registrationId: pending.registrationId,
      credentialStorage: "secure-vault",
      credentialItemKey: id,
      credentialExpiresAt: null,
    });
  });
  return {
    fake,
    connections,
    metadata,
    states,
    wait,
    register,
    credentials,
    renewal: Context.get(services, CredentialRenewal.CredentialRenewal),
    enrollment: Context.get(services, Enrollment.Enrollment),
    lifecycle: Context.get(services, Enrollment.RegistrationLifecycle),
    vaultFailed,
    scope,
  };
});

it.effect("wakes a blocked registration through its enabled lifecycle", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const environment = yield* h.register();
    yield* h.connections.start;
    const first = yield* Queue.take(h.fake.attempts);
    yield* first.fail("authentication");
    yield* h.wait("a", "blocked");
    yield* first.closed;
    yield* h.lifecycle.enabled(environment);
    const second = yield* Queue.take(h.fake.attempts);
    yield* second.ready(config());
    yield* h.wait("a", "online");
    expect(h.fake.calls).toHaveLength(2);
  }),
);

it.effect("rejects a mismatched environment target and clears its applied cursor", () =>
  Effect.gen(function* () {
    expect(Connections.matchesSourceIdentity({ expected: "env-a", received: "env-b" })).toBe(false);
    const h = yield* harness;
    yield* h.register();
    yield* h.connections.start;
    const first = yield* Queue.take(h.fake.attempts);
    yield* first.ready(config());
    yield* h.wait("a", "online");
    const source = yield* h.connections.resolveTarget(target());
    yield* source.acknowledgeShell(NonNegativeInt.make(7));
    expect(yield* Effect.flip(h.connections.resolveTarget(target("a", "env-b")))).toMatchObject({
      reason: "identity",
    });
    yield* first.emitConfig({ version: 1, type: "snapshot", config: config("env-b") });
    const blocked = yield* h.wait("a", "blocked");
    yield* first.closed;
    expect(blocked).toMatchObject({ reason: "identity", cursor: undefined });
    expect(yield* Effect.flip(source.acknowledgeShell(NonNegativeInt.make(9)))).toMatchObject({
      reason: "unavailable",
    });
  }),
);

it.effect("keeps equal local IDs scoped to their source and does not wait for a slow source", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    yield* h.register("b", "env-b");
    yield* h.connections.start;
    const first = yield* Queue.take(h.fake.attempts);
    const second = yield* Queue.take(h.fake.attempts);
    const fast = first.input.environment.registrationId === "b" ? first : second;
    yield* fast.ready(config("env-b"));
    yield* h.wait("b", "online");
    const access = yield* h.connections.resolveTarget(target("b", "env-b"));
    const shell = yield* Stream.toQueue(access.shell, { capacity: 64 });
    expect(yield* Queue.take(fast.shellCalls)).toEqual({
      batchedReplay: true,
      requestCompletionMarker: true,
    });
    yield* fast.emitShell({
      kind: "thread.removed",
      location: "active",
      sequence: 5,
      threadId: ThreadId.make("same"),
    });
    expect(yield* Queue.take(shell)).toMatchObject({ threadId: "same" });
    expect(access.target).toEqual({ registrationId: "b", environmentId: "env-b" });
    expect((yield* Effect.flip(h.connections.resolveTarget(target()))).reason).toBe("unavailable");
    const slow = fast === first ? second : first;
    yield* slow.ready(config());
    yield* h.wait("a", "online");
    const other = yield* h.connections.resolveTarget(target());
    const otherShell = yield* Stream.toQueue(other.shell, { capacity: 64 });
    yield* Queue.take(slow.shellCalls);
    yield* slow.emitShell({
      kind: "thread.removed",
      location: "active",
      sequence: 6,
      threadId: ThreadId.make("same"),
    });
    expect(yield* Queue.take(otherShell)).toMatchObject({ threadId: "same" });
    expect(other.target.environmentId).toBe("env-a");
  }),
);

it.effect("replaces endpoints once and resumes only acknowledged cursors", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    yield* h.connections.start;
    const first = yield* Queue.take(h.fake.attempts);
    yield* first.ready(config());
    yield* h.wait("a", "online");
    const access = yield* h.connections.resolveTarget(target());
    yield* access.acknowledgeShell(NonNegativeInt.make(8));
    const current = (yield* h.metadata.listEnvironments)[0]!;
    yield* h.metadata.updateEnvironment({
      registrationId: current.registrationId,
      revision: current.revision,
      endpoint: "https://replacement.example",
    });
    yield* first.closed;
    const second = yield* Queue.take(h.fake.attempts);
    expect(second.input.environment.endpoint).toBe("https://replacement.example");
    yield* second.ready(config("env-a", null));
    yield* h.wait("a", "online");
    const next = yield* h.connections.resolveTarget(target());
    yield* Stream.toQueue(next.shell, { capacity: 64 });
    expect(next.connectionId).not.toBe(access.connectionId);
    expect(yield* Queue.take(second.shellCalls)).toEqual({
      afterSequence: 8,
      requestCompletionMarker: true,
    });
    yield* h.metadata.setRenewalStatus(current.registrationId, "ready");
    const latest = (yield* h.metadata.listEnvironments)[0]!;
    yield* h.connections.updateEnvironment({
      registrationId: latest.registrationId,
      revision: latest.revision,
      label: "Renamed source",
    });
    expect(h.fake.calls).toHaveLength(2);
    expect((yield* h.connections.resolveTarget(target())).connectionId).toBe(next.connectionId);
  }),
);

it.effect.each(["authentication", "protocol"] as const)(
  "blocks %s errors until explicit retry",
  (reason) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register();
      yield* h.connections.start;
      const first = yield* Queue.take(h.fake.attempts);
      if (reason === "protocol") yield* first.ready(config("env-a", true, 99));
      else yield* first.fail(reason);
      expect((yield* h.wait("a", "blocked")).reason).toBe(reason);
      yield* first.closed;
      yield* TestClock.adjust("2 minutes");
      expect(h.fake.calls).toHaveLength(1);
      yield* h.connections.retry(target().registrationId);
      const second = yield* Queue.take(h.fake.attempts);
      yield* second.ready(config());
      yield* h.wait("a", "online");
    }),
);

it.effect("blocks vault failures without connecting and reloads credentials on wakeup", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    yield* Ref.set(h.vaultFailed, true);
    yield* h.connections.start;
    expect((yield* h.wait("a", "blocked")).reason).toBe("credential-store");
    expect(h.fake.calls).toHaveLength(0);
    yield* Ref.set(h.vaultFailed, false);
    yield* h.connections.retry(target().registrationId);
    const first = yield* Queue.take(h.fake.attempts);
    yield* first.ready(config());
    yield* h.wait("a", "online");
    const now = yield* DateTime.now;
    h.credentials.set("a", {
      ...h.credentials.get("a")!,
      issuedAt: DateTime.subtract(now, { days: 25 }),
      expiresAt: DateTime.add(now, { days: 5 }),
      renewalSupported: true,
    });
    yield* h.renewal.runOnce;
    yield* first.closed;
    const second = yield* Queue.take(h.fake.attempts);
    expect(second.input.credential.token).toBe("durable-replacement");
  }),
);

it.effect("reconnects transient failure with bounded exponential jitter", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    yield* h.connections.start;
    const first = yield* Queue.take(h.fake.attempts);
    yield* first.fail("transport");
    yield* h.wait("a", "offline");
    yield* first.closed;
    yield* TestClock.adjust("499 millis");
    expect(h.fake.calls).toHaveLength(1);
    yield* TestClock.adjust("501 millis");
    const second = yield* Queue.take(h.fake.attempts);
    yield* second.fail("transport");
    yield* h.wait("a", "offline");
    yield* TestClock.adjust("999 millis");
    expect(h.fake.calls).toHaveLength(2);
    yield* TestClock.adjust("1001 millis");
    const third = yield* Queue.take(h.fake.attempts);
    yield* third.ready(config());
    yield* h.wait("a", "online");
  }),
);

it.effect(
  "disconnects on disable, removal, and runtime scope cancellation without source mutations",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register();
      yield* h.connections.start;
      const first = yield* Queue.take(h.fake.attempts);
      yield* first.ready(config());
      yield* h.wait("a", "online");
      yield* h.connections.disable(target().registrationId);
      yield* first.closed;
      expect((yield* h.metadata.listEnvironments)[0]?.enabled).toBe(false);
      const disabled = (yield* h.metadata.listEnvironments)[0]!;
      yield* h.metadata.updateEnvironment({
        registrationId: disabled.registrationId,
        revision: disabled.revision,
        enabled: true,
      });
      const second = yield* Queue.take(h.fake.attempts);
      yield* second.ready(config());
      yield* h.wait("a", "online");
      const current = (yield* h.metadata.listEnvironments)[0]!;
      yield* h.metadata.markRemoving({
        registrationId: current.registrationId,
        revision: current.revision,
      });
      yield* second.closed;
      yield* h.register("b", "env-b");
      const third = yield* Queue.take(h.fake.attempts);
      yield* Scope.close(h.scope, Exit.void);
      yield* third.closed;
      expect(h.fake.calls).toHaveLength(3);
    }),
);

it.effect("rejects a source with the factory's own identity", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register("a", "factory");
    yield* h.connections.start;
    expect((yield* h.wait("a", "blocked")).reason).toBe("identity");
    expect(h.fake.calls).toHaveLength(0);
  }),
);

it.effect(
  "rejects duplicate metadata and blocks a second endpoint that presents the first identity",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register();
      expect(yield* Effect.flip(h.register("duplicate", "env-a"))).toMatchObject({
        code: "conflict",
      });
      yield* h.register("b", "env-b");
      yield* h.connections.start;
      const first = yield* Queue.take(h.fake.attempts);
      const second = yield* Queue.take(h.fake.attempts);
      const duplicate = first.input.environment.registrationId === "b" ? first : second;
      const valid = duplicate === first ? second : first;
      yield* valid.ready(config());
      yield* h.wait("a", "online");
      yield* duplicate.ready(config());
      expect((yield* h.wait("b", "blocked")).reason).toBe("identity");
      yield* duplicate.closed;
      expect((yield* h.connections.resolveTarget(target())).config.environment.environmentId).toBe(
        "env-a",
      );
    }),
);

it.effect("keeps source execution and the supervisor alive when a shell consumer disconnects", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    yield* h.connections.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(config());
    yield* h.wait("a", "online");
    const access = yield* h.connections.resolveTarget(target());
    const consumer = yield* access.shell.pipe(Stream.runDrain, Effect.forkScoped);
    yield* Queue.take(attempt.shellCalls);
    yield* Fiber.interrupt(consumer);
    expect((yield* h.connections.resolveTarget(target())).config.environment.environmentId).toBe(
      "env-a",
    );
    expect(h.fake.calls).toHaveLength(1);
  }),
);

it.effect(
  "disconnects through enrollment before durable credential deletion and metadata removal",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register();
      yield* h.connections.start;
      const attempt = yield* Queue.take(h.fake.attempts);
      yield* attempt.ready(config());
      yield* h.wait("a", "online");
      const current = (yield* h.metadata.listEnvironments)[0]!;
      yield* h.enrollment.remove({
        registrationId: current.registrationId,
        revision: current.revision,
      });
      yield* attempt.closed;
      expect(h.credentials.has("a")).toBe(false);
      expect(yield* h.metadata.listEnvironments).toEqual([]);
      expect(yield* Effect.flip(h.connections.resolveTarget(target()))).toMatchObject({
        reason: "unavailable",
      });
    }),
);

it.effect("loads a replacement that was renewed before connection subscriptions started", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    const now = yield* DateTime.now;
    h.credentials.set("a", {
      ...h.credentials.get("a")!,
      issuedAt: DateTime.subtract(now, { days: 25 }),
      expiresAt: DateTime.add(now, { days: 5 }),
      renewalSupported: true,
    });
    yield* h.renewal.runOnce;
    yield* h.connections.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    expect(attempt.input.credential.token).toBe("durable-replacement");
  }),
);

it.effect("blocks missing and expired credentials without an outbound connection", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    h.credentials.delete("a");
    yield* h.connections.start;
    expect((yield* h.wait("a", "blocked")).reason).toBe("credential-store");
    yield* h.register("b", "env-b");
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(config("env-b"));
    yield* h.wait("b", "online");
    const now = yield* DateTime.now;
    h.credentials.set("b", { ...h.credentials.get("b")!, expiresAt: now });
    yield* h.connections.retry(target("b", "env-b").registrationId);
    yield* attempt.closed;
    expect((yield* h.wait("b", "blocked")).reason).toBe("authentication");
    expect(h.fake.calls).toHaveLength(1);
  }),
);

it.effect(
  "passes bounded snapshot reset reasons and synchronized markers without advancing unapplied cursors",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register();
      yield* h.connections.start;
      const attempt = yield* Queue.take(h.fake.attempts);
      yield* attempt.ready(config());
      yield* h.wait("a", "online");
      const access = yield* h.connections.resolveTarget(target());
      const shell = yield* Stream.toQueue(access.shell, { capacity: 8 });
      yield* Queue.take(attempt.shellCalls);
      yield* attempt.emitShell({
        kind: "snapshot",
        resetReason: "event-limit",
        snapshot: {
          schemaVersion: 2,
          snapshotSequence: 42,
          projects: [],
          threads: [],
          archivedThreads: [],
        },
      });
      expect(yield* Queue.take(shell)).toMatchObject({
        resetReason: "event-limit",
        snapshot: { snapshotSequence: 42 },
      });
      expect((yield* h.connections.getStates)[0]?.cursor).toBeUndefined();
      yield* access.acknowledgeShell(NonNegativeInt.make(42));
      yield* attempt.emitShell({ kind: "synchronized" });
      expect(yield* Queue.take(shell)).toEqual({ kind: "synchronized" });
      expect((yield* h.connections.getStates)[0]?.cursor).toBe(42);
    }),
);

it.effect("blocks a shell authorization failure and invalidates its source lease", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    yield* h.connections.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(config());
    yield* h.wait("a", "online");
    yield* attempt.failShell("authentication");
    const source = yield* h.connections.resolveTarget(target());
    expect(yield* source.shell.pipe(Stream.runDrain, Effect.flip)).toMatchObject({
      reason: "authentication",
    });
    expect((yield* h.wait("a", "blocked")).reason).toBe("authentication");
    yield* attempt.closed;
  }),
);

it.effect("blocks an open session when its stored credential expires", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.register();
    const now = yield* DateTime.now;
    h.credentials.set("a", {
      ...h.credentials.get("a")!,
      expiresAt: DateTime.add(now, { seconds: 10 }),
    });
    yield* h.connections.start;
    const attempt = yield* Queue.take(h.fake.attempts);
    yield* attempt.ready(config());
    yield* h.wait("a", "online");
    yield* TestClock.adjust("10 seconds");
    expect((yield* h.wait("a", "blocked")).reason).toBe("authentication");
    yield* attempt.closed;
    expect(h.fake.calls).toHaveLength(1);
  }),
);

it.effect(
  "does not report persisted online state while startup identity validation is still pending",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const environment = yield* h.register();
      yield* h.metadata.setConnectionState(environment.registrationId, "online");
      yield* h.connections.start;
      yield* Queue.take(h.fake.attempts);
      expect((yield* h.metadata.listEnvironments)[0]?.state).toBe("offline");
      expect((yield* h.connections.getStates)[0]?.phase).toBe("connecting");
    }),
);

it.effect(
  "accepts legacy config without optional negotiation and opens only the active shell",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.register();
      yield* h.connections.start;
      const attempt = yield* Queue.take(h.fake.attempts);
      const legacy = config("env-a", null);
      const { orchestrationProtocolVersion: _version, ...environment } = legacy.environment;
      yield* attempt.ready({ ...legacy, environment, shellResumeCompletionMarker: false });
      yield* h.wait("a", "online");
      const access = yield* h.connections.resolveTarget(target());
      yield* Stream.toQueue(access.shell, { capacity: 8 });
      expect(yield* Queue.take(attempt.shellCalls)).toEqual({});
    }),
);
