import {
  FactoryError,
  FactoryOverviewEvent,
  FactoryOverviewSnapshot as SnapshotSchema,
  type FactoryOverviewSnapshot,
} from "@t3tools/contracts/factory";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { FactoryConnection } from "./FactoryConnection";
import type { FactoryTransport } from "./transport";
import { FactoryTransportError } from "./transport";
import { FactoryQueryBridge } from "./queryBridge";
import { factoryKeys, threadDetailKey } from "./queryKeys";

type OverviewEvent = typeof FactoryOverviewEvent.Type;
type RpcClient = FactoryTransport["factory"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeEvent(value: unknown): OverviewEvent {
  return Schema.decodeUnknownSync(FactoryOverviewEvent)(value);
}

const snapshotEvent = makeEvent({
  type: "snapshot",
  snapshot: {
    generation: "generation-1",
    revision: 1,
    environments: [],
    sourceFreshness: [],
    projects: [],
    threads: [],
    groups: [],
    memberships: [],
    favorites: [],
  },
});

if (snapshotEvent.type !== "snapshot") throw new Error("Expected an overview snapshot fixture");
const snapshot = snapshotEvent;

function makeHarness(rejectSecondAttempt: boolean | "permission" = false) {
  const queues: Array<Queue.Queue<OverviewEvent, never>> = [];
  const ready = new Array<ReturnType<typeof deferred<void>>>();
  let attempts = 0;
  const client = {
    "factory.overview.subscribe": () => {
      return Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<OverviewEvent>();
          queues.push(queue);
          const subscribed = deferred<void>();
          ready.push(subscribed);
          subscribed.resolve(undefined);
          return Stream.fromQueue(queue);
        }),
      );
    },
  } as unknown as RpcClient;
  const connection = new FactoryConnection({
    openTransport: async () => {
      attempts += 1;
      if (rejectSecondAttempt && attempts > 1) {
        if (rejectSecondAttempt === "permission") throw { _tag: "EnvironmentAuthorizationError" };
        throw new FactoryTransportError({ reason: "unauthenticated" });
      }
      return { factory: client, factoryId: "factory-1" };
    },
  });
  return {
    connection,
    queues,
    ready,
    get attempts() {
      return attempts;
    },
  };
}

function waitForStatus(connection: FactoryConnection, phase: string) {
  if (connection.status.phase === phase) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = connection.subscribeStatus((status) => {
      if (status.phase === phase) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function waitForCache(
  queryClient: QueryClient,
  key: readonly unknown[],
  predicate: (data: FactoryOverviewSnapshot | undefined) => boolean,
) {
  const current = queryClient.getQueryData<FactoryOverviewSnapshot>(key);
  if (predicate(current)) return Promise.resolve(current);
  return new Promise<FactoryOverviewSnapshot | undefined>((resolve) => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (JSON.stringify(event.query.queryKey) !== JSON.stringify(key)) return;
      const data = queryClient.getQueryData<FactoryOverviewSnapshot>(key);
      if (predicate(data)) {
        unsubscribe();
        resolve(data);
      }
    });
  });
}

describe("FactoryQueryBridge", () => {
  it("evicts unusable overview/control detail on overflow while keeping metadata recovery independent", async () => {
    const factory = new Proxy(
      {},
      {
        get(_target, method) {
          if (method === "factory.overview.subscribe")
            return () =>
              Stream.fail(
                new FactoryError({ code: "overview-too-large", message: "Overview limit." }),
              );
          if (method === "factory.environments.list") return () => Effect.succeed([]);
          throw new Error(`Unexpected RPC: ${String(method)}`);
        },
      },
    ) as RpcClient;
    const connection = new FactoryConnection({
      openTransport: async () => ({ factory, factoryId: "factory-1" }),
    });
    const client = new QueryClient();
    const bridge = new FactoryQueryBridge(connection, client);
    const overviewKey = factoryKeys.overview("factory-1");
    const protectedKey = threadDetailKey("factory-1", "env", "thread", "registration");
    client.setQueryData(overviewKey, snapshot.snapshot);
    client.setQueryData(protectedKey, { protected: true });
    client.setQueryData(factoryKeys.environments("factory-1"), [{ old: true }]);
    bridge.start();
    connection.start();
    try {
      await waitForStatus(connection, "blocked");
      expect(connection.status.reason).toBe("overview-too-large");
      expect(client.getQueryData(overviewKey)).toBeUndefined();
      expect(client.getQueryData(protectedKey)).toBeUndefined();
      expect(client.getQueryData(factoryKeys.environments("factory-1"))).toBeUndefined();
      expect(await connection.request((rpc) => rpc["factory.environments.list"]({}))).toEqual([]);
      expect(client.getQueryData(overviewKey)).toBeUndefined();
    } finally {
      bridge.stop();
      await connection.stop();
      client.clear();
    }
  });

  it.live(
    "writes stream snapshots and patches, preserves source auth state, and resets only overview on gaps",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const queryClient = new QueryClient();
        const bridge = new FactoryQueryBridge(harness.connection, queryClient);
        const overviewKey = factoryKeys.overview("factory-1");
        const groupsKey = factoryKeys.groups("factory-1");
        bridge.start();
        harness.connection.start();
        try {
          yield* Effect.promise(() => waitForStatus(harness.connection, "synchronizing"));
          yield* Effect.promise(() => harness.ready[0].promise);
          const snapshotCached = waitForCache(
            queryClient,
            overviewKey,
            (data) => data?.revision === 1,
          );
          yield* Queue.offer(harness.queues[0], snapshot);
          yield* Effect.promise(() => snapshotCached);
          expect(harness.connection.status.phase).toBe("online");

          queryClient.setQueryData(groupsKey, { preserved: true });
          const protectedA = threadDetailKey(
            "factory-1",
            "environment-1",
            "same",
            "registration-1",
          );
          const protectedB = threadDetailKey(
            "factory-1",
            "environment-2",
            "same",
            "registration-2",
          );
          queryClient.setQueryData([...protectedA, "file"], { content: "protected A" });
          queryClient.setQueryData([...protectedB, "file"], { content: "protected B" });
          const sourceAuthPatch = makeEvent({
            type: "patch",
            generation: "generation-1",
            revision: 2,
            patch: {
              kind: "sourceFreshness",
              upserts: [
                {
                  target: { registrationId: "registration-1", environmentId: "environment-1" },
                  state: "blocked",
                  reason: "auth-required",
                  updatedAt: null,
                  retryAt: null,
                },
              ],
              removals: [],
            },
          });
          const sourcePatchCached = waitForCache(
            queryClient,
            overviewKey,
            (data) => data?.revision === 2,
          );
          yield* Queue.offer(harness.queues[0], sourceAuthPatch);
          const updated = yield* Effect.promise(() => sourcePatchCached);
          expect(updated?.sourceFreshness[0].reason).toBe("auth-required");
          expect(queryClient.getQueryData([...protectedA, "file"])).toBeUndefined();
          expect(queryClient.getQueryData([...protectedB, "file"])).toEqual({
            content: "protected B",
          });
          expect(harness.connection.status.phase).toBe("online");

          const cleared = waitForCache(queryClient, overviewKey, (data) => data === undefined);
          yield* Queue.offer(
            harness.queues[0],
            makeEvent({
              type: "patch",
              generation: "generation-1",
              revision: 4,
              patch: { kind: "metadata", groups: [], memberships: [], favorites: [] },
            }),
          );
          yield* Effect.promise(() => cleared);
          yield* Effect.promise(() => harness.ready[1].promise);
          expect(harness.queues).toHaveLength(2);
          expect(queryClient.getQueryData(groupsKey)).toEqual({ preserved: true });
          expect(queryClient.getQueryData(factoryKeys.environments("factory-1"))).toBeUndefined();
        } finally {
          bridge.stop();
          yield* Effect.promise(() => harness.connection.stop());
          queryClient.clear();
        }
      }),
  );

  it.live(
    "retains protected stale cache offline and denies obsolete registration freshness from evicting a new registration",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const client = new QueryClient();
        const bridge = new FactoryQueryBridge(harness.connection, client);
        bridge.start();
        harness.connection.start();
        try {
          yield* Effect.promise(() => waitForStatus(harness.connection, "synchronizing"));
          const key = factoryKeys.overview("factory-1");
          const cached = waitForCache(client, key, (data) => data?.revision === 1);
          yield* Queue.offer(harness.queues[0], snapshot);
          yield* Effect.promise(() => cached);
          const detail = threadDetailKey("factory-1", "env", "same", "current");
          client.setQueryData(detail, { content: "offline stale detail" });
          const offline = {
            target: { registrationId: "current", environmentId: "env" },
            state: "offline",
            reason: null,
            updatedAt: null,
            retryAt: null,
          };
          harness.connection.updateSourceAccess(
            Schema.decodeUnknownSync(SnapshotSchema)({
              ...snapshot.snapshot,
              sourceFreshness: [offline],
            }),
          );
          expect(client.getQueryData(detail)).toEqual({ content: "offline stale detail" });
          harness.connection.updateSourceAccess(
            Schema.decodeUnknownSync(SnapshotSchema)({
              ...snapshot.snapshot,
              sourceFreshness: [
                {
                  ...offline,
                  target: { registrationId: "obsolete", environmentId: "env" },
                  state: "blocked",
                  reason: "auth-required",
                },
              ],
            }),
          );
          expect(client.getQueryData(detail)).toEqual({ content: "offline stale detail" });
        } finally {
          bridge.stop();
          yield* Effect.promise(() => harness.connection.stop());
          client.clear();
        }
      }),
  );

  it.live(
    "keeps Nodes status authoritative through renewal, expiry, cleanup, and removal patches without list RPCs",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const queryClient = new QueryClient();
        const bridge = new FactoryQueryBridge(harness.connection, queryClient);
        const overviewKey = factoryKeys.overview("factory-1");
        const environmentsKey = factoryKeys.environments("factory-1");
        const environment = {
          registrationId: "registration-1",
          environmentId: "environment-1",
          endpoint: "https://source.example",
          label: "Source",
          platform: null,
          enabled: true,
          state: "online",
          credentialStorage: "secure-vault",
          credentialExpiresAt: DateTime.makeUnsafe("2026-10-04T00:00:00.000Z"),
          renewal: "ready",
          lastSeenAt: null,
          revision: 1,
        };
        bridge.start();
        harness.connection.start();
        try {
          yield* Effect.promise(() => waitForStatus(harness.connection, "synchronizing"));
          yield* Effect.promise(() => harness.ready[0].promise);
          let cached = waitForCache(queryClient, overviewKey, (data) => data?.revision === 1);
          yield* Queue.offer(
            harness.queues[0],
            makeEvent({
              type: "snapshot",
              snapshot: { ...snapshot.snapshot, environments: [environment] },
            }),
          );
          yield* Effect.promise(() => cached);
          expect(queryClient.getQueryData(environmentsKey)).toEqual(
            queryClient.getQueryData<FactoryOverviewSnapshot>(overviewKey)?.environments,
          );
          for (const [index, status] of [
            { renewal: "due" },
            {
              renewal: "ready",
              credentialExpiresAt: DateTime.makeUnsafe("2026-11-04T00:00:00.000Z"),
            },
            { renewal: "ready" },
            { renewal: "expired" },
            { renewal: "expired", state: "removing", enabled: false },
          ].entries()) {
            const revision = index + 2;
            cached = waitForCache(queryClient, overviewKey, (data) => data?.revision === revision);
            yield* Queue.offer(
              harness.queues[0],
              makeEvent({
                type: "patch",
                generation: "generation-1",
                revision,
                patch: {
                  kind: "environments",
                  upserts: [{ ...environment, ...status }],
                  removals: [],
                },
              }),
            );
            yield* Effect.promise(() => cached);
            expect(queryClient.getQueryData(environmentsKey)).toEqual(
              queryClient.getQueryData<FactoryOverviewSnapshot>(overviewKey)?.environments,
            );
            expect(
              queryClient.getQueryData<Array<typeof environment>>(environmentsKey)?.[0],
            ).toMatchObject(status);
          }
          cached = waitForCache(queryClient, overviewKey, (data) => data?.revision === 7);
          yield* Queue.offer(
            harness.queues[0],
            makeEvent({
              type: "patch",
              generation: "generation-1",
              revision: 7,
              patch: { kind: "environments", upserts: [], removals: ["registration-1"] },
            }),
          );
          yield* Effect.promise(() => cached);
          expect(queryClient.getQueryData(environmentsKey)).toEqual([]);
          expect(harness.queues).toHaveLength(1);
        } finally {
          bridge.stop();
          yield* Effect.promise(() => harness.connection.stop());
          queryClient.clear();
        }
      }),
  );

  it.live.each([true, "permission"] as const)(
    "removes protected data from every client cache when factory authorization is revoked (%s)",
    (reason) =>
      Effect.gen(function* () {
        const harness = makeHarness(reason);
        const queryClient = new QueryClient();
        const bridge = new FactoryQueryBridge(harness.connection, queryClient);
        const secondClient = new QueryClient();
        const secondBridge = new FactoryQueryBridge(harness.connection, secondClient);
        const overviewKey = factoryKeys.overview("factory-1");
        const groupsKey = factoryKeys.groups("factory-1");
        bridge.start();
        secondBridge.start();
        harness.connection.start();
        try {
          yield* Effect.promise(() => waitForStatus(harness.connection, "synchronizing"));
          yield* Effect.promise(() => harness.ready[0].promise);
          const snapshotCached = waitForCache(
            queryClient,
            overviewKey,
            (data) => data?.revision === 1,
          );
          yield* Queue.offer(harness.queues[0], snapshot);
          yield* Effect.promise(() => snapshotCached);
          queryClient.setQueryData(groupsKey, { private: true });
          queryClient.setQueryData(factoryKeys.environments("factory-1"), [{ private: true }]);
          secondClient.setQueryData(groupsKey, { private: true });
          secondClient.setQueryData(factoryKeys.environments("factory-1"), [{ private: true }]);

          const cleared = waitForCache(queryClient, overviewKey, (data) => data === undefined);
          const revoked = waitForStatus(
            harness.connection,
            reason === "permission" ? "blocked" : "unauthenticated",
          );
          harness.connection.retry();
          yield* Effect.promise(() => revoked);
          yield* Effect.promise(() => cleared);
          expect(queryClient.getQueryData(groupsKey)).toBeUndefined();
          expect(queryClient.getQueryData(factoryKeys.environments("factory-1"))).toBeUndefined();
          expect(secondClient.getQueryData(overviewKey)).toBeUndefined();
          expect(secondClient.getQueryData(groupsKey)).toBeUndefined();
          expect(secondClient.getQueryData(factoryKeys.environments("factory-1"))).toBeUndefined();
          expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
          expect(secondClient.getQueryCache().getAll()).toHaveLength(0);
        } finally {
          bridge.stop();
          secondBridge.stop();
          yield* Effect.promise(() => harness.connection.stop());
          queryClient.clear();
          secondClient.clear();
        }
      }),
  );
});
