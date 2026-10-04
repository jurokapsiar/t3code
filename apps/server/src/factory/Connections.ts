import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  type AuthEnvironmentScope,
  FactoryError,
  FactoryRegistrationId,
  FactoryRemoteTarget,
  FactoryEnvironmentView,
  NonNegativeInt,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2SubscribeShellInput,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CredentialStore from "./CredentialStore.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as CredentialRenewal from "./CredentialRenewal.ts";
import * as Enrollment from "./Enrollment.ts";
import * as Metadata from "./Metadata.ts";
import type * as Socket from "effect/unstable/socket/Socket";

export class SourceFailure extends Schema.TaggedError<SourceFailure>()("SourceFailure", {
  reason: Schema.Literals([
    "transport",
    "authentication",
    "credential-store",
    "identity",
    "protocol",
    "unavailable",
  ]),
}) {
  override get message(): string {
    return `The source connection failed: ${this.reason}.`;
  }
}

export interface SourceSession {
  readonly configs: Stream.Stream<ServerConfigStreamEvent, SourceFailure>;
  readonly shell: (
    input: OrchestrationV2SubscribeShellInput,
  ) => Stream.Stream<OrchestrationV2ShellStreamItem, SourceFailure>;
  readonly closed: Effect.Effect<never, SourceFailure>;
}

export interface SourceHttpClient {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, SourceFailure, Scope.Scope>;
}

export class SourceTransport extends Context.Service<
  SourceTransport,
  {
    readonly connectHttp?: (input: {
      readonly environment: FactoryEnvironmentView;
      readonly credential: CredentialStore.StoredCredential;
    }) => Effect.Effect<SourceHttpClient, SourceFailure, Scope.Scope>;
    readonly connectRelay?: (input: {
      readonly environment: FactoryEnvironmentView;
      readonly credential: CredentialStore.StoredCredential;
    }) => Effect.Effect<Socket.Socket, SourceFailure, Scope.Scope>;
    readonly connect: (input: {
      readonly environment: FactoryEnvironmentView;
      readonly credential: CredentialStore.StoredCredential;
    }) => Effect.Effect<SourceSession, SourceFailure, Scope.Scope>;
  }
>()("t3/factory/Connections/SourceTransport") {}

export interface SourceAccess {
  /** Stable for this session; changes when the supervisor replaces it. */
  readonly connectionId: object;
  readonly target: FactoryRemoteTarget;
  readonly config: ServerConfig;
  /** Grants of the credential used by this connection. Never part of a wire view. */
  readonly sourceScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly checkCurrent: Effect.Effect<void, SourceFailure>;
  /** Resume belongs to the retained projection, never the connection owner. */
  readonly shell: (
    afterSequence?: typeof NonNegativeInt.Type,
  ) => Stream.Stream<OrchestrationV2ShellStreamItem, SourceFailure>;
  readonly closed: Effect.Effect<never, SourceFailure>;
  /** Config refresh does not replace the shell lease. */
  readonly checkShellCurrent: Effect.Effect<void, SourceFailure>;
  /** Called only after the authoritative projection reaches its completion marker. */
  readonly shellSynchronized: Effect.Effect<void, SourceFailure>;
}

export interface SourceState {
  readonly target: FactoryRemoteTarget;
  readonly phase: "connecting" | "online" | "offline" | "blocked" | "disabled";
  readonly reason: SourceFailure["reason"] | undefined;
  readonly config: ServerConfig | null;
}

export class Connections extends Context.Service<
  Connections,
  {
    readonly start: Effect.Effect<void>;
    readonly updateEnvironment: Metadata.Metadata["Service"]["updateEnvironment"];
    readonly connect: (registrationId: FactoryRegistrationId) => Effect.Effect<void>;
    readonly retry: (registrationId: FactoryRegistrationId) => Effect.Effect<void, SourceFailure>;
    readonly disable: (registrationId: FactoryRegistrationId) => Effect.Effect<void, FactoryError>;
    readonly resolveTarget: (
      target: FactoryRemoteTarget,
    ) => Effect.Effect<SourceAccess, SourceFailure>;
    readonly openHttp: (
      access: SourceAccess,
    ) => Effect.Effect<SourceHttpClient, SourceFailure, Scope.Scope>;
    readonly openRelay: (
      access: SourceAccess,
    ) => Effect.Effect<Socket.Socket, SourceFailure, Scope.Scope>;
    readonly getStates: Effect.Effect<ReadonlyArray<SourceState>>;
    readonly subscribeStates: Stream.Stream<ReadonlyArray<SourceState>>;
  }
>()("t3/factory/Connections") {}

export const matchesSourceIdentity = (input: {
  readonly expected: string;
  readonly received: string;
}) => input.expected === input.received;

interface Owner {
  readonly reference: Metadata.EnrollmentReference;
  failures: number;
  state: SourceState;
  identityBlockers: ReadonlyArray<FactoryRegistrationId> | undefined;
  fiber: Fiber.Fiber<void> | undefined;
  session: SourceSession | undefined;
  authorization?: Pick<CredentialStore.StoredCredential, "scopes" | "expiresAt"> | undefined;
  ended: Deferred.Deferred<never, SourceFailure> | undefined;
  openHttp?: (() => Effect.Effect<SourceHttpClient, SourceFailure, Scope.Scope>) | undefined;
  openRelay?: (() => Effect.Effect<Socket.Socket, SourceFailure, Scope.Scope>) | undefined;
}

const isEnabled = (environment: FactoryEnvironmentView) =>
  environment.enabled && environment.state !== "pending" && environment.state !== "removing";
const sameReference = (a: Metadata.EnrollmentReference, b: Metadata.EnrollmentReference) =>
  a.environment.environmentId === b.environment.environmentId &&
  a.environment.endpoint === b.environment.endpoint &&
  isEnabled(a.environment) === isEnabled(b.environment) &&
  a.credentialStorage === b.credentialStorage &&
  a.credentialItemKey === b.credentialItemKey;
const identityBlockersFor = (
  reference: Metadata.EnrollmentReference,
  references: ReadonlyArray<Metadata.EnrollmentReference>,
) =>
  references
    .filter(
      (other) =>
        other.environment.registrationId !== reference.environment.registrationId &&
        isEnabled(other.environment) &&
        other.environment.environmentId === reference.environment.environmentId,
    )
    .map((other) => other.environment.registrationId)
    .sort();
const sameIdentityBlockers = (
  left: ReadonlyArray<FactoryRegistrationId>,
  right: ReadonlyArray<FactoryRegistrationId>,
) => left.length === right.length && left.every((id, index) => id === right[index]);

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const settings = yield* Config.ServerConfig;
  const identity = yield* Identity.ServerEnvironmentIdentity;
  const metadata = yield* Metadata.Metadata;
  const credentials = yield* CredentialStore.CredentialStore;
  const renewal = yield* CredentialRenewal.CredentialRenewal;
  const transport = yield* SourceTransport;
  const localId = yield* identity.getEnvironmentId;
  const owners = new Map<FactoryRegistrationId, Owner>();
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<ReadonlyArray<SourceState>>(64);
  let started = false;
  const getStates = Effect.sync(() => [...owners.values()].map((owner) => owner.state));
  const publish = getStates.pipe(
    Effect.flatMap((states) => PubSub.publish(changes, states)),
    Effect.asVoid,
  );

  const setState = Effect.fnUntraced(function* (
    owner: Owner,
    phase: SourceState["phase"],
    reason?: SourceFailure["reason"],
  ) {
    owner.state = { ...owner.state, phase, reason };
    const registrationId = owner.reference.environment.registrationId;
    if (
      phase === "online" ||
      phase === "offline" ||
      phase === "blocked" ||
      phase === "connecting"
    ) {
      yield* metadata
        .setConnectionState(registrationId, phase === "connecting" ? "offline" : phase)
        .pipe(
          Effect.catchTag("FactoryError", (error) =>
            error.code === "not-found" ? Effect.void : Effect.die(error),
          ),
        );
    }
    yield* publish;
  });

  const supervise = Effect.fnUntraced(function* (owner: Owner) {
    while (true) {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* setState(owner, "connecting");
          const reference = owner.reference;
          const blockers = identityBlockersFor(
            reference,
            [...owners.values()].map((other) => other.reference),
          );
          owner.identityBlockers = blockers;
          if (reference.environment.environmentId === localId || blockers.length > 0) {
            return yield* new SourceFailure({ reason: "identity" });
          }
          if (
            reference.credentialStorage !== (settings.factoryCredentialStore ?? "secure-vault") ||
            reference.credentialItemKey === null
          ) {
            return yield* new SourceFailure({ reason: "credential-store" });
          }
          const stored = yield* credentials
            .get(reference.credentialItemKey)
            .pipe(Effect.mapError(() => new SourceFailure({ reason: "credential-store" })));
          if (Option.isNone(stored))
            return yield* new SourceFailure({ reason: "credential-store" });
          const now = yield* DateTime.now;
          if (DateTime.toEpochMillis(stored.value.expiresAt) <= DateTime.toEpochMillis(now))
            return yield* new SourceFailure({ reason: "authentication" });
          const session = yield* transport
            .connect({ environment: reference.environment, credential: stored.value })
            .pipe(
              Effect.timeoutOrElse({
                duration:
                  DateTime.toEpochMillis(stored.value.expiresAt) - DateTime.toEpochMillis(now),
                orElse: () => Effect.fail(new SourceFailure({ reason: "authentication" })),
              }),
            );
          const ended = yield* Deferred.make<never, SourceFailure>();
          owner.ended = ended;
          const connectHttp = transport.connectHttp;
          owner.openHttp =
            connectHttp === undefined
              ? undefined
              : () => connectHttp({ environment: reference.environment, credential: stored.value });
          const connectRelay = transport.connectRelay;
          owner.openRelay =
            connectRelay === undefined
              ? undefined
              : () =>
                  connectRelay({ environment: reference.environment, credential: stored.value });
          owner.authorization = {
            scopes: Object.freeze([...stored.value.scopes]),
            expiresAt: stored.value.expiresAt,
          };
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              owner.session = undefined;
              owner.authorization = undefined;
              owner.openRelay = undefined;
              owner.openHttp = undefined;
              yield* Deferred.fail(ended, new SourceFailure({ reason: "unavailable" }));
            }),
          );
          const consumeConfig = session.configs.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type === "snapshot") {
                  const descriptor = event.config.environment;
                  if (
                    !matchesSourceIdentity({
                      expected: reference.environment.environmentId,
                      received: descriptor.environmentId,
                    }) ||
                    descriptor.environmentId === localId
                  ) {
                    return yield* new SourceFailure({ reason: "identity" });
                  }
                  if (
                    descriptor.orchestrationProtocolVersion !== undefined &&
                    descriptor.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION
                  ) {
                    return yield* new SourceFailure({ reason: "protocol" });
                  }
                  owner.state = { ...owner.state, config: event.config };
                  owner.session = session;
                  yield* setState(owner, "online");
                } else {
                  const current = owner.state.config;
                  if (current === null) return yield* new SourceFailure({ reason: "protocol" });
                  switch (event.type) {
                    case "keybindingsUpdated":
                      owner.state = {
                        ...owner.state,
                        config: {
                          ...current,
                          keybindings: event.payload.keybindings,
                          issues: event.payload.issues,
                        },
                      };
                      break;
                    case "providerStatuses":
                      owner.state = {
                        ...owner.state,
                        config: { ...current, providers: event.payload.providers },
                      };
                      break;
                    case "settingsUpdated":
                      owner.state = {
                        ...owner.state,
                        config: { ...current, settings: event.payload.settings },
                      };
                      break;
                    case "environmentThemesUpdated":
                      owner.state = {
                        ...owner.state,
                        config: { ...current, environmentThemes: event.payload.themes },
                      };
                      break;
                    case "usageLimitSourcesUpdated":
                      owner.state = {
                        ...owner.state,
                        config: { ...current, usageLimitSources: event.payload.sources },
                      };
                      break;
                  }
                  yield* publish;
                }
              }),
            ),
            Effect.andThen(Effect.fail(new SourceFailure({ reason: "transport" }))),
          );
          const connectedAt = yield* DateTime.now;
          const expired = Effect.sleep(
            Math.max(
              0,
              DateTime.toEpochMillis(stored.value.expiresAt) - DateTime.toEpochMillis(connectedAt),
            ),
          ).pipe(Effect.andThen(Effect.fail(new SourceFailure({ reason: "authentication" }))));
          return yield* Effect.raceFirst(
            consumeConfig,
            Effect.raceFirst(session.closed, Effect.raceFirst(Deferred.await(ended), expired)),
          );
        }),
      ).pipe(Effect.result);
      if (result._tag === "Success") return;
      const reason = result.failure.reason;
      if (reason === "identity") owner.state = { ...owner.state, config: null };
      if (reason !== "transport") {
        yield* setState(owner, "blocked", reason);
        return;
      }
      owner.failures++;
      const maximum = Math.min(30_000, 1000 * 2 ** Math.min(owner.failures - 1, 10));
      const delay = yield* Random.nextIntBetween(Math.floor(maximum / 2), maximum);
      yield* setState(owner, "offline", reason);
      yield* Effect.sleep(delay);
    }
  });

  const stop = Effect.fnUntraced(function* (owner: Owner) {
    if (owner.fiber !== undefined) yield* Fiber.interrupt(owner.fiber);
    owner.fiber = undefined;
    owner.session = undefined;
  });

  const reconcile = Effect.fnUntraced(function* (wake?: FactoryRegistrationId) {
    if (!settings.factoryEnabled) return;
    const references = yield* metadata.listEnrollmentReferences;
    for (const [id, owner] of owners) {
      if (!references.some((reference) => reference.environment.registrationId === id)) {
        yield* stop(owner);
        owners.delete(id);
        yield* publish;
      }
    }
    for (const reference of references) {
      const id = reference.environment.registrationId;
      const previous = owners.get(id);
      const blockers = identityBlockersFor(reference, references);
      const identityBlockersChanged =
        previous?.state.phase === "blocked" &&
        previous.state.reason === "identity" &&
        previous.identityBlockers !== undefined &&
        !sameIdentityBlockers(previous.identityBlockers, blockers);
      if (
        previous !== undefined &&
        sameReference(previous.reference, reference) &&
        wake !== id &&
        !identityBlockersChanged
      )
        continue;
      if (previous !== undefined) yield* stop(previous);
      const unchangedIdentity =
        previous?.reference.environment.environmentId === reference.environment.environmentId;
      const owner: Owner = {
        reference,
        failures: 0,
        state: {
          target: { registrationId: id, environmentId: reference.environment.environmentId },
          phase: "disabled",
          reason: undefined,
          config: unchangedIdentity ? previous.state.config : null,
        },
        identityBlockers: undefined,
        fiber: undefined,
        session: undefined,
        ended: undefined,
      };
      owners.set(id, owner);
      if (isEnabled(reference.environment))
        owner.fiber = yield* supervise(owner).pipe(Effect.forkIn(scope));
      else yield* publish;
    }
  });
  const connect = (registrationId: FactoryRegistrationId) =>
    lock.withPermits(1)(reconcile(registrationId));
  const retry = (registrationId: FactoryRegistrationId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const reference = (yield* metadata.listEnrollmentReferences).find(
          (entry) => entry.environment.registrationId === registrationId,
        );
        if (
          !settings.factoryEnabled ||
          reference === undefined ||
          !isEnabled(reference.environment)
        )
          return yield* new SourceFailure({ reason: "unavailable" });
        yield* reconcile(registrationId);
      }),
    );
  const disable = (registrationId: FactoryRegistrationId) =>
    Effect.gen(function* () {
      const environment = (yield* metadata.listEnvironments).find(
        (entry) => entry.registrationId === registrationId,
      );
      if (environment === undefined)
        return yield* new FactoryError({
          code: "not-found",
          message: "The source environment does not exist.",
        });
      yield* updateEnvironment({ registrationId, revision: environment.revision, enabled: false });
    });

  const updateEnvironment: Metadata.Metadata["Service"]["updateEnvironment"] = (input) =>
    metadata.updateEnvironment(input).pipe(Effect.tap(() => lock.withPermits(1)(reconcile())));

  const start = lock.withPermits(1)(
    Effect.gen(function* () {
      if (started || !settings.factoryEnabled) return;
      started = true;
      // PubSub acquisition runs before the first suspended take and before the scan.
      yield* metadata.subscribeChanges.pipe(
        Stream.runForEach(() => lock.withPermits(1)(reconcile())),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      yield* renewal.subscribeRenewals.pipe(
        Stream.runForEach((id) =>
          retry(id).pipe(
            Effect.catchTag("SourceFailure", (error) =>
              error.reason === "unavailable" ? Effect.void : Effect.die(error),
            ),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      yield* reconcile();
    }),
  );

  const resolveTarget = (target: FactoryRemoteTarget) =>
    Effect.gen(function* () {
      const reference = (yield* metadata.listEnvironments).find(
        (entry) => entry.registrationId === target.registrationId,
      );
      if (
        reference !== undefined &&
        !matchesSourceIdentity({
          expected: target.environmentId,
          received: reference.environmentId,
        })
      )
        return yield* new SourceFailure({ reason: "identity" });
      const owner = owners.get(target.registrationId);
      const session = owner?.session;
      const config = owner?.state.config;
      const ended = owner?.ended;
      const authorization = owner?.authorization;
      if (
        reference === undefined ||
        !isEnabled(reference) ||
        owner === undefined ||
        owner.reference.environment.endpoint !== reference.endpoint ||
        session === undefined ||
        config == null ||
        ended === undefined ||
        authorization === undefined ||
        owner.state.phase !== "online"
      )
        return yield* new SourceFailure({ reason: "unavailable" });
      const checkCurrent = Effect.gen(function* () {
        if (
          owner.session !== session ||
          owners.get(target.registrationId) !== owner ||
          owner.state.phase !== "online" ||
          (yield* Deferred.isDone(ended))
        )
          return yield* new SourceFailure({ reason: "unavailable" });
      });
      const closed = Deferred.await(ended);
      const shell = (afterSequence?: typeof NonNegativeInt.Type) =>
        Stream.unwrap(
          checkCurrent.pipe(
            Effect.as(
              session
                .shell({
                  ...(afterSequence === undefined ? {} : { afterSequence }),
                  ...(config.shellResumeCompletionMarker === true
                    ? { requestCompletionMarker: true }
                    : {}),
                  ...(config.environment.capabilities.batchedReplay === true
                    ? { batchedReplay: true }
                    : {}),
                })
                .pipe(
                  Stream.concat(Stream.fail(new SourceFailure({ reason: "transport" }))),
                  Stream.tapError((error) => Deferred.fail(ended, error)),
                ),
            ),
          ),
        ).pipe(
          Stream.merge(Stream.fromEffect(closed).pipe(Stream.drain), { haltStrategy: "either" }),
        );
      return {
        connectionId: session,
        target,
        config,
        sourceScopes: authorization.scopes,
        checkCurrent: Effect.gen(function* () {
          yield* checkCurrent;
          const now = yield* DateTime.now;
          if (DateTime.toEpochMillis(authorization.expiresAt) <= DateTime.toEpochMillis(now))
            return yield* new SourceFailure({ reason: "authentication" });
          const current = (yield* metadata.listEnvironments).find(
            (entry) => entry.registrationId === target.registrationId,
          );
          if (current !== undefined && current.environmentId !== target.environmentId)
            return yield* new SourceFailure({ reason: "identity" });
          if (
            current === undefined ||
            !isEnabled(current) ||
            current.endpoint !== reference.endpoint ||
            owner.state.config !== config
          )
            return yield* new SourceFailure({ reason: "unavailable" });
          yield* checkCurrent;
        }),
        shell,
        closed,
        checkShellCurrent: checkCurrent,
        shellSynchronized: checkCurrent.pipe(
          Effect.andThen(
            Effect.sync(() => {
              owner.failures = 0;
            }),
          ),
        ),
      } satisfies SourceAccess;
    });

  const openHttp = Effect.fnUntraced(function* (access: SourceAccess) {
    yield* access.checkCurrent;
    const owner = owners.get(access.target.registrationId);
    if (owner?.session !== access.connectionId || owner.openHttp === undefined)
      return yield* new SourceFailure({ reason: "unavailable" });
    const client = yield* owner.openHttp();
    yield* access.checkCurrent;
    return client;
  });

  const openRelay = Effect.fnUntraced(function* (access: SourceAccess) {
    yield* access.checkCurrent;
    const owner = owners.get(access.target.registrationId);
    if (owner?.session !== access.connectionId || owner.openRelay === undefined)
      return yield* new SourceFailure({ reason: "unavailable" });
    const socket = yield* owner.openRelay();
    yield* access.checkCurrent;
    return socket;
  });

  return Connections.of({
    openHttp,
    openRelay,
    start,
    connect,
    retry,
    disable,
    updateEnvironment,
    resolveTarget,
    getStates,
    subscribeStates: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* getStates;
        return Stream.concat(Stream.succeed(snapshot), Stream.fromSubscription(subscription));
      }),
    ),
  });
});

export const layer = Layer.effect(Connections, make);

export const registrationLifecycleLayer = Layer.effect(
  Enrollment.RegistrationLifecycle,
  Effect.gen(function* () {
    const connections = yield* Connections;
    return Enrollment.RegistrationLifecycle.of({
      enabled: (environment) => connections.connect(environment.registrationId),
      removing: (environment) => connections.connect(environment.registrationId),
    });
  }),
);
