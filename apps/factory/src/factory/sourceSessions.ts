import {
  resolveSourceHttpUrl,
  SourceHttpUrlError,
  isSafeSourcePath,
} from "@t3tools/contracts/factoryRelayUrl";
import type {
  FactoryControlAdmission,
  FactoryControlOperation,
} from "@t3tools/contracts/factoryRpc";
import type { FactoryRemoteTarget } from "@t3tools/contracts/factory";
import type { FactoryEnvironmentView } from "@t3tools/contracts/factory";
import { WsRpcGroup } from "@t3tools/contracts/rpc";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export type SourceLeaseErrorReason =
  | "connection-not-ready"
  | "environment-not-found"
  | "ambiguous-environment"
  | "source-unavailable"
  | "unsupported-websocket"
  | "unsupported-http"
  | "invalid-route"
  | "identity-mismatch"
  | "protocol-mismatch"
  | "stale-attempt"
  | "unsupported-fixture"
  | "lease-released"
  | "authorization"
  | "http-request"
  | "invalid-data";

export class SourceLeaseError extends Data.TaggedError("SourceLeaseError")<{
  readonly reason: SourceLeaseErrorReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function isSourceAuthorizationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (
    ("reason" in error && error.reason === "authorization") ||
    ("_tag" in error && error._tag === "EnvironmentAuthorizationError") ||
    ("_tag" in error &&
      error._tag === "FactoryError" &&
      "code" in error &&
      error.code === "source-authentication")
  );
}

function sourceError(reason: SourceLeaseErrorReason, message: string, cause?: unknown) {
  return new SourceLeaseError({ reason, message, cause });
}

function sourceOrigin(origin?: string) {
  const current = origin ?? globalThis.location?.origin;
  if (current === undefined)
    throw sourceError("source-unavailable", "The factory origin is not available.");
  return new URL(current).origin;
}

function sourceWebSocketUrl(route: string, environmentId: string, origin: string): URL {
  if (!isSafeSourcePath(route)) {
    throw sourceError("invalid-route", "The factory did not advertise a safe source relay route.");
  }
  const url = new URL(route, origin);
  if (
    url.origin !== origin ||
    url.pathname !== route ||
    url.search ||
    url.hash ||
    url.searchParams.has("environmentId") ||
    url.searchParams.has("orchestrationProtocol")
  ) {
    throw sourceError("invalid-route", "The source relay route must stay on the factory origin.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("environmentId", environmentId);
  url.searchParams.set("orchestrationProtocol", "2");
  return url;
}

export interface SourceTransportOptions {
  readonly origin?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly webSocketConstructor?: Socket.WebSocketConstructor["Service"];
}

function makeSourceRelayEffect(
  environment: FactoryEnvironmentView,
  options: SourceTransportOptions,
  origin: string,
) {
  return Effect.gen(function* () {
    const access = environment.sourceAccess;
    if (access === undefined || !access.capabilities.websocket) {
      return yield* Effect.fail(
        sourceError("unsupported-websocket", "This source does not support WebSocket relay."),
      );
    }
    const url = sourceWebSocketUrl(access.websocketRoute, environment.environmentId, origin);
    const socket = yield* Socket.makeWebSocket(url.href).pipe(
      Effect.provideService(
        Socket.WebSocketConstructor,
        options.webSocketConstructor ??
          ((address, protocols) => {
            if (
              protocols !== undefined &&
              typeof protocols !== "string" &&
              !Array.isArray(protocols)
            ) {
              throw new TypeError("Browser WebSocket headers are not supported");
            }
            return new globalThis.WebSocket(address, protocols);
          }),
      ),
    );
    const protocol = yield* RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerJson),
    );
    const client = yield* RpcClient.make(WsRpcGroup).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    const config = yield* client["server.getConfig"]({}).pipe(Effect.timeout("10 seconds"));
    if (config.environment.environmentId !== environment.environmentId) {
      return yield* Effect.fail(
        sourceError(
          "identity-mismatch",
          "The relayed source identity does not match this environment.",
        ),
      );
    }
    if (config.environment.orchestrationProtocolVersion !== 2) {
      return yield* Effect.fail(
        sourceError("protocol-mismatch", "The source does not support orchestration protocol 2."),
      );
    }
    return { client, environmentId: config.environment.environmentId };
  });
}

export type SourceRpcClient = Effect.Success<ReturnType<typeof makeSourceRelayEffect>>["client"];

export interface SourceTransport {
  readonly client: SourceRpcClient;
  readonly environmentId: string;
  readonly httpPrefix?: string;
  readonly scope?: Scope.Closeable;
  close(): Promise<void>;
}

async function closeScope(scope: Scope.Closeable) {
  await Effect.runPromise(Scope.close(scope, Exit.void));
}

export async function openSourceRelayTransport(
  environment: FactoryEnvironmentView,
  options: SourceTransportOptions & { readonly signal?: AbortSignal } = {},
): Promise<SourceTransport> {
  const origin = sourceOrigin(options.origin);
  const scope = Scope.makeUnsafe();
  try {
    const opened = await Effect.runPromise(
      Effect.provideService(
        makeSourceRelayEffect(environment, options, origin),
        Scope.Scope,
        scope,
      ),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    return {
      ...opened,
      scope,
      httpPrefix: environment.sourceAccess?.httpPrefix,
      close: () => closeScope(scope),
    };
  } catch (error) {
    await closeScope(scope);
    throw error;
  }
}

export interface SourceSessionStatus {
  readonly phase: "connecting" | "online" | "offline" | "blocked";
  readonly error?: unknown;
}

export interface SourceStreamLease {
  release(): void;
}

export interface SourceLease {
  readonly registrationId: FactoryRemoteTarget["registrationId"];
  observeControl(
    operation: FactoryControlOperation,
    signal?: AbortSignal,
  ): Promise<FactoryControlAdmission>;
  readonly client: SourceRpcClient;
  readonly environmentId: string;
  /** Identifies the shared source session. A new session gets a new ID. */
  readonly sessionId: number;
  readonly status: SourceSessionStatus;
  subscribeStatus(listener: (status: SourceSessionStatus) => void): () => void;
  request<A, Error>(
    request: (client: SourceRpcClient) => Effect.Effect<A, Error>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<A>;
  readHttp<S extends Schema.ConstraintDecoder<unknown>>(
    path: string,
    schema: S,
    options?: { readonly signal?: AbortSignal },
  ): Promise<S["Type"]>;
  resolveAssetUrl(path: string): string;
  acquireStream<Event, StreamError = unknown>(
    key: string,
    subscribe: (client: SourceRpcClient) => Stream.Stream<Event, StreamError>,
    onEvent: (event: Event) => void,
    onError?: (error: StreamError) => void,
  ): SourceStreamLease;
  release(): void;
}

interface StreamConsumer {
  readonly owner: symbol;
  readonly onEvent: (event: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

interface SourceStreamEntry {
  readonly subscribe: (client: SourceRpcClient) => Stream.Stream<unknown, unknown>;
  readonly consumers: Map<symbol, StreamConsumer>;
  controller?: AbortController;
}

interface SourceConsumer {
  readonly id: symbol;
  readonly requests: Set<AbortController>;
  readonly streams: Set<() => void>;
  released: boolean;
}

interface SourceEntry {
  readonly sessionId: number;
  target?: FactoryRemoteTarget;
  readonly environmentId: string;
  readonly controller: AbortController;
  readonly consumers: Map<symbol, SourceConsumer>;
  readonly streams: Map<string, SourceStreamEntry>;
  readonly statusListeners: Set<(status: SourceSessionStatus) => void>;
  httpEnabled: boolean;
  ready?: Promise<SourceTransport>;
  transport?: SourceTransport;
  status: SourceSessionStatus;
  invalidated: boolean;
  invalidatedReason?: SourceLeaseErrorReason;
  closePromise?: Promise<void>;
}

export interface SourceSessionOwnerOptions {
  readonly onAuthorizationLoss?: (target: FactoryRemoteTarget) => void;
  readonly observeControl?: (
    target: FactoryRemoteTarget,
    operation: FactoryControlOperation,
    signal: AbortSignal,
  ) => Promise<FactoryControlAdmission>;
  readonly isCurrent: () => boolean;
  readonly getEnvironments: (signal: AbortSignal) => Promise<ReadonlyArray<FactoryEnvironmentView>>;
  readonly openTransport: (
    environment: FactoryEnvironmentView,
    signal: AbortSignal,
  ) => Promise<SourceTransport>;
  readonly fetch?: typeof globalThis.fetch;
  readonly origin?: string;
}

let nextSourceSessionId = 0;

export class SourceSessionOwner {
  private readonly options: SourceSessionOwnerOptions;
  private readonly entries = new Map<string, SourceEntry>();
  private invalidated = false;

  constructor(options: SourceSessionOwnerOptions) {
    this.options = options;
  }

  async acquireSource(
    environmentId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SourceLease> {
    if (this.invalidated || !this.options.isCurrent()) {
      throw sourceError(
        "stale-attempt",
        "The factory connection changed before the source session opened.",
      );
    }
    if (options.signal?.aborted) throw options.signal.reason;
    let entry = this.entries.get(environmentId);
    if (entry === undefined) {
      entry = this.createEntry(environmentId);
      this.entries.set(environmentId, entry);
      entry.ready = this.openEntry(entry);
      void entry.ready.catch(() => {
        if (this.entries.get(environmentId) === entry) this.entries.delete(environmentId);
      });
    }
    const consumer: SourceConsumer = {
      id: Symbol(environmentId),
      requests: new Set(),
      streams: new Set(),
      released: false,
    };
    entry.consumers.set(consumer.id, consumer);
    const abort = () => this.releaseConsumer(entry!, consumer);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const transport = await this.waitForReady(entry, options.signal);
      options.signal?.removeEventListener("abort", abort);
      if (consumer.released || entry.invalidated || !this.options.isCurrent()) {
        this.releaseConsumer(entry, consumer);
        throw sourceError("stale-attempt", "The source session is no longer current.");
      }
      return this.makeLease(entry, consumer, transport);
    } catch (error) {
      if (isSourceAuthorizationError(error)) this.authorizationLost(entry);
      options.signal?.removeEventListener("abort", abort);
      this.releaseConsumer(entry, consumer);
      throw error;
    }
  }

  async invalidate(): Promise<void> {
    if (this.invalidated) return;
    this.invalidated = true;
    await Promise.all(
      [...this.entries.values()].map((entry) => this.closeEntry(entry, "stale-attempt")),
    );
  }

  revoke(target: FactoryRemoteTarget): void {
    const entry = this.entries.get(target.environmentId);
    if (
      entry === undefined ||
      (entry.target !== undefined && entry.target.registrationId !== target.registrationId)
    )
      return;
    void this.closeEntry(entry, "authorization");
  }

  async retrySource(environmentId: string): Promise<void> {
    const entry = this.entries.get(environmentId);
    if (entry !== undefined) await this.closeEntry(entry, "source-unavailable");
  }

  private authorizationLost(entry: SourceEntry): void {
    if (entry.invalidated || entry.target === undefined) return;
    void this.closeEntry(entry, "authorization");
    this.options.onAuthorizationLoss?.(entry.target);
  }

  private createEntry(environmentId: string): SourceEntry {
    return {
      sessionId: ++nextSourceSessionId,
      environmentId,
      controller: new AbortController(),
      consumers: new Map(),
      streams: new Map(),
      statusListeners: new Set(),
      httpEnabled: false,
      status: { phase: "connecting" },
      invalidated: false,
    };
  }

  private async openEntry(entry: SourceEntry): Promise<SourceTransport> {
    const environments = await this.options.getEnvironments(entry.controller.signal);
    if (entry.invalidated || !this.options.isCurrent())
      throw sourceError(
        entry.invalidatedReason ?? "stale-attempt",
        "The source session is no longer current.",
      );
    const matches = environments.filter(
      (environment) => environment.environmentId === entry.environmentId,
    );
    if (matches.length === 0)
      throw sourceError("environment-not-found", "This environment is no longer registered.");
    if (matches.length !== 1)
      throw sourceError(
        "ambiguous-environment",
        "This environment ID is not unique in the factory.",
      );
    const environment = matches[0]!;
    entry.target = {
      registrationId: environment.registrationId,
      environmentId: environment.environmentId,
    };
    if (environment.state === "blocked")
      throw sourceError("authorization", "Access to the source is blocked. Re-enroll it in Nodes.");
    if (
      !environment.enabled ||
      environment.state !== "online" ||
      environment.sourceAccess?.capabilities.websocket !== true
    ) {
      throw sourceError(
        "source-unavailable",
        "The source is not online or does not support WebSocket relay.",
      );
    }
    entry.httpEnabled = environment.sourceAccess.capabilities.http === true;
    const transport = await this.options.openTransport(environment, entry.controller.signal);
    if (transport.environmentId !== entry.environmentId) {
      await transport.close();
      throw sourceError(
        "identity-mismatch",
        "The relayed source identity does not match this environment.",
      );
    }
    if (entry.invalidated || !this.options.isCurrent() || entry.consumers.size === 0) {
      await transport.close();
      throw sourceError("stale-attempt", "The source session was closed before it became ready.");
    }
    entry.transport = transport;
    this.setStatus(entry, { phase: "online" });
    return transport;
  }

  private async waitForReady(entry: SourceEntry, signal?: AbortSignal): Promise<SourceTransport> {
    const ready = entry.ready;
    if (ready === undefined)
      throw sourceError("stale-attempt", "The source session did not start.");
    if (signal === undefined) return ready;
    if (signal.aborted) throw signal.reason;
    return new Promise<SourceTransport>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private makeLease(
    entry: SourceEntry,
    consumer: SourceConsumer,
    transport: SourceTransport,
  ): SourceLease {
    const manager = this;
    const ensureActive = () => {
      if (consumer.released)
        throw sourceError("lease-released", "The source session lease is no longer active.");
      if (entry.invalidated || !manager.options.isCurrent()) {
        const reason = entry.invalidatedReason ?? "stale-attempt";
        throw sourceError(reason, "The source session is no longer current.");
      }
    };
    const requestSignal = (signal?: AbortSignal) => {
      ensureActive();
      const controller = new AbortController();
      consumer.requests.add(controller);
      return {
        signal:
          signal === undefined
            ? AbortSignal.any([controller.signal, entry.controller.signal])
            : AbortSignal.any([signal, controller.signal, entry.controller.signal]),
        finish: () => {
          consumer.requests.delete(controller);
          controller.abort();
        },
      };
    };
    const lease: SourceLease = {
      registrationId: entry.target!.registrationId,
      client: transport.client,
      environmentId: entry.environmentId,
      sessionId: entry.sessionId,
      get status() {
        return entry.status;
      },
      subscribeStatus(listener) {
        entry.statusListeners.add(listener);
        listener(entry.status);
        return () => entry.statusListeners.delete(listener);
      },
      async observeControl(operation, signal) {
        const request = requestSignal(signal);
        try {
          if (!entry.target || !manager.options.observeControl)
            throw sourceError("authorization", "The factory control policy cannot be observed.");
          const admission = await manager.options.observeControl(
            entry.target,
            operation,
            request.signal,
          );
          ensureActive();
          return admission;
        } finally {
          request.finish();
        }
      },
      async request(operation, options = {}) {
        const request = requestSignal(options.signal);
        try {
          const value = await Effect.runPromise(operation(transport.client), {
            signal: request.signal,
          });
          ensureActive();
          return value;
        } catch (error) {
          if (isSourceAuthorizationError(error)) manager.authorizationLost(entry);
          throw error;
        } finally {
          request.finish();
        }
      },
      async readHttp<S extends Schema.ConstraintDecoder<unknown>>(
        path: string,
        schema: S,
        options: { readonly signal?: AbortSignal } = {},
      ): Promise<S["Type"]> {
        if (
          !entry.httpEnabled ||
          entry.transport?.httpPrefix === undefined ||
          entry.transport.httpPrefix === ""
        ) {
          throw sourceError("unsupported-http", "This source does not advertise HTTP relay.");
        }
        const request = requestSignal(options.signal);
        try {
          const url = resolveSourceHttpUrl(entry.transport.httpPrefix, path, {
            mode: "factory-relay",
            environmentId: entry.environmentId,
          });
          const parsed = new URL(url, sourceOrigin(manager.options.origin));
          if (
            parsed.searchParams.getAll("environmentId").length !== 1 ||
            parsed.searchParams.get("environmentId") !== entry.environmentId
          ) {
            throw sourceError(
              "invalid-route",
              "The source HTTP request has an invalid environment identity.",
            );
          }
          const response = await (manager.options.fetch ?? globalThis.fetch)(url, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            headers: { "x-t3-orchestration-protocol": "2" },
            signal: request.signal,
          });
          if (response.status === 401 || response.status === 403) {
            throw sourceError(
              "authorization",
              "The source denied this read. Check browser and source access.",
            );
          }
          if (!response.ok) {
            throw sourceError(
              "http-request",
              `The source read failed with HTTP ${response.status}.`,
            );
          }
          let body: unknown;
          try {
            body = await response.json();
          } catch (cause) {
            throw sourceError("invalid-data", "The source returned invalid JSON.", cause);
          }
          try {
            const decoded: S["Type"] = Schema.decodeUnknownSync(schema)(body);
            ensureActive();
            return decoded;
          } catch (cause) {
            if (cause instanceof SourceLeaseError) throw cause;
            throw sourceError(
              "invalid-data",
              "The source response does not match its contract.",
              cause,
            );
          }
        } catch (cause) {
          if (isSourceAuthorizationError(cause)) manager.authorizationLost(entry);
          if (cause instanceof SourceLeaseError) throw cause;
          if (cause instanceof SourceHttpUrlError)
            throw sourceError("invalid-route", cause.message, cause);
          throw cause;
        } finally {
          request.finish();
        }
      },
      resolveAssetUrl(path) {
        ensureActive();
        if (
          !entry.httpEnabled ||
          transport.httpPrefix === undefined ||
          transport.httpPrefix === ""
        ) {
          throw sourceError("unsupported-http", "This source does not advertise HTTP relay.");
        }
        try {
          return resolveSourceHttpUrl(transport.httpPrefix, path, {
            mode: "factory-relay",
            environmentId: entry.environmentId,
          });
        } catch (cause) {
          throw sourceError(
            "invalid-route",
            "The source asset is not available through the factory relay.",
            cause,
          );
        }
      },
      acquireStream<Event, StreamError = unknown>(
        key: string,
        subscribe: (client: SourceRpcClient) => Stream.Stream<Event, StreamError>,
        onEvent: (event: Event) => void,
        onError?: (error: StreamError) => void,
      ): SourceStreamLease {
        ensureActive();
        let stream = entry.streams.get(key);
        if (stream === undefined) {
          stream = { subscribe: (client) => subscribe(client), consumers: new Map() };
          entry.streams.set(key, stream);
        }
        const consumerId = Symbol(key);
        stream.consumers.set(consumerId, {
          owner: consumer.id,
          onEvent: (event) => onEvent(event as Event),
          ...(onError === undefined ? {} : { onError: (error) => onError(error as StreamError) }),
        });
        const release = () => {
          const current = entry.streams.get(key);
          if (current !== stream) return;
          current.consumers.delete(consumerId);
          if (current.consumers.size > 0) return;
          entry.streams.delete(key);
          current.controller?.abort();
          current.controller = undefined;
        };
        consumer.streams.add(release);
        if (entry.transport !== undefined) manager.startStream(entry, stream);
        return {
          release: () => {
            consumer.streams.delete(release);
            release();
          },
        };
      },
      release() {
        manager.releaseConsumer(entry, consumer);
      },
    };
    return lease;
  }

  private startStream(entry: SourceEntry, stream: SourceStreamEntry): void {
    if (
      stream.controller !== undefined ||
      entry.transport === undefined ||
      stream.consumers.size === 0
    )
      return;
    const controller = new AbortController();
    stream.controller = controller;
    const effect = Stream.runForEach(stream.subscribe(entry.transport.client), (event) =>
      Effect.sync(() => {
        if (!this.options.isCurrent() || entry.invalidated || stream.controller !== controller)
          return;
        for (const consumer of stream.consumers.values()) {
          if (!entry.consumers.get(consumer.owner)?.released) consumer.onEvent(event);
        }
      }),
    );
    void Effect.runPromise(
      Effect.provideService(effect, Scope.Scope, entry.transport.scope ?? Scope.makeUnsafe()),
      {
        signal: AbortSignal.any([controller.signal, entry.controller.signal]),
      },
    ).then(
      () => this.streamEnded(entry, stream, controller),
      (error) => this.streamFailed(entry, stream, controller, error),
    );
  }

  private streamEnded(
    entry: SourceEntry,
    stream: SourceStreamEntry,
    controller: AbortController,
  ): void {
    if (stream.controller !== controller) return;
    stream.controller = undefined;
    if (stream.consumers.size === 0) {
      for (const [key, value] of entry.streams) if (value === stream) entry.streams.delete(key);
    }
  }

  private streamFailed(
    entry: SourceEntry,
    stream: SourceStreamEntry,
    controller: AbortController,
    error: unknown,
  ): void {
    if (stream.controller !== controller || controller.signal.aborted || entry.invalidated) return;
    stream.controller = undefined;
    if (isSourceAuthorizationError(error)) {
      this.authorizationLost(entry);
      return;
    }
    this.setStatus(entry, { phase: "offline", error });
    for (const consumer of stream.consumers.values()) consumer.onError?.(error);
  }

  private releaseConsumer(entry: SourceEntry, consumer: SourceConsumer): void {
    if (consumer.released) return;
    consumer.released = true;
    entry.consumers.delete(consumer.id);
    for (const controller of consumer.requests)
      controller.abort(sourceError("lease-released", "The source lease was released."));
    consumer.requests.clear();
    for (const release of consumer.streams) release();
    consumer.streams.clear();
    if (entry.consumers.size === 0) void this.closeEntry(entry, "lease-released");
  }

  private async closeEntry(entry: SourceEntry, reason: SourceLeaseErrorReason): Promise<void> {
    if (entry.closePromise !== undefined) return entry.closePromise;
    entry.invalidated = true;
    entry.invalidatedReason = reason;
    entry.controller.abort(sourceError(reason, "The source session is no longer active."));
    this.setStatus(entry, {
      phase: reason === "authorization" ? "blocked" : "offline",
      error: sourceError(
        reason,
        reason === "authorization"
          ? "Access to the source is blocked. Re-enroll it in Nodes."
          : "The source read connection closed. Retry the source connection.",
      ),
    });
    for (const stream of entry.streams.values()) stream.controller?.abort();
    entry.streams.clear();
    for (const consumer of entry.consumers.values()) {
      for (const controller of consumer.requests)
        controller.abort(sourceError(reason, "The source session is no longer active."));
      consumer.requests.clear();
    }
    if (this.entries.get(entry.environmentId) === entry) this.entries.delete(entry.environmentId);
    const ready = entry.ready;
    entry.closePromise =
      ready === undefined
        ? Promise.resolve()
        : ready.then(
            (transport) => transport.close(),
            () => undefined,
          );
    return entry.closePromise;
  }

  private setStatus(entry: SourceEntry, status: SourceSessionStatus): void {
    entry.status = status;
    for (const listener of entry.statusListeners) listener(status);
  }
}
