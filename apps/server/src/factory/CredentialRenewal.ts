import {
  AuthAccessWriteScope,
  FactoryError,
  FactoryRegistrationId,
  type FactoryRenewalState,
} from "@t3tools/contracts";
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
  const source = yield* Enrollment.SourceCredentialExchange;
  const schedules = yield* Ref.make(new Map<FactoryRegistrationId, ScheduleEntry>());
  const retries = yield* Ref.make(new Map<FactoryRegistrationId, RetryEntry>());
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

  const clearRetry = (registrationId: FactoryRegistrationId) =>
    Ref.update(retries, (current) => {
      const next = new Map(current);
      next.delete(registrationId);
      return next;
    });

  const retryAt = (registrationId: FactoryRegistrationId) =>
    Ref.get(retries).pipe(Effect.map((current) => current.get(registrationId)?.retryAtMs ?? 0));

  const recordFailure = (
    registrationId: FactoryRegistrationId,
    nowMs: number,
    expiresAt: DateTime.DateTime,
  ) =>
    Ref.update(retries, (current) => {
      const previous = current.get(registrationId);
      const attempt = (previous?.attempt ?? 0) + 1;
      const delay = Math.min(retryMaximumMs, retryBaseMs * 2 ** Math.min(attempt - 1, 10));
      const next = new Map(current);
      next.set(registrationId, { attempt, retryAtMs: nowMs + delay });
      return next;
    }).pipe(Effect.andThen(updateStatus(registrationId, "failed", expiresAt)));

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

  const withoutCleanup = (credential: CredentialStore.StoredCredential) =>
    ({
      token: credential.token,
      sourceSessionId: credential.sourceSessionId,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
      scopes: credential.scopes,
      ...(credential.renewalSupported === undefined
        ? {}
        : { renewalSupported: credential.renewalSupported }),
    }) satisfies CredentialStore.StoredCredential;

  const cleanupPredecessor = (input: {
    readonly registrationId: FactoryRegistrationId;
    readonly endpoint: string;
    readonly itemKey: string;
    readonly credential: CredentialStore.StoredCredential;
    readonly nowMs: number;
  }) =>
    Effect.gen(function* () {
      const predecessorId = input.credential.predecessorCleanupId;
      if (predecessorId === undefined) {
        yield* updateStatus(input.registrationId, "failed", input.credential.expiresAt);
        return;
      }
      if (!input.credential.scopes.includes(AuthAccessWriteScope)) {
        yield* updateStatus(input.registrationId, "failed", input.credential.expiresAt);
        return;
      }
      if ((yield* retryAt(input.registrationId)) > input.nowMs) {
        yield* updateStatus(input.registrationId, "failed", input.credential.expiresAt);
        return;
      }
      const revoked = yield* source
        .revoke({
          endpoint: input.endpoint,
          credential: input.credential.token,
          sessionId: predecessorId,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("SourceCredentialExchangeError", () => Effect.succeed(false)),
        );
      if (!revoked) {
        yield* recordFailure(input.registrationId, input.nowMs, input.credential.expiresAt);
        return;
      }
      const cleanCredential = withoutCleanup(input.credential);
      const saved = yield* credentials.set(input.itemKey, cleanCredential).pipe(
        Effect.as(true),
        Effect.catchTag("CredentialStoreError", () => Effect.succeed(false)),
      );
      if (!saved) {
        yield* recordFailure(input.registrationId, input.nowMs, input.credential.expiresAt);
        return;
      }
      yield* clearRetry(input.registrationId);
      yield* updateStatus(input.registrationId, "ready", input.credential.expiresAt);
    });

  const renewCredential = (input: {
    readonly registrationId: FactoryRegistrationId;
    readonly endpoint: string;
    readonly itemKey: string;
    readonly credential: CredentialStore.StoredCredential;
    readonly nowMs: number;
  }) =>
    Effect.gen(function* () {
      if ((yield* retryAt(input.registrationId)) > input.nowMs) {
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
        yield* recordFailure(input.registrationId, input.nowMs, input.credential.expiresAt);
        return;
      }
      const nextCredential = replacement.value;
      if (
        nextCredential.scopes.length === 0 ||
        nextCredential.scopes.some((scope) => !input.credential.scopes.includes(scope))
      ) {
        yield* recordFailure(input.registrationId, input.nowMs, input.credential.expiresAt);
        return;
      }
      const cleanupPermitted =
        input.credential.scopes.includes(AuthAccessWriteScope) &&
        nextCredential.scopes.includes(AuthAccessWriteScope);
      const storedReplacement: CredentialStore.StoredCredential = {
        ...nextCredential,
        renewalSupported: true,
        predecessorCleanupPending: true,
        ...(cleanupPermitted ? { predecessorCleanupId: input.credential.sourceSessionId } : {}),
      };
      const saved = yield* credentials.set(input.itemKey, storedReplacement).pipe(
        Effect.as(true),
        Effect.catchTag("CredentialStoreError", () => Effect.succeed(false)),
      );
      if (!saved) {
        yield* recordFailure(input.registrationId, input.nowMs, input.credential.expiresAt);
        return;
      }
      yield* clearSchedule(input.registrationId);
      yield* clearRetry(input.registrationId);
      yield* PubSub.publish(renewed, input.registrationId);
      yield* updateStatus(
        input.registrationId,
        cleanupPermitted ? "ready" : "failed",
        nextCredential.expiresAt,
      );
      if (!cleanupPermitted) return;
      yield* cleanupPredecessor({
        registrationId: input.registrationId,
        endpoint: input.endpoint,
        itemKey: input.itemKey,
        credential: storedReplacement,
        nowMs: input.nowMs,
      });
    });

  const processReference = (reference: Metadata.EnrollmentReference, nowMs: number) =>
    Effect.gen(function* () {
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
        Effect.catchTag("CredentialStoreError", () => Effect.succeed({ kind: "failed" as const })),
      );
      if (stored.kind === "failed") {
        yield* updateStatus(environment.registrationId, "failed");
        return;
      }
      if (Option.isNone(stored.value)) {
        yield* updateStatus(environment.registrationId, "expired");
        return;
      }
      const credential = stored.value.value;
      const expiresAtMs = DateTime.toEpochMillis(credential.expiresAt);
      if (expiresAtMs <= nowMs) {
        yield* clearSchedule(environment.registrationId);
        yield* clearRetry(environment.registrationId);
        yield* updateStatus(environment.registrationId, "expired", credential.expiresAt);
        return;
      }
      const cleanupPending =
        credential.predecessorCleanupPending === true ||
        credential.predecessorCleanupId !== undefined;
      const cleanupRetryPermitted =
        credential.predecessorCleanupId !== undefined &&
        credential.scopes.includes(AuthAccessWriteScope);
      if (cleanupRetryPermitted) {
        yield* cleanupPredecessor({
          registrationId: environment.registrationId,
          endpoint: environment.endpoint,
          itemKey: credentialItemKey,
          credential,
          nowMs,
        });
        return;
      }
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
        yield* updateStatus(
          environment.registrationId,
          cleanupPending ? "failed" : "ready",
          credential.expiresAt,
        );
        return;
      }
      yield* updateStatus(
        environment.registrationId,
        cleanupPending ? "failed" : "due",
        credential.expiresAt,
      );
      yield* renewCredential({
        registrationId: environment.registrationId,
        endpoint: environment.endpoint,
        itemKey: credentialItemKey,
        credential,
        nowMs,
      });
    });

  const runOnce = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const references = yield* metadata.listEnrollmentReferences;
    yield* Effect.forEach(references, (reference) => processReference(reference, nowMs), {
      concurrency: 1,
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
