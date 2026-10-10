import type { FactoryControlAdmission } from "@t3tools/contracts/factoryRpc";
import {
  dispatchSourceCommand,
  sourceActionScopeKey,
  createCommandId,
  createThreadId,
  createMessageId,
} from "./actionPolicy";
import {
  FactoryEnvironmentView,
  FactoryOverviewEvent,
  FactoryOverviewSnapshot,
  FactoryFrameTarget,
  type FactoryThreadKey,
} from "@t3tools/contracts/factory";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { sourceControlAdmissionQuery } from "./useSourceAuthorization";
import { FactoryQueryBridge } from "./queryBridge";
import { factoryKeys, threadDetailKey, targetKey } from "./queryKeys";
import type { FactoryRpcClient } from "./FactoryConnection";
import { FactoryConnection } from "./FactoryConnection";
import { readThreadHistoryPage } from "./sourceDetailApi";
import type { FactoryTransport } from "./transport";
import {
  SourceLeaseError,
  type SourceLease,
  type SourceRpcClient,
  type SourceTransport,
} from "./sourceSessions";
import {
  observeSourceLease,
  renderSourceLeaseState,
  sourceLeaseForTarget,
  type OwnedSourceLeaseState,
} from "./useSourceLease";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForOnline(connection: FactoryConnection) {
  if (connection.status.phase === "online") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = connection.subscribeStatus((status) => {
      if (status.phase === "online") {
        unsubscribe();
        resolve();
      }
    });
  });
}

const synchronizedEvent = Schema.decodeUnknownSync(Schema.toCodecJson(FactoryOverviewEvent))({
  type: "snapshot",
  snapshot: {
    generation: "fixture",
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
function subscribeTerminalMetadata(client: SourceRpcClient) {
  return client["subscribeTerminalMetadata"]({}, { asQueue: false });
}
type TerminalMetadataEvent = Stream.Success<ReturnType<typeof subscribeTerminalMetadata>>;

interface SourceLeaseHarnessOptions {
  readonly admission?: FactoryControlAdmission;
  readonly fetch?: typeof globalThis.fetch;
  readonly sourceClient?: SourceRpcClient;
  readonly sourceState?: "pending" | "offline" | "blocked" | "removing";
  readonly sourceHttpEnabled?: boolean;
  readonly openSourceTransport?: (
    environmentId: string,
    signal: AbortSignal,
  ) => Promise<SourceTransport>;
}

function makeSourceLeaseHarness(options: SourceLeaseHarnessOptions = {}) {
  return Effect.gen(function* () {
    const overviewQueue = yield* Queue.unbounded<typeof synchronizedEvent>();
    yield* Queue.offer(overviewQueue, synchronizedEvent);
    const environments = ["env-a", "env-b"].map((environmentId) =>
      Schema.decodeUnknownSync(FactoryEnvironmentView)({
        registrationId: `registration-${environmentId}`,
        environmentId,
        endpoint: "https://not-used.example",
        label: environmentId,
        platform: null,
        enabled: true,
        state: options.sourceState ?? "online",
        sourceAccess: {
          websocketRoute: `/factory/env/registration-${environmentId}/ws`,
          httpPrefix: `/factory/env/registration-${environmentId}/`,
          capabilities: { websocket: true, http: options.sourceHttpEnabled ?? true },
        },
        credentialStorage: null,
        credentialExpiresAt: null,
        renewal: "unsupported",
        lastSeenAt: null,
        revision: 1,
      }),
    );
    const observations: unknown[] = [];
    const factory = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "factory.source.controlAuthorization")
            return (input: unknown) => {
              observations.push(input);
              return Effect.succeed(
                options.admission ?? { allowed: false, reason: "scope-required" },
              );
            };
          if (property === "factory.environments.list") return () => Effect.succeed(environments);
          if (property === "factory.overview.subscribe")
            return () => Stream.fromQueue(overviewQueue);
          throw new TypeError(`Unexpected factory RPC: ${String(property)}`);
        },
      },
    ) as FactoryRpcClient;
    const source =
      options.sourceClient ??
      (new Proxy(
        {},
        {
          get() {
            return () => Effect.succeed(undefined);
          },
        },
      ) as SourceRpcClient);
    const opens = new Map<string, number>();
    const closes = new Map<string, number>();
    const closedSignals = new Map<string, ReturnType<typeof deferred<void>>>(
      environments.map((environment) => [environment.environmentId, deferred<void>()]),
    );
    const connection = new FactoryConnection({
      origin: "http://factory.test",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      openTransport: async () => ({ factory, factoryId: "factory" }),
      openSourceTransport: async (environment, signal) => {
        opens.set(environment.environmentId, (opens.get(environment.environmentId) ?? 0) + 1);
        const transport =
          options.openSourceTransport === undefined
            ? ({
                client: source,
                environmentId: environment.environmentId,
                httpPrefix: environment.sourceAccess?.httpPrefix,
                close: async () => {},
              } satisfies SourceTransport)
            : await options.openSourceTransport(environment.environmentId, signal);
        return {
          ...transport,
          close: async () => {
            closes.set(environment.environmentId, (closes.get(environment.environmentId) ?? 0) + 1);
            closedSignals.get(environment.environmentId)?.resolve(undefined);
            await transport.close();
          },
        } satisfies SourceTransport;
      },
    });
    const overviewLease = connection.acquireStream(
      JSON.stringify(factoryKeys.overview("factory")),
      (client) => client["factory.overview.subscribe"]({}),
      () => {},
    );
    connection.start();
    return {
      connection,
      environments,
      observations,
      offerOverviewSnapshot: () => Queue.offer(overviewQueue, synchronizedEvent),
      stop: async () => {
        overviewLease.release();
        await connection.stop();
      },
      acquireSource: (environmentId: string) => connection.acquireSource(environmentId),
      openCount: (environmentId: string) => opens.get(environmentId) ?? 0,
      closeCount: (environmentId: string) => closes.get(environmentId) ?? 0,
      closed: (environmentId: string) => closedSignals.get(environmentId)!.promise,
    };
  });
}

describe("source session leases", () => {
  it.live("shares one source RPC session and closes it after its last consumer releases", () =>
    Effect.gen(function* () {
      const harness = yield* makeSourceLeaseHarness();
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const first = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const second = yield* Effect.promise(() => harness.acquireSource("env-a"));
        expect(harness.openCount("env-a")).toBe(1);
        first.release();
        expect(harness.closeCount("env-a")).toBe(0);
        second.release();
        yield* Effect.promise(() => harness.closed("env-a"));
        expect(harness.closeCount("env-a")).toBe(1);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("shares a source stream until its last consumer releases", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<TerminalMetadataEvent>();
      const streamClosed = deferred<void>();
      const firstEvent = deferred<TerminalMetadataEvent>();
      const secondEvent = deferred<TerminalMetadataEvent>();
      let streamStarts = 0;
      const sourceClient = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "subscribeTerminalMetadata") {
              return () => {
                streamStarts += 1;
                return Stream.fromQueue(queue).pipe(
                  Stream.ensuring(Effect.sync(() => streamClosed.resolve(undefined))),
                );
              };
            }
            return () => Effect.succeed(undefined);
          },
        },
      ) as SourceRpcClient;
      const harness = yield* makeSourceLeaseHarness({ sourceClient });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const firstLease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const secondLease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const firstStream = firstLease.acquireStream(
          "terminal-metadata",
          subscribeTerminalMetadata,
          (event) => firstEvent.resolve(event),
        );
        const secondStream = secondLease.acquireStream(
          "terminal-metadata",
          subscribeTerminalMetadata,
          (event) => secondEvent.resolve(event),
        );
        const snapshot: TerminalMetadataEvent = { type: "snapshot", terminals: [] };
        yield* Queue.offer(queue, snapshot);
        expect(yield* Effect.promise(() => firstEvent.promise)).toEqual(snapshot);
        expect(yield* Effect.promise(() => secondEvent.promise)).toEqual(snapshot);
        expect(streamStarts).toBe(1);

        firstStream.release();
        firstLease.release();
        expect(harness.closeCount("env-a")).toBe(0);
        const nextEvent = deferred<TerminalMetadataEvent>();
        const replacement = secondLease.acquireStream(
          "terminal-metadata",
          subscribeTerminalMetadata,
          (event) => nextEvent.resolve(event),
        );
        yield* Queue.offer(queue, snapshot);
        expect(yield* Effect.promise(() => nextEvent.promise)).toEqual(snapshot);
        replacement.release();
        secondStream.release();
        secondLease.release();
        yield* Effect.promise(() => streamClosed.promise);
        yield* Effect.promise(() => harness.closed("env-a"));
        expect(streamStarts).toBe(1);
        expect(harness.closeCount("env-a")).toBe(1);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live(
    "blocks an HTTP-denied held lease while the overview remains fresh and rejects late reads",
    () =>
      Effect.gen(function* () {
        const started = deferred<void>();
        const response = deferred<Response>();
        const harness = yield* makeSourceLeaseHarness({
          fetch: async (input) => {
            if (String(input).includes("pending")) {
              started.resolve();
              return response.promise;
            }
            return new Response("", { status: 403 });
          },
        });
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const pending = lease
            .readHttp("/api/orchestration/threads/pending/bounded", Schema.Unknown)
            .then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
          yield* Effect.promise(() => started.promise);
          yield* Effect.promise(() =>
            expect(lease.readHttp("/api/projects", Schema.Unknown)).rejects.toMatchObject({
              reason: "authorization",
            }),
          );
          expect(lease.status.phase).toBe("blocked");
          response.resolve(Response.json({ protected: "late" }));
          expect(yield* Effect.promise(() => pending)).toMatchObject({
            error: { reason: "authorization" },
          });
          expect(harness.connection.status.phase).toBe("online");
          yield* Effect.promise(() =>
            expect(harness.acquireSource("env-a")).rejects.toMatchObject({
              reason: "authorization",
            }),
          );
          const other = yield* Effect.promise(() => harness.acquireSource("env-b"));
          expect(other.status.phase).toBe("online");
        } finally {
          yield* Effect.promise(() => harness.stop());
        }
      }),
  );

  it.live(
    "evicts only the revoked source across actual QueryClients and aborts late HTTP/stream content before it can repopulate",
    () =>
      Effect.gen(function* () {
        const started = deferred<AbortSignal>();
        const response = deferred<Response>();
        const harness = yield* makeSourceLeaseHarness({
          fetch: async (_input, init) => {
            started.resolve(init!.signal!);
            return response.promise;
          },
        });
        const cache = new QueryClient();
        const otherCache = new QueryClient();
        const bridge = new FactoryQueryBridge(harness.connection, cache);
        const otherBridge = new FactoryQueryBridge(harness.connection, otherCache);
        bridge.start();
        otherBridge.start();
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const a = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const b = yield* Effect.promise(() => harness.acquireSource("env-b"));
          const rootA = threadDetailKey("factory", "env-a", "same", "registration-env-a");
          const rootB = threadDetailKey("factory", "env-b", "same", "registration-env-b");
          const key = [...rootA, "http-download"];
          const pending = cache
            .fetchQuery({
              queryKey: key,
              retry: false,
              queryFn: ({ signal }) => a.readHttp("/api/projects", Schema.Unknown, { signal }),
            })
            .then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
          const signal = yield* Effect.promise(() => started.promise);
          const kinds = [
            "snapshot",
            "files",
            "file",
            "diff",
            "checkpoint",
            "history",
            "events",
            "vcs",
            "terminal-metadata",
            "terminal-output",
          ];
          for (const client of [cache, otherCache]) {
            for (const kind of kinds)
              client.setQueryData([...rootA, kind], { content: "protected A" });
            client.setQueryData(
              factoryKeys.sourceConfig("factory", "env-a", "registration-env-a"),
              "protected config",
            );
            client.setQueryData(
              factoryKeys.controlAdmission(
                "factory",
                "env-a",
                a.sessionId,
                "launch",
                "registration-env-a",
              ),
              "protected admission",
            );
            client.setQueryData([...rootB, "file"], { content: "protected B" });
            client.setQueryData(
              threadDetailKey("factory", "env-a", "same", "other-registration"),
              "other registration detail",
            );
            client.setQueryData(
              threadDetailKey("another-factory", "env-a", "same", "registration-env-a"),
              "other factory",
            );
            client.setQueryData(
              factoryKeys.embeddedRoute(
                "factory",
                Schema.decodeUnknownSync(FactoryFrameTarget)({
                  registrationId: "old-registration",
                  environmentId: "env-a",
                  threadId: "same",
                }),
              ),
              "other registration",
            );
            client.setQueryData(
              factoryKeys.embeddedRoute(
                "factory",
                Schema.decodeUnknownSync(FactoryFrameTarget)({
                  registrationId: "registration-env-a",
                  environmentId: "env-a",
                  threadId: "same",
                }),
              ),
              "protected route",
            );
          }
          harness.connection.updateSourceAccess(
            Schema.decodeUnknownSync(FactoryOverviewSnapshot)({
              ...(synchronizedEvent.type === "snapshot"
                ? synchronizedEvent.snapshot
                : (() => {
                    throw new Error("Expected snapshot");
                  })()),
              sourceFreshness: [
                {
                  target: { registrationId: "registration-env-a", environmentId: "env-a" },
                  state: "fresh",
                  reason: null,
                  updatedAt: null,
                  retryAt: null,
                },
              ],
            }),
          );
          const blocked = deferred<void>();
          const stopListening = harness.connection.subscribeSourceAccess((event) => {
            if (event.state === "blocked") blocked.resolve();
          });
          let lateCallbacks = 0;
          const stream = a.acquireStream(
            "denied",
            () =>
              Stream.fail(
                new SourceLeaseError({ reason: "authorization", message: "Source denied read" }),
              ),
            () => {
              lateCallbacks += 1;
              cache.setQueryData([...rootA, "events"], "late event");
            },
            () => {
              lateCallbacks += 1;
              cache.setQueryData([...rootA, "events", "error"], "late error");
            },
          );
          yield* Effect.promise(() => blocked.promise);
          expect(signal.aborted).toBe(true);
          expect(a.status.phase).toBe("blocked");
          expect(b.status.phase).toBe("online");
          expect(harness.connection.status.phase).toBe("online");
          expect(harness.connection.isSourceBlocked("env-a")).toBe(true);
          yield* Effect.promise(() =>
            expect(harness.connection.retrySource("env-a")).rejects.toThrow("blocked"),
          );
          response.resolve(Response.json({ content: "late protected A" }));
          expect(yield* Effect.promise(() => pending)).toHaveProperty("error");
          for (const client of [cache, otherCache]) {
            for (const kind of kinds) expect(client.getQueryData([...rootA, kind])).toBeUndefined();
            expect(client.getQueryData(key)).toBeUndefined();
            expect(
              client.getQueryData(
                factoryKeys.sourceConfig("factory", "env-a", "registration-env-a"),
              ),
            ).toBeUndefined();
            expect(
              client.getQueryData(
                factoryKeys.controlAdmission(
                  "factory",
                  "env-a",
                  a.sessionId,
                  "launch",
                  "registration-env-a",
                ),
              ),
            ).toBeUndefined();
            expect(client.getQueryData([...rootB, "file"])).toEqual({ content: "protected B" });
            expect(
              client.getQueryData(
                threadDetailKey("factory", "env-a", "same", "other-registration"),
              ),
            ).toBe("other registration detail");
            expect(
              client.getQueryData(
                threadDetailKey("another-factory", "env-a", "same", "registration-env-a"),
              ),
            ).toBe("other factory");
            expect(
              client.getQueryData(
                factoryKeys.embeddedRoute(
                  "factory",
                  Schema.decodeUnknownSync(FactoryFrameTarget)({
                    registrationId: "old-registration",
                    environmentId: "env-a",
                    threadId: "same",
                  }),
                ),
              ),
            ).toBe("other registration");
            expect(
              client.getQueryData(
                factoryKeys.embeddedRoute(
                  "factory",
                  Schema.decodeUnknownSync(FactoryFrameTarget)({
                    registrationId: "registration-env-a",
                    environmentId: "env-a",
                    threadId: "same",
                  }),
                ),
              ),
            ).toBeUndefined();
          }
          expect(lateCallbacks).toBe(0);
          // An unchanged fresh overview must not override denial from a held source lease.
          harness.connection.updateSourceAccess(
            Schema.decodeUnknownSync(FactoryOverviewSnapshot)({
              ...(synchronizedEvent.type === "snapshot"
                ? synchronizedEvent.snapshot
                : (() => {
                    throw new Error("Expected snapshot");
                  })()),
              sourceFreshness: [
                {
                  target: { registrationId: "registration-env-a", environmentId: "env-a" },
                  state: "fresh",
                  reason: null,
                  updatedAt: null,
                  retryAt: null,
                },
              ],
            }),
          );
          expect(harness.connection.isSourceBlocked("env-a")).toBe(true);
          stopListening();
          stream.release();
        } finally {
          bridge.stop();
          otherBridge.stop();
          yield* Effect.promise(() => harness.stop());
          cache.clear();
          otherCache.clear();
        }
      }),
  );

  it.live(
    "explicitly retries a failed read session for all observing consumers without retrying the Factory",
    () =>
      Effect.gen(function* () {
        const streamFailed = deferred<void>();
        const streamFinalized = deferred<void>();
        let fail = true;
        const sourceClient = new Proxy(
          {},
          {
            get: () => () =>
              fail
                ? Stream.fail(new Error("Read socket disconnected")).pipe(
                    Stream.ensuring(Effect.sync(() => streamFinalized.resolve())),
                  )
                : Stream.never,
          },
        ) as SourceRpcClient;
        const harness = yield* makeSourceLeaseHarness({ sourceClient });
        const statesA: OwnedSourceLeaseState[] = [];
        const statesB: OwnedSourceLeaseState[] = [];
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const first = observeSourceLease(harness.connection, "env-a", (state) => {
          statesA.push(state);
          if (state.status.phase === "offline") streamFailed.resolve();
        });
        const second = observeSourceLease(harness.connection, "env-a", (state) =>
          statesB.push(state),
        );
        try {
          yield* Effect.promise(() => Promise.all([first.settled, second.settled]));
          const oldLease = statesA.at(-1)!.lease!;
          oldLease.acquireStream(
            "failure",
            () => sourceClient["subscribeTerminalMetadata"]({}, { asQueue: false }),
            () => {},
          );
          yield* Effect.promise(() => streamFailed.promise);
          yield* Effect.promise(() => streamFinalized.promise);
          expect(statesB.at(-1)?.status.phase).toBe("offline");
          const registry = harness.connection.actions;
          const scope = {
            type: "thread",
            factoryId: "factory",
            environmentId: "env-a",
            threadId: "same",
          } as const;
          yield* Effect.promise(() =>
            expect(
              registry.dispatch({
                scope,
                commandId: "uncertain-before-read-retry",
                intent: { kind: "interrupt", runId: "run" },
                baseSequence: 1,
                state: { online: true, synchronized: true, allowed: true },
                request: async () => {
                  throw new Error("Socket closed after send");
                },
              }),
            ).rejects.toMatchObject({ name: "SourceCommandUncertainError" }),
          );
          fail = false;
          yield* Effect.promise(() =>
            Promise.all([
              harness.connection.retrySource("env-a"),
              harness.connection.retrySource("env-a"),
            ]),
          );
          yield* Effect.promise(() => Promise.all([first.settled, second.settled]));
          expect(statesA.at(-1)?.status.phase).toBe("online");
          expect(statesB.at(-1)?.lease?.sessionId).toBe(statesA.at(-1)?.lease?.sessionId);
          expect(statesA.at(-1)?.lease?.sessionId).not.toBe(oldLease.sessionId);
          expect(harness.openCount("env-a")).toBe(2);
          expect(harness.closeCount("env-a")).toBe(1);
          expect(harness.connection.status.phase).toBe("online");
          expect(harness.connection.actions).toBe(registry);
          expect(registry.blocking(scope)).toMatchObject({
            phase: "uncertain",
            commandId: "uncertain-before-read-retry",
          });
        } finally {
          first.dispose();
          second.dispose();
          yield* Effect.promise(() => harness.stop());
        }
      }),
  );

  it.live(
    "evicts the predecessor registration when an environment-list read observes replacement before the overview",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSourceLeaseHarness();
        const cache = new QueryClient();
        const bridge = new FactoryQueryBridge(harness.connection, cache);
        bridge.start();
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const overview = Schema.decodeUnknownSync(FactoryOverviewSnapshot)({
            ...(synchronizedEvent.type === "snapshot" ? synchronizedEvent.snapshot : {}),
            environments: harness.environments,
            sourceFreshness: [
              {
                target: { registrationId: "registration-env-a", environmentId: "env-a" },
                state: "fresh",
                reason: null,
                updatedAt: null,
                retryAt: null,
              },
            ],
          });
          harness.connection.updateSourceAccess(overview);
          const old = threadDetailKey("factory", "env-a", "same", "registration-env-a");
          const other = threadDetailKey("factory", "env-b", "same", "registration-env-b");
          cache.setQueryData(old, { content: "protected predecessor" });
          cache.setQueryData(other, { content: "preserved B" });
          const previous = harness.environments[0];
          harness.environments[0] = Schema.decodeUnknownSync(FactoryEnvironmentView)({
            ...previous,
            registrationId: "replacement-a",
          });
          const b = yield* Effect.promise(() => harness.acquireSource("env-b"));
          expect(cache.getQueryData(old)).toBeUndefined();
          expect(cache.getQueryData(other)).toEqual({ content: "preserved B" });
          const a = yield* Effect.promise(() => harness.acquireSource("env-a"));
          expect(a.registrationId).toBe("replacement-a");
          expect(
            sourceLeaseForTarget(
              a,
              Schema.decodeUnknownSync(FactoryFrameTarget)({
                registrationId: "registration-env-a",
                environmentId: "env-a",
                threadId: "same",
              }),
            ),
          ).toBeUndefined();
          a.release();
          b.release();
        } finally {
          bridge.stop();
          yield* Effect.promise(() => harness.stop());
          cache.clear();
        }
      }),
  );

  it.live(
    "keeps a native dispatcher command uncertain across explicit read retry without generating or replaying another command",
    () =>
      Effect.gen(function* () {
        type Command = Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0];
        const sent: Command[] = [];
        const sourceClient = new Proxy(
          {},
          {
            get(_target, method) {
              if (method === "orchestration.dispatchCommand")
                return (command: Command) =>
                  Effect.sync(() => sent.push(command)).pipe(
                    Effect.andThen(Effect.fail(new Error("Socket closed after send"))),
                  );
              throw new Error(`Unexpected native method ${String(method)}`);
            },
          },
        ) as SourceRpcClient;
        const harness = yield* makeSourceLeaseHarness({ sourceClient });
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const command = {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: createCommandId(),
            threadId: createThreadId(),
            messageId: createMessageId(),
            text: "Native prompt",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          } as const;
          const scope = {
            type: "thread",
            factoryId: "factory",
            environmentId: "env-a",
            threadId: command.threadId,
          } as const;
          const dispatch = (current: SourceLease) =>
            dispatchSourceCommand({
              registry: harness.connection.actions,
              scope,
              lease: current,
              state: { online: true, synchronized: true, allowed: true },
              command,
              intent: { kind: "prompt", messageId: command.messageId },
              baseSequence: 0,
            });
          yield* Effect.promise(() =>
            expect(dispatch(lease)).rejects.toMatchObject({ name: "SourceCommandUncertainError" }),
          );
          const offline = deferred<void>();
          const unsubscribe = lease.subscribeStatus((status) => {
            if (status.phase === "offline") offline.resolve();
          });
          lease.acquireStream(
            "read-failure",
            () => Stream.fail(new Error("Read connection failed")),
            () => {},
          );
          yield* Effect.promise(() => offline.promise);
          yield* Effect.promise(() => harness.connection.retrySource("env-a"));
          const fresh = yield* Effect.promise(() => harness.acquireSource("env-a"));
          yield* Effect.promise(() => expect(dispatch(fresh)).rejects.toThrow("uncertain"));
          expect(sent.map((item) => item.commandId)).toEqual([command.commandId]);
          expect(harness.connection.actions.blocking(scope)).toMatchObject({
            commandId: command.commandId,
            phase: "uncertain",
          });
          unsubscribe();
          fresh.release();
          lease.release();
        } finally {
          yield* Effect.promise(() => harness.stop());
        }
      }),
  );

  it.live("rejects a source transport that reports a different environment identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeSourceLeaseHarness({
        openSourceTransport: async () => ({
          client: new Proxy({}, { get: () => () => Effect.succeed(undefined) }) as SourceRpcClient,
          environmentId: "env-b",
          close: async () => {},
        }),
      });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        yield* Effect.promise(() =>
          expect(harness.acquireSource("env-a")).rejects.toMatchObject({
            _tag: "SourceLeaseError",
            reason: "identity-mismatch",
          }),
        );
        yield* Effect.promise(() => harness.closed("env-a"));
        expect(harness.closeCount("env-a")).toBe(1);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("uses the bounded history schema and the advertised same-origin HTTP relay", () =>
    Effect.gen(function* () {
      let requestUrl = "";
      let requestHeaders: Headers | undefined;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        requestUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            snapshotSequence: 7,
            items: [],
            nextCursor: "older-next",
            hasMoreHistory: true,
          }),
          { headers: { "content-type": "application/json" } },
        );
      };
      const harness = yield* makeSourceLeaseHarness({ fetch });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const cursor = "older cursor/+?";
        const page = yield* Effect.promise(() => readThreadHistoryPage(lease, "thread-a", cursor));
        const url = new URL(requestUrl, "http://factory.test");
        expect(page.nextCursor).toBe("older-next");
        expect(url.pathname).toBe(
          "/factory/env/registration-env-a/api/orchestration/threads/thread-a/history",
        );
        expect(url.searchParams.get("cursor")).toBe(cursor);
        expect(url.searchParams.getAll("environmentId")).toEqual(["env-a"]);
        expect(requestHeaders?.get("x-t3-orchestration-protocol")).toBe("2");
        expect(lease.resolveAssetUrl("/api/assets/thread-a/asset-1")).toBe(
          "/factory/env/registration-env-a/api/assets/thread-a/asset-1?environmentId=env-a",
        );
        expect(lease.resolveAssetUrl("/api/assets/fixture.signature/report%20file.txt")).toBe(
          "/factory/env/registration-env-a/api/assets/fixture.signature/report%20file.txt?environmentId=env-a",
        );
        lease.release();
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("rejects history data that does not match the pinned source schema", () =>
    Effect.gen(function* () {
      const fetch: typeof globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            snapshotSequence: 7,
            items: [],
            nextCursor: null,
            hasMoreHistory: "false",
          }),
          { headers: { "content-type": "application/json" } },
        );
      const harness = yield* makeSourceLeaseHarness({ fetch });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        yield* Effect.promise(() =>
          expect(readThreadHistoryPage(lease, "thread-a", "cursor")).rejects.toMatchObject({
            _tag: "SourceLeaseError",
            reason: "invalid-data",
          }),
        );
        lease.release();
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("does not open new detail reads for a stale source environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeSourceLeaseHarness({ sourceState: "offline" });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        yield* Effect.promise(() =>
          expect(harness.acquireSource("env-a")).rejects.toMatchObject({
            _tag: "SourceLeaseError",
            reason: "source-unavailable",
          }),
        );
        expect(harness.openCount("env-a")).toBe(0);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("does not use an advertised prefix when the source denies HTTP capability", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const harness = yield* makeSourceLeaseHarness({
        sourceHttpEnabled: false,
        fetch: async () => {
          fetchCount += 1;
          return new Response("{}");
        },
      });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        yield* Effect.promise(() =>
          expect(lease.readHttp("/api/projects", Schema.Unknown)).rejects.toMatchObject({
            reason: "unsupported-http",
          }),
        );
        expect(() => lease.resolveAssetUrl("/api/assets/thread-a/asset-1")).toThrowError(
          expect.objectContaining({ reason: "unsupported-http" }),
        );
        expect(fetchCount).toBe(0);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("cancels the prior hook acquisition and never publishes an obsolete completion", () =>
    Effect.gen(function* () {
      const opening = deferred<AbortSignal>();
      const pending = deferred<SourceTransport>();
      const harness = yield* makeSourceLeaseHarness({
        openSourceTransport: async (environmentId, signal) => {
          if (environmentId === "env-a") {
            opening.resolve(signal);
            return pending.promise;
          }
          return {
            client: new Proxy(
              {},
              { get: () => () => Effect.succeed(undefined) },
            ) as SourceRpcClient,
            environmentId,
            close: async () => {},
          };
        },
      });
      const oldStates: OwnedSourceLeaseState[] = [];
      const newStates: OwnedSourceLeaseState[] = [];
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const prior = observeSourceLease(harness.connection, "env-a", (state) =>
          oldStates.push(state),
        );
        const signal = yield* Effect.promise(() => opening.promise);
        prior.dispose();
        expect(signal.aborted).toBe(true);
        const next = observeSourceLease(harness.connection, "env-b", (state) =>
          newStates.push(state),
        );
        try {
          yield* Effect.promise(() => next.settled);
          expect(
            renderSourceLeaseState(newStates.at(-1)!, harness.connection, "env-b", true).lease
              ?.environmentId,
          ).toBe("env-b");
          pending.resolve({
            client: new Proxy(
              {},
              { get: () => () => Effect.succeed(undefined) },
            ) as SourceRpcClient,
            environmentId: "env-a",
            close: async () => {},
          });
          yield* Effect.promise(() => prior.settled);
          yield* Effect.promise(() => harness.closed("env-a"));
          expect(oldStates.map((state) => state.status.phase)).toEqual(["connecting"]);
          expect(harness.closeCount("env-a")).toBe(1);
          expect(
            renderSourceLeaseState(oldStates[0]!, harness.connection, "env-b", true).lease,
          ).toBeUndefined();
        } finally {
          next.dispose();
        }
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("releases an already acquired lease delivered after hook cleanup", () =>
    Effect.gen(function* () {
      const delivered = deferred<Awaited<ReturnType<FactoryConnection["acquireSource"]>>>();
      const harness = yield* makeSourceLeaseHarness();
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const states: OwnedSourceLeaseState[] = [];
        const observation = observeSourceLease(
          { acquireSource: () => delivered.promise },
          "env-a",
          (state) => states.push(state),
        );
        observation.dispose();
        delivered.resolve(lease);
        yield* Effect.promise(() => observation.settled);
        yield* Effect.promise(() => harness.closed("env-a"));
        expect(states.map((state) => state.status.phase)).toEqual(["connecting"]);
        expect(harness.closeCount("env-a")).toBe(1);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("aborts one-shot HTTP reads when the final source lease releases", () =>
    Effect.gen(function* () {
      const started = deferred<AbortSignal>();
      const fetch: typeof globalThis.fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null)
            throw new Error("Expected an abortable source read.");
          started.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      const harness = yield* makeSourceLeaseHarness({ fetch });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const reading = lease.readHttp("/api/projects", Schema.Unknown);
        const signal = yield* Effect.promise(() => started.promise);
        lease.release();
        expect(signal.aborted).toBe(true);
        yield* Effect.promise(() =>
          expect(reading).rejects.toMatchObject({
            _tag: "SourceLeaseError",
            reason: "lease-released",
          }),
        );
        yield* Effect.promise(() => harness.closed("env-a"));
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("marks late source reads obsolete when the factory retries", () =>
    Effect.gen(function* () {
      const started = deferred<AbortSignal>();
      const response = deferred<Response>();
      const fetch: typeof globalThis.fetch = (_input, init) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null)
          throw new Error("Expected an abortable source read.");
        started.resolve(signal);
        return response.promise;
      };
      const harness = yield* makeSourceLeaseHarness({ fetch });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const reading = lease.readHttp("/api/projects", Schema.Unknown);
        const signal = yield* Effect.promise(() => started.promise);
        harness.connection.retry();
        expect(signal.aborted).toBe(true);
        response.resolve(
          new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          }),
        );
        yield* Effect.promise(() =>
          expect(reading).rejects.toMatchObject({
            _tag: "SourceLeaseError",
            reason: "stale-attempt",
          }),
        );
        yield* Effect.promise(() => harness.closed("env-a"));
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live("aborts and closes a delayed source transport when the factory stops", () =>
    Effect.gen(function* () {
      const opening = deferred<void>();
      const pendingTransport = deferred<SourceTransport>();
      let signal: AbortSignal | undefined;
      const harness = yield* makeSourceLeaseHarness({
        openSourceTransport: async (_environmentId, currentSignal) => {
          signal = currentSignal;
          opening.resolve(undefined);
          return pendingTransport.promise;
        },
      });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const acquisition = harness.acquireSource("env-a");
        yield* Effect.promise(() => opening.promise);
        const stopped = harness.connection.stop();
        expect(signal?.aborted).toBe(true);
        pendingTransport.resolve({
          client: new Proxy({}, { get: () => () => Effect.succeed(undefined) }) as SourceRpcClient,
          environmentId: "env-a",
          close: async () => {},
        });
        yield* Effect.promise(() =>
          expect(acquisition).rejects.toMatchObject({
            _tag: "SourceLeaseError",
            reason: "stale-attempt",
          }),
        );
        yield* Effect.promise(() => stopped);
        expect(harness.closeCount("env-a")).toBe(1);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );
});

describe("factory/source principal separation for native control", () => {
  it.live.each([true, false])(
    "uses factory admission, never a source scope-list read, allowed=%s",
    (allowed) =>
      Effect.gen(function* () {
        const commands: unknown[] = [];
        const sourceClient = new Proxy(
          {},
          {
            get(_target, method) {
              if (method !== "orchestration.dispatchCommand")
                throw new Error(`Unexpected source method ${String(method)}`);
              return (command: unknown) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 42 };
                });
            },
          },
        ) as SourceRpcClient;
        const harness = yield* makeSourceLeaseHarness({
          sourceClient,
          admission: allowed
            ? { allowed: true }
            : { allowed: false, reason: "source-scope-required" },
        });
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const admission = yield* Effect.promise(() => lease.observeControl("message.dispatch"));
          expect(harness.observations).toEqual([
            {
              target: { registrationId: "registration-env-a", environmentId: "env-a" },
              operation: "message.dispatch",
            },
          ]);
          const command = {
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: createCommandId(),
            threadId: createThreadId(),
            messageId: createMessageId(),
            text: "Native prompt",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          } as const;
          const dispatch = dispatchSourceCommand({
            registry: harness.connection.actions,
            scope: {
              type: "thread",
              factoryId: "factory",
              environmentId: "env-a",
              threadId: command.threadId,
            },
            lease,
            state: { online: true, synchronized: true, allowed: admission.allowed },
            command,
            intent: { kind: "prompt", messageId: command.messageId },
            baseSequence: 0,
          });
          if (allowed) {
            expect(yield* Effect.promise(() => dispatch)).toEqual({ sequence: 42 });
            expect(commands).toEqual([command]);
          } else {
            yield* Effect.promise(() => expect(dispatch).rejects.toThrow("not authorized"));
            expect(commands).toEqual([]);
          }
          lease.release();
          yield* Effect.promise(() =>
            expect(lease.observeControl("launch")).rejects.toMatchObject({
              reason: "lease-released",
            }),
          );
          expect(harness.observations).toHaveLength(1);
        } finally {
          yield* Effect.promise(() => harness.stop());
        }
      }),
  );
});

describe("connection-owned native action guard", () => {
  type DispatchInput = Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0];
  const respondingSource = (
    respond: (command: DispatchInput) => Promise<{ readonly sequence: number }>,
  ) => {
    const commands: DispatchInput[] = [];
    const sourceClient = new Proxy(
      {},
      {
        get(_target, method) {
          if (method !== "orchestration.dispatchCommand")
            throw new Error(`Unexpected source method ${String(method)}`);
          return (command: DispatchInput) =>
            Effect.promise(() => {
              commands.push(command);
              return respond(command);
            });
        },
      },
    ) as SourceRpcClient;
    return { commands, sourceClient };
  };
  const synchronized = { online: true, synchronized: true, allowed: true } as const;
  const prompt = (threadId: string) =>
    ({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: createCommandId(),
      threadId: threadId as ReturnType<typeof createThreadId>,
      messageId: createMessageId(),
      text: "Native prompt",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    }) as const;
  const threadScope = (environmentId: string, threadId: string) =>
    ({ type: "thread", factoryId: "factory", environmentId, threadId }) as const;
  const evidence = (snapshotSequence: number, userMessageIds: readonly string[]) =>
    ({
      type: "thread",
      snapshotSequence,
      sourceStatus: "running",
      settled: false,
      userMessageIds,
      runs: [],
      runtimeRequests: [],
      rollbackRequestId: null,
      rollbackFailureRequestId: undefined,
    }) as const;

  it.live(
    "keeps an uncertain command blocking a new caller across lease release, retry, and reacquire until fresh matching evidence",
    () =>
      Effect.gen(function* () {
        let failNext = true;
        const source = respondingSource(async () => {
          if (failNext) {
            failNext = false;
            throw new Error("Socket closed after send");
          }
          return { sequence: 50 };
        });
        const harness = yield* makeSourceLeaseHarness({ sourceClient: source.sourceClient });
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const registry = harness.connection.actions;
          const scope = threadScope("env-a", "thread-1");
          const firstLease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const original = prompt("thread-1");
          yield* Effect.promise(() =>
            expect(
              dispatchSourceCommand({
                registry,
                scope,
                lease: firstLease,
                state: synchronized,
                command: original,
                intent: { kind: "prompt", messageId: original.messageId },
                baseSequence: 10,
              }),
            ).rejects.toMatchObject({ name: "SourceCommandUncertainError" }),
          );
          expect(source.commands).toHaveLength(1);

          firstLease.release();
          harness.connection.retry();
          expect(harness.connection.status.phase).not.toBe("online");
          yield* harness.offerOverviewSnapshot();
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const secondLease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          expect(secondLease.sessionId).not.toBe(firstLease.sessionId);
          expect(harness.connection.actions).toBe(registry);
          expect(registry.blocking(scope)).toMatchObject({
            commandId: original.commandId,
            phase: "uncertain",
          });

          const second = prompt("thread-1");
          yield* Effect.promise(() =>
            expect(
              dispatchSourceCommand({
                registry,
                scope,
                lease: secondLease,
                state: synchronized,
                command: second,
                intent: { kind: "prompt", messageId: second.messageId },
                baseSequence: 10,
              }),
            ).rejects.toThrow("uncertain"),
          );
          yield* Effect.promise(() =>
            expect(
              registry.dispatch({
                scope,
                commandId: createCommandId(),
                intent: { kind: "runtime-response", requestId: "request-1" },
                baseSequence: 10,
                state: synchronized,
                request: (commandId) =>
                  secondLease.request((client) =>
                    client["orchestration.dispatchCommand"]({
                      ...second,
                      commandId: commandId as typeof second.commandId,
                    }),
                  ),
              }),
            ).rejects.toThrow("uncertain"),
          );
          expect(source.commands).toHaveLength(1);

          const unrelated = [prompt("thread-1"), { ...prompt("thread-2") }];
          const unrelatedLease = yield* Effect.promise(() => harness.acquireSource("env-b"));
          yield* Effect.promise(() =>
            dispatchSourceCommand({
              registry,
              scope: threadScope("env-b", "thread-1"),
              lease: unrelatedLease,
              state: synchronized,
              command: { ...unrelated[0], commandId: original.commandId },
              intent: { kind: "prompt", messageId: unrelated[0].messageId },
              baseSequence: 1,
            }),
          );
          yield* Effect.promise(() =>
            dispatchSourceCommand({
              registry,
              scope: threadScope("env-a", "thread-2"),
              lease: secondLease,
              state: synchronized,
              command: unrelated[1],
              intent: { kind: "prompt", messageId: unrelated[1].messageId },
              baseSequence: 1,
            }),
          );
          expect(source.commands.map((command) => command.commandId)).toEqual([
            original.commandId,
            original.commandId,
            unrelated[1].commandId,
          ]);

          registry.reconcile(scope, evidence(10, [original.messageId]));
          expect(registry.blocking(scope)?.commandId).toBe(original.commandId);
          registry.reconcile(scope, evidence(11, ["other-message"]));
          expect(registry.blocking(scope)?.commandId).toBe(original.commandId);
          registry.reconcile(scope, evidence(11, [original.messageId]));
          expect(registry.blocking(scope)).toBeUndefined();
          expect(
            registry
              .records(sourceActionScopeKey(scope))
              .find((record) => record.commandId === original.commandId)?.phase,
          ).toBe("confirmed");

          yield* Effect.promise(() =>
            expect(
              dispatchSourceCommand({
                registry,
                scope,
                lease: secondLease,
                state: synchronized,
                command: original,
                intent: { kind: "prompt", messageId: original.messageId },
                baseSequence: 11,
              }),
            ).rejects.toThrow("already been sent"),
          );
          expect(
            yield* Effect.promise(() =>
              dispatchSourceCommand({
                registry,
                scope,
                lease: secondLease,
                state: synchronized,
                command: second,
                intent: { kind: "prompt", messageId: second.messageId },
                baseSequence: 11,
              }),
            ),
          ).toEqual({ sequence: 50 });
          expect(source.commands).toHaveLength(4);

          yield* Effect.promise(() => harness.stop());
          expect(registry.blocking(scope)).toBeUndefined();
          expect(registry.records(sourceActionScopeKey(scope))).toEqual([]);
        } finally {
          yield* Effect.promise(() => harness.stop());
        }
      }),
  );

  it.live("blocks a different consumer on the same thread while another command is in flight", () =>
    Effect.gen(function* () {
      const pending = deferred<{ readonly sequence: number }>();
      const source = respondingSource(() => pending.promise);
      const harness = yield* makeSourceLeaseHarness({ sourceClient: source.sourceClient });
      try {
        yield* Effect.promise(() => waitForOnline(harness.connection));
        const registry = harness.connection.actions;
        const scope = threadScope("env-a", "thread-1");
        const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
        const rollbackCommand = prompt("thread-1");
        const rollback = registry.dispatch({
          scope,
          commandId: rollbackCommand.commandId,
          baseSequence: 3,
          state: synchronized,
          intent: { kind: "rollback", checkpointId: "checkpoint-1", previousStatus: "completed" },
          request: () =>
            lease.request((client) => client["orchestration.dispatchCommand"](rollbackCommand)),
        });
        const promptCommand = prompt("thread-1");
        yield* Effect.promise(() =>
          expect(
            dispatchSourceCommand({
              registry,
              scope,
              lease,
              state: synchronized,
              command: promptCommand,
              intent: { kind: "prompt", messageId: promptCommand.messageId },
              baseSequence: 3,
            }),
          ).rejects.toThrow("uncertain"),
        );
        expect(registry.blocking(scope)).toMatchObject({
          commandId: rollbackCommand.commandId,
          phase: "sending",
        });
        pending.resolve({ sequence: 4 });
        expect(yield* Effect.promise(() => rollback)).toEqual({ sequence: 4 });
        expect(source.commands.map((command) => command.commandId)).toEqual([
          rollbackCommand.commandId,
        ]);
      } finally {
        yield* Effect.promise(() => harness.stop());
      }
    }),
  );

  it.live(
    "keeps launch uncertainty per factory project until the overview shows the stable thread key",
    () =>
      Effect.gen(function* () {
        const source = respondingSource(async () => {
          throw new Error("Socket closed after launch");
        });
        const harness = yield* makeSourceLeaseHarness({ sourceClient: source.sourceClient });
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const registry = harness.connection.actions;
          const lease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const scope = {
            type: "launch",
            factoryId: "factory",
            environmentId: "env-a",
            projectId: "project-1",
          } as const;
          const target = {
            environmentId: "env-a" as FactoryThreadKey["environmentId"],
            threadId: createThreadId(),
          };
          const launch = (
            launchScope:
              | typeof scope
              | {
                  readonly type: "launch";
                  readonly factoryId: string;
                  readonly environmentId: string;
                  readonly projectId: string;
                },
          ) =>
            registry.dispatch({
              scope: launchScope,
              commandId: createCommandId(),
              intent: { kind: "launch", target },
              baseSequence: 0,
              state: synchronized,
              request: () =>
                lease.request((client) =>
                  client["orchestration.dispatchCommand"](prompt(target.threadId)),
                ),
            });
          yield* Effect.promise(() =>
            expect(launch(scope)).rejects.toMatchObject({ name: "SourceCommandUncertainError" }),
          );
          yield* Effect.promise(() => expect(launch(scope)).rejects.toThrow("uncertain"));
          expect(source.commands).toHaveLength(1);
          yield* Effect.promise(() =>
            expect(launch({ ...scope, projectId: "project-2" })).rejects.toThrow("Socket closed"),
          );
          expect(source.commands).toHaveLength(2);
          lease.release();
          yield* Effect.promise(() => expect(launch(scope)).rejects.toThrow("uncertain"));
          expect(source.commands).toHaveLength(2);
          registry.reconcile(scope, {
            type: "overview",
            threadKeys: new Set([targetKey({ environmentId: "env-b", threadId: target.threadId })]),
          });
          expect(registry.blocking(scope)?.phase).toBe("uncertain");
          registry.reconcile(scope, { type: "overview", threadKeys: new Set([targetKey(target)]) });
          expect(registry.blocking(scope)).toBeUndefined();
        } finally {
          yield* Effect.promise(() => harness.stop());
        }
      }),
  );

  it.live(
    "shares one admission read per source session and requested operation across consumers",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSourceLeaseHarness({ admission: { allowed: true } });
        const queryClient = new QueryClient();
        try {
          yield* Effect.promise(() => waitForOnline(harness.connection));
          const paneLease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const viewLease = yield* Effect.promise(() => harness.acquireSource("env-a"));
          const observe = (
            lease: SourceLease,
            operation: Parameters<typeof sourceControlAdmissionQuery>[2],
          ) => {
            const observer = new QueryObserver(
              queryClient,
              sourceControlAdmissionQuery("factory", lease, operation),
            );
            return { observer, unsubscribe: observer.subscribe(() => {}) };
          };
          const consumers = [
            observe(paneLease, "runtime-request.respond"),
            observe(viewLease, "runtime-request.respond"),
            observe(viewLease, "checkpoint.rollback"),
          ];
          yield* Effect.promise(() =>
            Promise.all(
              consumers.map(({ observer }) =>
                vi.waitFor(() =>
                  expect(observer.getCurrentResult().data).toEqual({ allowed: true }),
                ),
              ),
            ),
          );
          expect(
            harness.observations
              .map((observation) => (observation as { readonly operation: string }).operation)
              .sort(),
          ).toEqual(["checkpoint.rollback", "runtime-request.respond"]);
          for (const { unsubscribe } of consumers) unsubscribe();
        } finally {
          queryClient.clear();
          yield* Effect.promise(() => harness.stop());
        }
      }),
  );
});
