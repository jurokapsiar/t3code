import {
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

export class SourceTransport extends Context.Service<
  SourceTransport,
  {
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
  readonly shell: Stream.Stream<OrchestrationV2ShellStreamItem, SourceFailure>;
  readonly closed: Effect.Effect<never, SourceFailure>;
  /** Commit only after the shell consumer has applied this source item. */
  readonly acknowledgeShell: (
    sequence: typeof NonNegativeInt.Type,
  ) => Effect.Effect<void, SourceFailure>;
}

export interface SourceState {
  readonly target: FactoryRemoteTarget;
  readonly phase: "connecting" | "online" | "offline" | "blocked" | "disabled";
  readonly reason: SourceFailure["reason"] | undefined;
  readonly config: ServerConfig | null;
  readonly cursor: typeof NonNegativeInt.Type | undefined;
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
  state: SourceState;
  fiber: Fiber.Fiber<void> | undefined;
  session: SourceSession | undefined;
  ended: Deferred.Deferred<never, SourceFailure> | undefined;
}

const isEnabled = (environment: FactoryEnvironmentView) =>
  environment.enabled && environment.state !== "pending" && environment.state !== "removing";
const sameReference = (a: Metadata.EnrollmentReference, b: Metadata.EnrollmentReference) =>
  a.environment.environmentId === b.environment.environmentId &&
  a.environment.endpoint === b.environment.endpoint &&
  isEnabled(a.environment) === isEnabled(b.environment) &&
  a.credentialStorage === b.credentialStorage &&
  a.credentialItemKey === b.credentialItemKey;

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
    let failures = 0;
    while (true) {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* setState(owner, "connecting");
          const reference = owner.reference;
          if (
            reference.environment.environmentId === localId ||
            [...owners.values()].some(
              (other) =>
                other !== owner &&
                isEnabled(other.reference.environment) &&
                other.reference.environment.environmentId === reference.environment.environmentId,
            )
          ) {
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
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              owner.session = undefined;
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
                  failures = 0;
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
      if (reason === "identity") owner.state = { ...owner.state, cursor: undefined, config: null };
      if (reason !== "transport") {
        yield* setState(owner, "blocked", reason);
        return;
      }
      failures++;
      const maximum = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 10));
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
      if (previous !== undefined && sameReference(previous.reference, reference) && wake !== id)
        continue;
      if (previous !== undefined) yield* stop(previous);
      const unchangedIdentity =
        previous?.reference.environment.environmentId === reference.environment.environmentId;
      const owner: Owner = {
        reference,
        state: {
          target: { registrationId: id, environmentId: reference.environment.environmentId },
          phase: "disabled",
          reason: undefined,
          config: unchangedIdentity ? previous.state.config : null,
          cursor: unchangedIdentity ? previous.state.cursor : undefined,
        },
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
      if (
        reference === undefined ||
        !isEnabled(reference) ||
        owner === undefined ||
        owner.reference.environment.endpoint !== reference.endpoint ||
        session === undefined ||
        config == null ||
        ended === undefined ||
        owner.state.phase !== "online"
      )
        return yield* new SourceFailure({ reason: "unavailable" });
      const checkCurrent = Effect.suspend(() =>
        owner.session === session &&
        owners.get(target.registrationId) === owner &&
        owner.state.phase === "online"
          ? Effect.void
          : Effect.fail(new SourceFailure({ reason: "unavailable" })),
      );
      const closed = Deferred.await(ended);
      const shell = Stream.unwrap(
        checkCurrent.pipe(
          Effect.as(
            session
              .shell({
                ...(owner.state.cursor === undefined ? {} : { afterSequence: owner.state.cursor }),
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
        shell,
        closed,
        acknowledgeShell: (sequence) =>
          checkCurrent.pipe(
            Effect.andThen(
              Effect.sync(() => {
                owner.state = { ...owner.state, cursor: sequence };
              }),
            ),
          ),
      } satisfies SourceAccess;
    });

  return Connections.of({
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
