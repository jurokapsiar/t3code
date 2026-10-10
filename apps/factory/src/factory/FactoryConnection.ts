import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Socket from "effect/unstable/socket/Socket";
import type {
  FactoryEnvironmentView,
  FactoryOverviewSnapshot,
  FactoryRemoteTarget,
} from "@t3tools/contracts/factory";
import { SourceActionRegistry } from "./actionPolicy";
import type {
  SourceLease,
  SourceSessionOwner,
  SourceTransport,
  SourceTransportOptions,
} from "./sourceSessions";
import type { FactoryTransport } from "./transport";
import { FactoryTransportError, makeFactoryTransport } from "./transport";

export interface SourceAccessEvent {
  readonly target: FactoryRemoteTarget;
  readonly state: "blocked" | "ready" | "retry";
}

export interface StreamLease {
  release(): void;
}

export type ConnectionReason =
  | "auth-required"
  | "transport"
  | "protocol-mismatch"
  | "permission"
  | "identity-mismatch"
  | "invalid-data"
  | "overview-too-large";

export interface ConnectionStatus {
  readonly phase:
    | "connecting"
    | "synchronizing"
    | "online"
    | "offline"
    | "unauthenticated"
    | "blocked";
  readonly reason: ConnectionReason | null;
}

export interface FactoryAuthSession {
  readonly authenticated: boolean;
}

export function statusFromAuthSession(session: FactoryAuthSession): ConnectionStatus {
  return session.authenticated
    ? { phase: "connecting", reason: null }
    : { phase: "unauthenticated", reason: "auth-required" };
}

export type FactoryRpcClient = FactoryTransport["factory"];

export interface FactoryConnectionTransport {
  readonly factory: FactoryRpcClient;
  readonly factoryId: string;
}

export interface FactoryConnectionOptions {
  readonly origin?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly webSocketConstructor?: Socket.WebSocketConstructor["Service"];
  readonly retryDelayMs?: number;
  readonly simulated?: boolean;
  readonly openTransport?: (scope: Scope.Closeable) => Promise<FactoryConnectionTransport>;
  readonly openSourceTransport?: (
    environment: FactoryEnvironmentView,
    signal: AbortSignal,
  ) => Promise<SourceTransport>;
}

export interface FactoryConnectionApi {
  readonly status: ConnectionStatus;
  readonly factoryId: string | undefined;
  readonly simulated: boolean;
  /** Native source commands owned by this connection. Kept across views, leases, and retries. */
  readonly actions: SourceActionRegistry;
  readonly subscribeStatus: (listener: (status: ConnectionStatus) => void) => () => void;
  start(): void;
  stop(): Promise<void>;
  retry(): void;
  acquireStream<Event, Error = unknown>(
    key: string,
    subscribe: (client: FactoryRpcClient) => Stream.Stream<Event, Error>,
    onEvent: (event: Event) => void,
  ): StreamLease;
  request<A, Error>(
    request: (client: FactoryRpcClient) => Effect.Effect<A, Error>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<A>;
  readonly subscribeSourceAccess: (listener: (event: SourceAccessEvent) => void) => () => void;
  isSourceBlocked(environmentId: string): boolean;
  updateSourceAccess(snapshot: FactoryOverviewSnapshot): void;
  retrySource(environmentId: string): Promise<void>;
  acquireSource(
    environmentId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SourceLease>;
}

interface ActiveAttempt extends FactoryConnectionTransport {
  readonly id: number;
  readonly scope: Scope.Closeable;
  sourceSessions?: SourceSessionOwner;
}

interface StreamEntry {
  readonly subscribe: (client: FactoryRpcClient) => Stream.Stream<unknown, unknown>;
  readonly consumers: Map<symbol, (event: unknown) => void>;
  attemptId?: number;
  controller?: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusForError(error: unknown): ConnectionStatus {
  if (error instanceof FactoryTransportError) {
    switch (error.reason) {
      case "unauthenticated":
        return statusFromAuthSession({ authenticated: false });
      case "factory-disabled":
      case "incompatible-protocol":
        return { phase: "blocked", reason: "protocol-mismatch" };
      case "invalid-auth-session":
      case "invalid-discovery":
        return { phase: "blocked", reason: "invalid-data" };
      case "auth-check-failed":
      case "discovery-failed":
        return { phase: "offline", reason: "transport" };
    }
  }
  if (isRecord(error) && error._tag === "EnvironmentAuthorizationError") {
    return { phase: "blocked", reason: "permission" };
  }
  if (isRecord(error) && error._tag === "FactoryError" && error.code === "overview-too-large") {
    return { phase: "blocked", reason: "overview-too-large" };
  }
  return { phase: "offline", reason: "transport" };
}

export class FactoryConnection implements FactoryConnectionApi {
  private currentStatus: ConnectionStatus = { phase: "connecting", reason: null };
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly streams = new Map<string, StreamEntry>();
  readonly actions = new SourceActionRegistry();
  readonly simulated: boolean;
  private readonly retryDelayMs: number;
  private readonly openTransport: (scope: Scope.Closeable) => Promise<FactoryConnectionTransport>;
  private readonly openSourceTransport: FactoryConnectionOptions["openSourceTransport"];
  private readonly sourceTransportOptions: SourceTransportOptions;
  private activeAttempt: ActiveAttempt | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attemptSequence = 0;
  private running = false;
  private accessFactoryId: string | undefined;
  private readonly sourceAccessListeners = new Set<(event: SourceAccessEvent) => void>();
  private readonly blockedSources = new Map<string, FactoryRemoteTarget>();
  private readonly sourceStates = new Map<string, string>();
  private readonly sourceTargets = new Map<string, FactoryRemoteTarget>();
  private readonly sourceReplacements = new Set<string>();
  private readonly sourceRetries = new Map<string, Promise<void>>();

  constructor(options: FactoryConnectionOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? 1500;
    this.simulated = options.simulated ?? false;
    this.openSourceTransport = options.openSourceTransport;
    this.sourceTransportOptions = {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.webSocketConstructor === undefined
        ? {}
        : { webSocketConstructor: options.webSocketConstructor }),
    };
    const {
      retryDelayMs: _retryDelayMs,
      simulated: _simulated,
      openTransport,
      openSourceTransport: _openSourceTransport,
      ...transportOptions
    } = options;
    this.openTransport =
      openTransport ??
      (async (scope) => {
        const transport = await Effect.runPromise(
          Effect.provideService(makeFactoryTransport(transportOptions), Scope.Scope, scope),
        );
        const factoryId = transport.serverConfig.environment.environmentId;
        return { factory: transport.factory, factoryId };
      });
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get factoryId(): string | undefined {
    return this.activeAttempt?.factoryId;
  }

  readonly subscribeStatus = (listener: (status: ConnectionStatus) => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.beginAttempt();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.attemptSequence += 1;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const attempt = this.activeAttempt;
    this.activeAttempt = undefined;
    this.detachStreams();
    this.setStatus({ phase: "offline", reason: null });
    this.actions.clear();
    this.blockedSources.clear();
    this.sourceStates.clear();
    this.sourceTargets.clear();
    this.sourceReplacements.clear();
    if (attempt !== undefined) {
      await Promise.all([attempt.sourceSessions?.invalidate(), this.closeScope(attempt.scope)]);
    }
  }

  retry(): void {
    this.running = true;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const id = ++this.attemptSequence;
    this.setStatus({ phase: "connecting", reason: null });
    const previous = this.activeAttempt;
    this.activeAttempt = undefined;
    this.detachStreams(previous?.id);
    if (previous === undefined) {
      this.connect(id);
      return;
    }
    void Promise.all([previous.sourceSessions?.invalidate(), this.closeScope(previous.scope)]).then(
      () => {
        if (this.isCurrent(id)) this.connect(id);
      },
      (error) => this.failAttempt(id, error),
    );
  }

  acquireStream<Event, Error = unknown>(
    key: string,
    subscribe: (client: FactoryRpcClient) => Stream.Stream<Event, Error>,
    onEvent: (event: Event) => void,
  ): StreamLease {
    let entry = this.streams.get(key);
    if (entry === undefined) {
      entry = {
        subscribe: (client) => subscribe(client),
        consumers: new Map(),
      };
      this.streams.set(key, entry);
    }
    const consumerId = Symbol(key);
    entry.consumers.set(consumerId, (event) => onEvent(event as Event));
    if (
      this.activeAttempt !== undefined &&
      (this.currentStatus.phase === "online" || this.currentStatus.phase === "synchronizing")
    )
      this.startStream(entry, this.activeAttempt);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = this.streams.get(key);
        if (current !== entry) return;
        current.consumers.delete(consumerId);
        if (current.consumers.size !== 0) return;
        this.streams.delete(key);
        current.controller?.abort();
        current.controller = undefined;
        current.attemptId = undefined;
      },
    };
  }

  request<A, Error>(
    request: (client: FactoryRpcClient) => Effect.Effect<A, Error>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<A> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const attempt = this.activeAttempt;
    if (attempt === undefined) return Promise.reject(new Error("Factory connection is not ready"));
    const operation = request(attempt.factory);
    return Effect.runPromise(
      operation,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  }

  readonly subscribeSourceAccess = (listener: (event: SourceAccessEvent) => void): (() => void) => {
    this.sourceAccessListeners.add(listener);
    return () => this.sourceAccessListeners.delete(listener);
  };

  isSourceBlocked(environmentId: string): boolean {
    const target = this.sourceTargets.get(environmentId);
    return (
      target !== undefined &&
      this.blockedSources.has(JSON.stringify([target.registrationId, environmentId]))
    );
  }

  updateSourceAccess(snapshot: FactoryOverviewSnapshot): void {
    this.observeSourceRegistrations(snapshot.environments);
    const blockedEnvironments = new Set(
      snapshot.environments
        .filter((environment) => environment.state === "blocked")
        .map((environment) => environment.environmentId),
    );
    for (const source of snapshot.sourceFreshness) {
      const registered = this.sourceTargets.get(source.target.environmentId);
      if (registered !== undefined && registered.registrationId !== source.target.registrationId)
        continue;
      this.sourceTargets.set(source.target.environmentId, source.target);
      const key = JSON.stringify([source.target.registrationId, source.target.environmentId]);
      const previous = this.sourceStates.get(key);
      const state = blockedEnvironments.has(source.target.environmentId) ? "blocked" : source.state;
      this.sourceStates.set(key, state);
      if (state === "blocked") this.blockSource(source.target);
      else if (state === "fresh" && previous !== "fresh") {
        const recovered = this.blockedSources.delete(key);
        const replaced = this.sourceReplacements.delete(key);
        if (recovered || replaced)
          this.publishSourceAccess({ target: source.target, state: "ready" });
      }
    }
    for (const environment of snapshot.environments) {
      if (environment.state === "blocked") {
        this.sourceStates.set(
          JSON.stringify([environment.registrationId, environment.environmentId]),
          "blocked",
        );
        this.blockSource(environment);
      }
    }
  }

  private observeSourceRegistrations(environments: ReadonlyArray<FactoryEnvironmentView>): void {
    for (const environment of environments) {
      const previous = this.sourceTargets.get(environment.environmentId);
      if (previous !== undefined && previous.registrationId !== environment.registrationId) {
        this.blockSource(previous);
        this.sourceReplacements.add(
          JSON.stringify([environment.registrationId, environment.environmentId]),
        );
      }
      this.sourceTargets.set(environment.environmentId, {
        registrationId: environment.registrationId,
        environmentId: environment.environmentId,
      });
    }
  }

  retrySource(environmentId: string): Promise<void> {
    const pending = this.sourceRetries.get(environmentId);
    if (pending !== undefined) return pending;
    const operation = this.reopenSource(environmentId).finally(() =>
      this.sourceRetries.delete(environmentId),
    );
    this.sourceRetries.set(environmentId, operation);
    return operation;
  }

  private async reopenSource(environmentId: string): Promise<void> {
    const attempt = this.activeAttempt;
    if (attempt === undefined || this.currentStatus.phase !== "online")
      throw new Error("The factory is not ready.");
    if (this.isSourceBlocked(environmentId))
      throw new Error("Access to the source is blocked. Re-enroll it in Nodes.");
    await attempt.sourceSessions?.retrySource(environmentId);
    if (this.activeAttempt !== attempt || !this.running) return;
    if (this.isSourceBlocked(environmentId))
      throw new Error("Access to the source is blocked. Re-enroll it in Nodes.");
    const target = this.sourceTargets.get(environmentId);
    if (target === undefined)
      throw new Error("The source is no longer registered. Re-select it from the overview.");
    this.publishSourceAccess({ target, state: "retry" });
  }

  private blockSource(target: FactoryRemoteTarget): void {
    const registered = this.sourceTargets.get(target.environmentId);
    if (registered !== undefined && registered.registrationId !== target.registrationId) return;
    this.sourceTargets.set(target.environmentId, target);
    const key = JSON.stringify([target.registrationId, target.environmentId]);
    this.blockedSources.set(key, target);
    this.activeAttempt?.sourceSessions?.revoke(target);
    this.publishSourceAccess({ target, state: "blocked" });
  }

  private publishSourceAccess(event: SourceAccessEvent): void {
    for (const listener of this.sourceAccessListeners) listener(event);
  }

  async acquireSource(
    environmentId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SourceLease> {
    const source = await import("./sourceSessions");
    if (this.isSourceBlocked(environmentId))
      throw new source.SourceLeaseError({
        reason: "authorization",
        message: "Access to the source is blocked. Re-enroll it in Nodes.",
      });
    const attempt = this.activeAttempt;
    if (attempt === undefined || !this.running || this.currentStatus.phase !== "online") {
      throw new source.SourceLeaseError({
        reason: "connection-not-ready",
        message: "The factory overview is not synchronized.",
      });
    }
    if (this.simulated && this.openSourceTransport === undefined) {
      throw new source.SourceLeaseError({
        reason: "unsupported-fixture",
        message: "Source detail is not available in the development fixture.",
      });
    }
    if (attempt.sourceSessions === undefined) {
      attempt.sourceSessions = new source.SourceSessionOwner({
        onAuthorizationLoss: (target) => this.blockSource(target),
        isCurrent: () => this.activeAttempt === attempt && this.running,
        observeControl: (target, operation, signal) =>
          this.request(
            (client) => client["factory.source.controlAuthorization"]({ target, operation }),
            { signal },
          ),
        getEnvironments: async (signal) => {
          const environments = await this.request(
            (client) => client["factory.environments.list"]({}),
            { signal },
          );
          if (this.activeAttempt === attempt && this.running)
            this.observeSourceRegistrations(environments);
          return environments;
        },
        openTransport: (environment, signal) =>
          this.openSourceTransport === undefined
            ? source.openSourceRelayTransport(environment, {
                ...this.sourceTransportOptions,
                signal,
              })
            : this.openSourceTransport(environment, signal),
        fetch: this.sourceTransportOptions.fetch,
        origin: this.sourceTransportOptions.origin,
      });
    }
    return attempt.sourceSessions.acquireSource(environmentId, options);
  }

  private beginAttempt(): void {
    const id = ++this.attemptSequence;
    this.setStatus({ phase: "connecting", reason: null });
    this.connect(id);
  }

  private async connect(id: number): Promise<void> {
    if (!this.isCurrent(id)) return;
    const scope = Scope.makeUnsafe();
    try {
      const transport = await this.openTransport(scope);
      if (!this.isCurrent(id)) {
        await this.closeScope(scope);
        return;
      }
      if (this.accessFactoryId !== transport.factoryId) {
        this.blockedSources.clear();
        this.sourceStates.clear();
        this.sourceTargets.clear();
        this.sourceReplacements.clear();
        this.accessFactoryId = transport.factoryId;
      }
      const attempt: ActiveAttempt = { ...transport, id, scope };
      this.activeAttempt = attempt;
      this.setStatus({ phase: "synchronizing", reason: null });
      for (const entry of this.streams.values()) this.startStream(entry, attempt);
    } catch (error) {
      try {
        await this.closeScope(scope);
      } catch (closeError) {
        this.failAttempt(id, closeError);
        return;
      }
      this.failAttempt(id, error);
    }
  }

  private startStream(entry: StreamEntry, attempt: ActiveAttempt): void {
    if (entry.attemptId === attempt.id || entry.consumers.size === 0) return;
    const controller = new AbortController();
    entry.attemptId = attempt.id;
    entry.controller = controller;
    try {
      const stream = entry.subscribe(attempt.factory);
      const consume = Stream.runForEach(stream, (event) =>
        Effect.sync(() => {
          if (this.activeAttempt !== attempt || entry.attemptId !== attempt.id) return;
          this.setStatus({ phase: "online", reason: null });
          for (const consumer of entry.consumers.values()) consumer(event);
        }),
      );
      const scoped = Effect.provideService(consume, Scope.Scope, attempt.scope);
      void Effect.runPromise(scoped, { signal: controller.signal })
        .then(
          () => this.streamEnded(entry, attempt, new Error("Factory stream ended")),
          (error) => this.streamEnded(entry, attempt, error),
        )
        .catch((error) => this.failAttempt(attempt.id, error));
    } catch (error) {
      void this.streamEnded(entry, attempt, error).catch((closeError) =>
        this.failAttempt(attempt.id, closeError),
      );
    }
  }

  private async streamEnded(
    entry: StreamEntry,
    attempt: ActiveAttempt,
    error: unknown,
  ): Promise<void> {
    if (this.activeAttempt !== attempt || entry.attemptId !== attempt.id) return;
    const status = statusForError(error);
    this.detachStreams(attempt.id);
    if (status.reason === "overview-too-large") {
      // Keep authenticated Factory RPCs, never source control, available for recovery.
      this.setStatus(status);
      await attempt.sourceSessions?.invalidate();
      return;
    }
    this.activeAttempt = undefined;
    this.setStatus(status);
    try {
      await Promise.all([attempt.sourceSessions?.invalidate(), this.closeScope(attempt.scope)]);
    } catch (closeError) {
      this.setStatus(statusForError(closeError));
    }
    if (status.phase === "offline") this.scheduleRetry();
  }

  private failAttempt(id: number, error: unknown): void {
    if (!this.isCurrent(id)) return;
    const status = statusForError(error);
    this.setStatus(status);
    if (status.phase === "offline") this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.running) return;
      this.beginAttempt();
    }, this.retryDelayMs);
  }

  private detachStreams(attemptId?: number): void {
    for (const entry of this.streams.values()) {
      if (attemptId !== undefined && entry.attemptId !== attemptId) continue;
      entry.attemptId = undefined;
      entry.controller?.abort();
      entry.controller = undefined;
    }
  }

  private async closeScope(scope: Scope.Closeable): Promise<void> {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  private isCurrent(id: number): boolean {
    return this.running && this.attemptSequence === id;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.currentStatus.phase === status.phase && this.currentStatus.reason === status.reason)
      return;
    this.currentStatus = status;
    // Losing factory authentication ends this owner's command authority, so its records end too.
    if (status.phase === "unauthenticated") this.actions.clear();
    for (const listener of this.statusListeners) listener(status);
  }
}
