import { FactoryError, FactoryRegistrationId, type FactoryRenewalState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as CredentialMutations from "./CredentialMutations.ts";
import * as Enrollment from "./Enrollment.ts";
import * as Metadata from "./Metadata.ts";

const renewalCheckInterval = "1 minute";
const retryBaseMs = 30 * 1000;
const retryMaximumMs = 15 * 60 * 1000;
const maximumJitterRatio = 0.05;

export const renewalDueAt = (input: {
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly jitterMs: number;
}) => {
  const midpoint = input.issuedAtMs + (input.expiresAtMs - input.issuedAtMs) / 2;
  return Math.max(input.issuedAtMs, Math.min(input.expiresAtMs, midpoint + input.jitterMs));
};

interface ScheduleEntry {
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly dueAtMs: number;
}

interface RetryEntry {
  readonly attempt: number;
  readonly retryAtMs: number;
}

export class CredentialRenewal extends Context.Service<
  CredentialRenewal,
  {
    readonly runOnce: Effect.Effect<void, FactoryError>;
    readonly start: Effect.Effect<void, FactoryError, Scope.Scope>;
    readonly subscribeRenewals: Stream.Stream<FactoryRegistrationId>;
  }
>()("t3/factory/CredentialRenewal") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const metadata = yield* Metadata.Metadata;
  const credentials = yield* CredentialStore.CredentialStore;
  const mutations = yield* CredentialMutations.CredentialMutations;
  const source = yield* Enrollment.SourceCredentialExchange;
  const schedules = yield* Ref.make(new Map<FactoryRegistrationId, ScheduleEntry>());
  const renewalRetries = yield* Ref.make(new Map<FactoryRegistrationId, RetryEntry>());
  const cleanupRetries = yield* Ref.make(new Map<FactoryRegistrationId, RetryEntry>());
  const started = yield* Ref.make(false);
  const renewed = yield* PubSub.unbounded<FactoryRegistrationId>();
  const selectedStorage = config.factoryCredentialStore ?? "secure-vault";

  const updateStatus = (
    registrationId: FactoryRegistrationId,
    status: FactoryRenewalState,
    expiresAt?: DateTime.DateTime,
  ) => metadata.setRenewalStatus(registrationId, status, expiresAt).pipe(Effect.asVoid);

  const clearSchedule = (registrationId: FactoryRegistrationId) =>
    Ref.update(schedules, (current) => {
      const next = new Map(current);
      next.delete(registrationId);
      return next;
    });

  const retryAt = (
    retries: Ref.Ref<Map<FactoryRegistrationId, RetryEntry>>,
    registrationId: FactoryRegistrationId,
  ) => Ref.get(retries).pipe(Effect.map((current) => current.get(registrationId)?.retryAtMs ?? 0));

  const recordRetry = (
    retries: Ref.Ref<Map<FactoryRegistrationId, RetryEntry>>,
    registrationId: FactoryRegistrationId,
    nowMs: number,
  ) =>
    Ref.update(retries, (current) => {
      const previous = current.get(registrationId);
      const attempt = (previous?.attempt ?? 0) + 1;
      const delay = Math.min(retryMaximumMs, retryBaseMs * 2 ** Math.min(attempt - 1, 10));
      return new Map(current).set(registrationId, { attempt, retryAtMs: nowMs + delay });
    });

  const clearRetry = (
    retries: Ref.Ref<Map<FactoryRegistrationId, RetryEntry>>,
    registrationId: FactoryRegistrationId,
  ) =>
    Ref.update(retries, (current) => {
      const next = new Map(current);
      next.delete(registrationId);
      return next;
    });

  const getSchedule = (input: {
    readonly registrationId: FactoryRegistrationId;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
  }) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(schedules);
      const existing = current.get(input.registrationId);
      if (
        existing !== undefined &&
        existing.issuedAtMs === input.issuedAtMs &&
        existing.expiresAtMs === input.expiresAtMs
      ) {
        return existing;
      }
      const lifetime = input.expiresAtMs - input.issuedAtMs;
      const jitterRange = Math.max(0, Math.floor(lifetime * maximumJitterRatio));
      const jitterMs =
        jitterRange === 0 ? 0 : yield* Random.nextIntBetween(-jitterRange, jitterRange);
      const schedule = {
        ...input,
        dueAtMs: renewalDueAt({ ...input, jitterMs }),
      } satisfies ScheduleEntry;
      yield* Ref.update(schedules, (value) => new Map(value).set(input.registrationId, schedule));
      return schedule;
    });

  const storeCredential = (itemKey: string, credential: CredentialStore.StoredCredential) =>
    credentials.set(itemKey, credential).pipe(
      Effect.uninterruptible,
      Effect.as(true),
      Effect.catchTag("CredentialStoreError", (error) =>
        Effect.logWarning("Factory credential storage failed; retaining the previous credential.", {
          operation: error.operation,
        }).pipe(Effect.as(false)),
      ),
    );

  const retryPendingReleases = (input: {
    readonly registrationId: FactoryRegistrationId;
    readonly endpoint: string;
    readonly itemKey: string;
    readonly credential: CredentialStore.StoredCredential;
    readonly nowMs: number;
  }) =>
    Effect.gen(function* () {
      let credential = input.credential;
      let pending = [...(credential.pendingReleases ?? [])];
      if (
        pending.length === 0 ||
        (yield* retryAt(cleanupRetries, input.registrationId)) > input.nowMs
      ) {
        return credential;
      }

      while (pending.length > 0) {
        const proof = pending[0]!;
        const released = yield* source
          .release({ endpoint: input.endpoint, credential: proof.token })
          .pipe(
            Effect.as(true),
            Effect.catchTag("SourceCredentialExchangeError", (error) =>
              Effect.logWarning(
                "Factory predecessor release failed; preserving its protected retry proof.",
                {
                  registrationId: input.registrationId,
                  operation: error.operation,
                },
              ).pipe(Effect.as(false)),
            ),
          );
        if (!released) {
          yield* recordRetry(cleanupRetries, input.registrationId, input.nowMs);
          return credential;
        }

        pending = pending.slice(1);
        const updated: CredentialStore.StoredCredential = {
          token: credential.token,
          sourceSessionId: credential.sourceSessionId,
          issuedAt: credential.issuedAt,
          expiresAt: credential.expiresAt,
          scopes: credential.scopes,
          ...(credential.renewalSupported === undefined
            ? {}
            : { renewalSupported: credential.renewalSupported }),
          ...(pending.length === 0 ? {} : { pendingReleases: pending }),
        };
        const saved = yield* storeCredential(input.itemKey, updated);
        if (!saved) {
          yield* recordRetry(cleanupRetries, input.registrationId, input.nowMs);
          return credential;
        }
        credential = updated;
      }
      yield* clearRetry(cleanupRetries, input.registrationId);
      return credential;
    });

  const renewCredential = (input: {
    readonly registrationId: FactoryRegistrationId;
    readonly endpoint: string;
    readonly itemKey: string;
    readonly credential: CredentialStore.StoredCredential;
    readonly nowMs: number;
  }) =>
    Effect.gen(function* () {
      if ((yield* retryAt(renewalRetries, input.registrationId)) > input.nowMs) {
        yield* updateStatus(input.registrationId, "failed", input.credential.expiresAt);
        return;
      }
      const replacement = yield* source
        .renew({ endpoint: input.endpoint, credential: input.credential })
        .pipe(
          Effect.asSome,
          Effect.catchTag("SourceCredentialExchangeError", () => Effect.succeedNone),
        );
      if (Option.isNone(replacement)) {
        yield* recordRetry(renewalRetries, input.registrationId, input.nowMs);
        yield* updateStatus(input.registrationId, "failed", input.credential.expiresAt);
        return;
      }
      const nextCredential = replacement.value;
      if (
        nextCredential.scopes.length === 0 ||
        nextCredential.scopes.some((scope) => !input.credential.scopes.includes(scope))
      ) {
        yield* recordRetry(renewalRetries, input.registrationId, input.nowMs);
        yield* updateStatus(input.registrationId, "failed", input.credential.expiresAt);
        return;
      }
      const pendingReleases = [
        ...(input.credential.pendingReleases ?? []),
        {
          token: nextCredential.token,
          sourceSessionId: nextCredential.sourceSessionId,
          predecessorCleanupId: input.credential.sourceSessionId,
        },
      ];
      const storedReplacement: CredentialStore.StoredCredential = {
        token: nextCredential.token,
        sourceSessionId: nextCredential.sourceSessionId,
        issuedAt: nextCredential.issuedAt,
        expiresAt: nextCredential.expiresAt,
        scopes: nextCredential.scopes,
        renewalSupported: true,
        pendingReleases,
      };
      const saved = yield* storeCredential(input.itemKey, storedReplacement);
      if (!saved) {
        yield* recordRetry(renewalRetries, input.registrationId, input.nowMs);
        yield* updateStatus(input.registrationId, "failed", input.credential.expiresAt);
        return;
      }
      yield* clearSchedule(input.registrationId);
      yield* clearRetry(renewalRetries, input.registrationId);
      yield* PubSub.publish(renewed, input.registrationId);
      yield* updateStatus(input.registrationId, "ready", nextCredential.expiresAt);
      yield* retryPendingReleases({ ...input, credential: storedReplacement });
    });

  const processReference = (observed: Metadata.EnrollmentReference) =>
    mutations.withLock(
      observed.environment.registrationId,
      Effect.gen(function* () {
        const reference = yield* metadata.getEnrollmentReference(
          observed.environment.registrationId,
        );
        if (reference === undefined) return;
        const nowMs = yield* Clock.currentTimeMillis;
        const { environment, credentialStorage, credentialItemKey } = reference;
        if (
          !environment.enabled ||
          environment.state === "pending" ||
          environment.state === "removing"
        ) {
          return;
        }
        if (credentialStorage !== selectedStorage || credentialItemKey === null) {
          yield* updateStatus(environment.registrationId, "failed");
          return;
        }
        const stored = yield* credentials.get(credentialItemKey).pipe(
          Effect.map((value) => ({ kind: "found" as const, value })),
          Effect.catchTag("CredentialStoreError", () =>
            Effect.succeed({ kind: "failed" as const }),
          ),
        );
        if (stored.kind === "failed") {
          yield* updateStatus(environment.registrationId, "failed");
          return;
        }
        if (Option.isNone(stored.value)) {
          yield* updateStatus(environment.registrationId, "expired");
          return;
        }
        let credential = stored.value.value;
        const expiresAtMs = DateTime.toEpochMillis(credential.expiresAt);
        if (expiresAtMs <= nowMs) {
          yield* clearSchedule(environment.registrationId);
          yield* clearRetry(renewalRetries, environment.registrationId);
          yield* updateStatus(environment.registrationId, "expired", credential.expiresAt);
          return;
        }

        credential = yield* retryPendingReleases({
          registrationId: environment.registrationId,
          endpoint: environment.endpoint,
          itemKey: credentialItemKey,
          credential,
          nowMs,
        });
        if (credential.renewalSupported !== true) {
          yield* updateStatus(environment.registrationId, "unsupported", credential.expiresAt);
          return;
        }
        const schedule = yield* getSchedule({
          registrationId: environment.registrationId,
          issuedAtMs: DateTime.toEpochMillis(credential.issuedAt),
          expiresAtMs,
        });
        if (schedule.dueAtMs > nowMs) {
          yield* updateStatus(environment.registrationId, "ready", credential.expiresAt);
          return;
        }
        yield* updateStatus(environment.registrationId, "due", credential.expiresAt);
        yield* renewCredential({
          registrationId: environment.registrationId,
          endpoint: environment.endpoint,
          itemKey: credentialItemKey,
          credential,
          nowMs,
        });
      }),
    );

  const runOnce = Effect.gen(function* () {
    const references = yield* metadata.listEnrollmentReferences;
    yield* Effect.forEach(references, processReference, {
      concurrency: 8,
    });
  });

  const scanUntilInterrupted = Effect.forever(
    Effect.sleep(renewalCheckInterval).pipe(
      Effect.andThen(runOnce),
      Effect.catch((error) =>
        Effect.logWarning("Factory credential renewal scan failed.", {
          error: error._tag,
        }),
      ),
    ),
  );

  const start = Effect.gen(function* () {
    if (yield* Ref.get(started)) return;
    yield* Ref.set(started, true);
    yield* runOnce;
    yield* Effect.forkScoped(scanUntilInterrupted);
  });

  return CredentialRenewal.of({
    runOnce,
    start,
    subscribeRenewals: Stream.fromPubSub(renewed),
  });
});

export const layer = Layer.effect(CredentialRenewal, make);
