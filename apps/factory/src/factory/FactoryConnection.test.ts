import {
  FactoryEnvironmentView,
  FactoryError,
  FactoryOverviewEvent,
  type FactoryOverviewEvent as OverviewEvent,
} from "@t3tools/contracts/factory";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import type { FactoryTransport } from "./transport";
import { FactoryConnection, statusFromAuthSession } from "./FactoryConnection";
import { FactoryTransportError } from "./transport";
import { QueryClient } from "@tanstack/react-query";
import { factoryEnvironmentsQueryOptions } from "./hooks";

const snapshotEvent = Schema.decodeUnknownSync(Schema.toCodecJson(FactoryOverviewEvent))({
  type: "snapshot",
  snapshot: {
    generation: "generation-1",
    revision: 0,
    environments: [],
    sourceFreshness: [],
    projects: [],
    threads: [],
    groups: [],
    memberships: [],
    favorites: [],
  },
});

type RpcClient = FactoryTransport["factory"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeHarness(failAuth = false) {
  const queues: Array<Queue.Queue<OverviewEvent, never>> = [];
  const finalization = new Array<ReturnType<typeof deferred<void>>>();
  const subscriptionsReady = new Array<ReturnType<typeof deferred<void>>>();
  let attempts = 0;
  let subscriptions = 0;
  let finalized = 0;
  let mutations = 0;
  const factory = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "factory.overview.subscribe") {
          return () => {
            subscriptions += 1;
            return Stream.unwrap(
              Effect.gen(function* () {
                const queue = yield* Queue.unbounded<OverviewEvent>();
                queues.push(queue);
                const finalizedStream = deferred<void>();
                finalization.push(finalizedStream);
                const subscribed = deferred<void>();
                subscriptionsReady.push(subscribed);
                subscribed.resolve(undefined);
                return Stream.fromQueue(queue).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      finalized += 1;
                      finalizedStream.resolve(undefined);
                    }),
                  ),
                );
              }),
            );
          };
        }
        if (property === "factory.groups.create") {
          return () => {
            mutations += 1;
            return Effect.fail(new Error("The mutation result is uncertain"));
          };
        }
        throw new TypeError(`Unexpected factory RPC: ${String(property)}`);
      },
    },
  ) as RpcClient;

  const connection = new FactoryConnection({
    retryDelayMs: 25,
    openTransport: async () => {
      attempts += 1;
      if (failAuth) throw new FactoryTransportError({ reason: "unauthenticated" });
      return { factory, factoryId: "factory-1" };
    },
  });
  return {
    connection,
    queues,
    subscriptionsReady,
    waitForFinalization: (index: number) => finalization[index].promise,
    get attempts() {
      return attempts;
    },
    get subscriptions() {
      return subscriptions;
    },
    get finalized() {
      return finalized;
    },
    get mutations() {
      return mutations;
    },
  };
}

function waitForStatus(connection: FactoryConnection, predicate: (phase: string) => boolean) {
  if (predicate(connection.status.phase)) return Promise.resolve(connection.status);
  return new Promise<FactoryConnection["status"]>((resolve) => {
    const unsubscribe = connection.subscribeStatus((status) => {
      if (predicate(status.phase)) {
        unsubscribe();
        resolve(status);
      }
    });
  });
}

afterEach(() => vi.useRealTimers());

describe("FactoryConnection", () => {
  it("maps a rejected browser session to the unauthenticated gate state", () => {
    expect(statusFromAuthSession({ authenticated: false })).toEqual({
      phase: "unauthenticated",
      reason: "auth-required",
    });
  });

  it.live("shares a stream between consumers and cancels it after the last release", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const seenByFirst: OverviewEvent[] = [];
      const seenBySecond = deferred<OverviewEvent>();
      const subscribe = (client: Pick<RpcClient, "factory.overview.subscribe">) =>
        client["factory.overview.subscribe"]({});
      const first = harness.connection.acquireStream("overview", subscribe, (event) =>
        seenByFirst.push(event),
      );
      const second = harness.connection.acquireStream("overview", subscribe, (event) =>
        seenBySecond.resolve(event),
      );
      harness.connection.start();
      try {
        yield* Effect.promise(() =>
          waitForStatus(harness.connection, (phase) => phase === "synchronizing"),
        );
        yield* Effect.promise(() => harness.subscriptionsReady[0].promise);
        yield* Queue.offer(harness.queues[0], snapshotEvent);
        expect(yield* Effect.promise(() => seenBySecond.promise)).toEqual(snapshotEvent);
        expect(seenByFirst).toEqual([snapshotEvent]);
        expect(harness.subscriptions).toBe(1);

        first.release();
        const stillShared = deferred<OverviewEvent>();
        const secondLease = harness.connection.acquireStream("overview", subscribe, (event) =>
          stillShared.resolve(event),
        );
        yield* Queue.offer(harness.queues[0], snapshotEvent);
        expect(yield* Effect.promise(() => stillShared.promise)).toEqual(snapshotEvent);
        expect(harness.finalized).toBe(0);
        second.release();
        secondLease.release();
        yield* Effect.promise(() => harness.waitForFinalization(0));
        expect(harness.finalized).toBe(1);
      } finally {
        yield* Effect.promise(() => harness.connection.stop());
      }
    }),
  );

  it.live("reattaches active leases to a replacement transport and ignores old stream events", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const observed: OverviewEvent[] = [];
      const firstEvent = deferred<void>();
      const replacementEvent = deferred<void>();
      const subscribe = (client: Pick<RpcClient, "factory.overview.subscribe">) =>
        client["factory.overview.subscribe"]({});
      const lease = harness.connection.acquireStream("overview", subscribe, (event) => {
        observed.push(event);
        if (observed.length === 1) firstEvent.resolve(undefined);
        if (observed.length === 2) replacementEvent.resolve(undefined);
      });
      harness.connection.start();
      try {
        yield* Effect.promise(() =>
          waitForStatus(harness.connection, (phase) => phase === "synchronizing"),
        );
        yield* Effect.promise(() => harness.subscriptionsReady[0].promise);
        yield* Queue.offer(harness.queues[0], snapshotEvent);
        yield* Effect.promise(() => firstEvent.promise);

        const replacement = waitForStatus(harness.connection, (phase) => phase === "synchronizing");
        harness.connection.retry();
        yield* Effect.promise(() => replacement);
        yield* Effect.promise(() => harness.subscriptionsReady[1].promise);
        yield* Queue.offer(harness.queues[0], snapshotEvent);
        yield* Queue.offer(harness.queues[1], snapshotEvent);
        yield* Effect.promise(() => replacementEvent.promise);
        expect(harness.subscriptions).toBe(2);
        expect(observed).toEqual([snapshotEvent, snapshotEvent]);
        expect(harness.finalized).toBe(1);
      } finally {
        lease.release();
        yield* Effect.promise(() => harness.connection.stop());
      }
    }),
  );

  it.live("stop finalizes its active and obsolete pending transport scopes exactly once", () =>
    Effect.gen(function* () {
      const pending = deferred<{ factory: RpcClient; factoryId: string }>();
      const opening = deferred<Scope.Scope>();
      const registered = deferred<void>();
      const finalized = deferred<void>();
      let finalizers = 0;
      const factory = new Proxy({}, { get: () => () => Stream.never }) as RpcClient;
      const connection = new FactoryConnection({
        openTransport: async (scope) => {
          opening.resolve(scope);
          await registered.promise;
          return pending.promise;
        },
      });
      connection.start();
      const scope = yield* Effect.promise(() => opening.promise);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          finalizers += 1;
          finalized.resolve();
        }),
      );
      registered.resolve();
      yield* Effect.promise(() => connection.stop());
      pending.resolve({ factory, factoryId: "obsolete" });
      yield* Effect.promise(() => finalized.promise);
      expect(connection.factoryId).toBeUndefined();
      yield* Effect.promise(() => connection.stop());
      expect(finalizers).toBe(1);
      let activeFinalizers = 0;
      const activeOpening = deferred<Scope.Scope>();
      const activeRegistered = deferred<void>();
      const active = new FactoryConnection({
        openTransport: async (scope) => {
          activeOpening.resolve(scope);
          await activeRegistered.promise;
          return { factory, factoryId: "active" };
        },
      });
      active.start();
      const activeScope = yield* Effect.promise(() => activeOpening.promise);
      yield* Scope.addFinalizer(
        activeScope,
        Effect.sync(() => {
          activeFinalizers += 1;
        }),
      );
      activeRegistered.resolve();
      yield* Effect.promise(() => waitForStatus(active, (phase) => phase === "synchronizing"));
      yield* Effect.promise(() => active.stop());
      yield* Effect.promise(() => active.stop());
      expect(activeFinalizers).toBe(1);
    }),
  );

  it("does not acquire source detail before the factory overview is synchronized", async () => {
    const harness = makeHarness();
    harness.connection.start();
    try {
      await waitForStatus(harness.connection, (phase) => phase === "synchronizing");
      await expect(harness.connection.acquireSource("environment-1")).rejects.toMatchObject({
        _tag: "SourceLeaseError",
        reason: "connection-not-ready",
      });
    } finally {
      await harness.connection.stop();
    }
  });

  it("keeps authorized metadata recovery after overflow and retries a complete overview", async () => {
    let oversized = true;
    let environment = Schema.decodeUnknownSync(FactoryEnvironmentView)({
      registrationId: "registration-1",
      environmentId: "env-1",
      revision: 1,
      enabled: true,
      endpoint: "https://source.test",
      label: "Source",
      platform: null,
      state: "online",
      credentialStorage: null,
      credentialExpiresAt: null,
      renewal: "unsupported",
      lastSeenAt: null,
    });
    let removed = false;
    let permissionDenied = false;
    const factory = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "factory.overview.subscribe")
            return () =>
              oversized
                ? Stream.fail(
                    new FactoryError({ code: "overview-too-large", message: "Overview limit." }),
                  )
                : Stream.concat(Stream.succeed(snapshotEvent), Stream.never);
          if (property === "factory.environments.list")
            return () =>
              permissionDenied
                ? Effect.fail({ _tag: "EnvironmentAuthorizationError" })
                : Effect.succeed(removed ? [] : [environment]);
          if (property === "factory.environments.update")
            return (input: { enabled: boolean }) =>
              Effect.sync(() => {
                environment = {
                  ...environment,
                  enabled: input.enabled,
                  revision: environment.revision + 1,
                };
                return environment;
              });
          if (property === "factory.environments.remove")
            return () =>
              Effect.sync(() => {
                removed = true;
                oversized = false;
                return { removed: true };
              });
          throw new TypeError(`Unexpected factory RPC: ${String(property)}`);
        },
      },
    ) as RpcClient;
    const connection = new FactoryConnection({
      openTransport: async () => ({ factory, factoryId: "factory-1" }),
    });
    const queryClient = new QueryClient();
    const observed: OverviewEvent[] = [];
    const lease = connection.acquireStream(
      "overview",
      (client) => client["factory.overview.subscribe"]({}),
      (event) => observed.push(event),
    );
    connection.start();
    try {
      expect(await waitForStatus(connection, (phase) => phase === "blocked")).toEqual({
        phase: "blocked",
        reason: "overview-too-large",
      });
      expect(observed).toEqual([]);
      expect(connection.factoryId).toBe("factory-1");
      await expect(connection.acquireSource("env-1")).rejects.toMatchObject({
        reason: "connection-not-ready",
      });
      expect(
        await queryClient.fetchQuery(factoryEnvironmentsQueryOptions(connection, "factory-1")),
      ).toEqual([environment]);
      permissionDenied = true;
      await expect(
        connection.request((client) => client["factory.environments.list"]({})),
      ).rejects.toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      permissionDenied = false;
      expect(
        await connection.request((client) =>
          client["factory.environments.update"]({
            registrationId: environment.registrationId,
            revision: 1,
            enabled: false,
          }),
        ),
      ).toMatchObject({ enabled: false });
      expect(
        await connection.request((client) =>
          client["factory.environments.remove"]({
            registrationId: environment.registrationId,
            revision: environment.revision,
          }),
        ),
      ).toEqual({ removed: true });
      await queryClient.invalidateQueries({ queryKey: ["factory", "factory-1", "environments"] });
      expect(
        await queryClient.fetchQuery(factoryEnvironmentsQueryOptions(connection, "factory-1")),
      ).toEqual([]);
      connection.retry();
      await waitForStatus(connection, (phase) => phase === "online");
      expect(observed).toEqual([snapshotEvent]);
    } finally {
      lease.release();
      await connection.stop();
      queryClient.clear();
    }
  });

  it("does not schedule retries after cookie authentication rejection until asked", async () => {
    vi.useFakeTimers();
    const harness = makeHarness(true);
    harness.connection.start();
    try {
      const status = await waitForStatus(
        harness.connection,
        (phase) => phase === "unauthenticated",
      );
      expect(status).toEqual({ phase: "unauthenticated", reason: "auth-required" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.attempts).toBe(1);
      const retried = nextStatus(
        harness.connection,
        (status) => status.phase === "unauthenticated" && harness.attempts === 2,
      );
      harness.connection.retry();
      await retried;
      expect(harness.attempts).toBe(2);
    } finally {
      await harness.connection.stop();
    }
  });

  it("clears connection-owned native action uncertainty only at real authentication loss", async () => {
    const harness = makeHarness(true);
    const scope = {
      type: "thread",
      factoryId: "factory-1",
      environmentId: "env-a",
      threadId: "thread-1",
    } as const;
    await expect(
      harness.connection.actions.dispatch({
        scope,
        commandId: "uncertain-command",
        intent: { kind: "interrupt", runId: "run-1" },
        baseSequence: 1,
        state: { online: true, synchronized: true, allowed: true },
        request: async () => {
          throw new Error("Socket closed");
        },
      }),
    ).rejects.toMatchObject({ name: "SourceCommandUncertainError" });
    expect(harness.connection.actions.blocking(scope)?.phase).toBe("uncertain");
    harness.connection.start();
    try {
      await waitForStatus(harness.connection, (phase) => phase === "unauthenticated");
      expect(harness.connection.actions.blocking(scope)).toBeUndefined();
    } finally {
      await harness.connection.stop();
    }
  });

  it("cancels one-shot reads and never replays an uncertain mutation", async () => {
    const harness = makeHarness();
    harness.connection.start();
    try {
      await waitForStatus(harness.connection, (phase) => phase === "synchronizing");
      const cancelled = new AbortController();
      cancelled.abort(new Error("Caller cancelled"));
      let cancelledCalls = 0;
      await expect(
        harness.connection.request(
          () => {
            cancelledCalls += 1;
            return Effect.succeed("unexpected");
          },
          { signal: cancelled.signal },
        ),
      ).rejects.toThrow();
      expect(cancelledCalls).toBe(0);

      await expect(
        harness.connection.request((client) => client["factory.groups.create"]({ name: "Team" })),
      ).rejects.toThrow("The mutation result is uncertain");
      expect(harness.mutations).toBe(1);
      expect(harness.attempts).toBe(1);
    } finally {
      await harness.connection.stop();
    }
  });
});

function nextStatus(
  connection: FactoryConnection,
  predicate: (status: FactoryConnection["status"]) => boolean,
) {
  return new Promise<FactoryConnection["status"]>((resolve) => {
    const unsubscribe = connection.subscribeStatus((status) => {
      if (predicate(status)) {
        unsubscribe();
        resolve(status);
      }
    });
  });
}
