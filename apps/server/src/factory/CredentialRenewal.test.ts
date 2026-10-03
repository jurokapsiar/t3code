import * as NodeBuffer from "node:buffer";

import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  AuthSessionId,
  EnvironmentId,
  FactoryEnvironmentView,
  FactoryRegistrationId,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as CredentialRenewal from "./CredentialRenewal.ts";
import * as Enrollment from "./Enrollment.ts";
import * as Metadata from "./Metadata.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const oldToken = "private-predecessor-token-test-value";
const newToken = "private-replacement-token-test-value";
const reference = "opaque-credential-reference";
const registrationId = FactoryRegistrationId.make("renewal-registration");
const oldSessionId = AuthSessionId.make("predecessor-session");
const decodeEnvironment = Schema.decodeSync(FactoryEnvironmentView);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it("schedules renewal halfway through a 30-day credential lifetime", () => {
  expect(
    CredentialRenewal.renewalDueAt({
      issuedAtMs: 0,
      expiresAtMs: 30 * DAY_MS,
      jitterMs: 0,
    }),
  ).toBe(15 * DAY_MS);
});

const makeHarness = (
  options: {
    readonly renewalSupported?: boolean;
    readonly scopes?: ReadonlyArray<"orchestration:read" | "access:write">;
    readonly issueFailure?: boolean;
    readonly issueFailureCount?: number;
    readonly issueLostResponseCount?: number;
    readonly storeFailure?: boolean;
    readonly revokeFailure?: boolean;
    readonly revokeFailureCount?: number;
    readonly revokeLostResponseCount?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const clock = yield* Clock.Clock;
    const random = yield* Random.Random;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-factory-renewal-",
    });
    const isolatedConfig = {
      ...config,
      stateDir: dataDirectory,
      dbPath: path.join(dataDirectory, "statev2.sqlite"),
      environmentIdPath: path.join(dataDirectory, "environment-id"),
      secretsDir: path.join(dataDirectory, "secrets"),
      factoryCredentialStore: "secure-vault" as const,
    };
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const calls: Array<string> = [];
    let storeWrites = 0;
    let issueFailuresRemaining = options.issueFailure
      ? Number.POSITIVE_INFINITY
      : (options.issueFailureCount ?? 0);
    let revokeFailuresRemaining = options.revokeFailure
      ? Number.POSITIVE_INFINITY
      : (options.revokeFailureCount ?? 0);
    let issueLostResponsesRemaining = options.issueLostResponseCount ?? 0;
    let revokeLostResponsesRemaining = options.revokeLostResponseCount ?? 0;
    const credentials = new Map<string, CredentialStore.StoredCredential>();
    const remoteSessions = new Map<string, { readonly token: string; revoked: boolean }>([
      [oldSessionId, { token: oldToken, revoked: false }],
    ]);
    const revokeResults: Array<boolean | "response-lost"> = [];
    const scopes = options.scopes ?? ["orchestration:read", "access:write"];
    const expiresAt = DateTime.makeUnsafe(30 * DAY_MS);
    const predecessor: CredentialStore.StoredCredential = {
      token: oldToken,
      sourceSessionId: oldSessionId,
      issuedAt: DateTime.makeUnsafe(0),
      expiresAt,
      scopes,
      renewalSupported: options.renewalSupported ?? true,
    };
    const store = CredentialStore.CredentialStore.of({
      get: (key) => Effect.succeed(Option.fromNullishOr(credentials.get(key))),
      set: (key, value) =>
        Effect.gen(function* () {
          calls.push("store");
          storeWrites += 1;
          if (options.storeFailure && storeWrites > 1) {
            return yield* new CredentialStore.CredentialStoreError({
              operation: "write",
              backend: "secure-vault",
            });
          }
          credentials.set(key, value);
        }),
      remove: (key) => Effect.sync(() => void credentials.delete(key)),
    });
    const source = Enrollment.SourceCredentialExchange.of({
      discover: () =>
        Effect.succeed({
          environmentId: EnvironmentId.make("source-environment"),
          platform: null,
        }),
      exchange: () => Effect.succeed(predecessor),
      renew: () =>
        Effect.gen(function* () {
          calls.push("issue");
          if (issueFailuresRemaining > 0) {
            issueFailuresRemaining -= 1;
            return yield* new Enrollment.SourceCredentialExchangeError({ operation: "renew" });
          }
          const now = yield* Clock.currentTimeMillis;
          const lostResponse = issueLostResponsesRemaining > 0;
          if (lostResponse) issueLostResponsesRemaining -= 1;
          const sessionId = AuthSessionId.make(
            lostResponse ? "orphan-replacement-session" : "replacement-session",
          );
          const token = lostResponse ? "orphan-replacement-token-test-value" : newToken;
          remoteSessions.set(sessionId, { token, revoked: false });
          if (lostResponse) {
            return yield* new Enrollment.SourceCredentialExchangeError({ operation: "renew" });
          }
          return {
            token,
            sourceSessionId: sessionId,
            issuedAt: DateTime.makeUnsafe(now),
            expiresAt: DateTime.makeUnsafe(now + 30 * DAY_MS),
            scopes,
            renewalSupported: true,
          } satisfies CredentialStore.StoredCredential;
        }),
      revoke: (input) =>
        Effect.gen(function* () {
          calls.push("revoke");
          const stored = credentials.get(reference);
          expect(stored?.token).toBe(newToken);
          expect(stored?.predecessorCleanupId).toBe(oldSessionId);
          if (revokeFailuresRemaining > 0) {
            revokeFailuresRemaining -= 1;
            return yield* new Enrollment.SourceCredentialExchangeError({ operation: "revoke" });
          }
          const predecessor = remoteSessions.get(input.sessionId)!;
          const revoked = !predecessor.revoked;
          if (revoked) predecessor.revoked = true;
          revokeResults.push(revokeLostResponsesRemaining > 0 ? "response-lost" : revoked);
          if (revokeLostResponsesRemaining > 0) {
            revokeLostResponsesRemaining -= 1;
            return yield* new Enrollment.SourceCredentialExchangeError({ operation: "revoke" });
          }
          return { revoked };
        }),
    });
    const infrastructureLayer = Layer.mergeAll(
      ServerConfig.layer(isolatedConfig),
      makeSqlitePersistenceLive(isolatedConfig.dbPath),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const dependenciesLayer = Layer.mergeAll(
      Metadata.layer,
      Layer.succeed(CredentialStore.CredentialStore, store),
      Layer.succeed(Enrollment.SourceCredentialExchange, source),
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(Random.Random, random),
    ).pipe(Layer.provideMerge(infrastructureLayer));
    const services = yield* Layer.buildWithScope(
      CredentialRenewal.layer.pipe(Layer.provideMerge(dependenciesLayer)),
      scope,
    );
    const renewal = Context.get(services, CredentialRenewal.CredentialRenewal);
    const metadata = Context.get(services, Metadata.Metadata);
    const sql = Context.get(services, SqlClient.SqlClient);
    const fileEnvironment = decodeEnvironment({
      registrationId,
      environmentId: "source-environment",
      endpoint: "https://source.example",
      label: "Source",
      platform: null,
      enabled: false,
      state: "pending",
      credentialStorage: null,
      credentialExpiresAt: null,
      renewal: "unsupported",
      cleanupPending: false,
      lastSeenAt: null,
      revision: 0,
    });
    yield* metadata.createEnvironment(fileEnvironment);
    yield* store.set(reference, predecessor);
    yield* metadata.markEnrollment({
      registrationId: fileEnvironment.registrationId,
      credentialStorage: "secure-vault",
      credentialItemKey: reference,
      credentialExpiresAt: expiresAt,
    });
    yield* metadata.setRenewalStatus(
      registrationId,
      predecessor.renewalSupported ? "ready" : "unsupported",
    );
    calls.length = 0;

    const buildRenewal = () =>
      Layer.buildWithScope(
        CredentialRenewal.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerConfig.layer(isolatedConfig),
              Layer.succeed(Metadata.Metadata, metadata),
              Layer.succeed(CredentialStore.CredentialStore, store),
              Layer.succeed(Enrollment.SourceCredentialExchange, source),
            ),
          ),
        ),
        scope,
      ).pipe(Effect.map((services) => Context.get(services, CredentialRenewal.CredentialRenewal)));

    return {
      renewal,
      buildRenewal,
      metadata,
      credentials,
      remoteSessions,
      revokeResults,
      calls,
      fileSystem,
      config: isolatedConfig,
      sql,
    };
  });

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-renewal-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("Factory credential renewal", (it) => {
  it.effect("stores a replacement before attempting predecessor cleanup", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness();
      yield* harness.renewal.runOnce;
      const stored = harness.credentials.get(reference);

      expect(harness.calls.slice(0, 3)).toEqual(["issue", "store", "revoke"]);
      expect(stored?.token).toBe(newToken);
      expect(stored?.predecessorCleanupId).toBeUndefined();
      expect((yield* harness.metadata.listEnvironments)[0]?.renewal).toBe("ready");
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-order")),
  );

  it.effect("starts the renewal worker during factory startup", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness();
      yield* harness.renewal.start;

      expect(harness.calls.slice(0, 3)).toEqual(["issue", "store", "revoke"]);
      expect(harness.credentials.get(reference)?.token).toBe(newToken);
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-startup")),
  );

  it.effect("backs off after a transient issue failure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ issueFailureCount: 1 });
      yield* harness.renewal.runOnce;
      yield* harness.renewal.runOnce;
      expect(harness.calls).toEqual(["issue"]);
      yield* TestClock.adjust("29 seconds");
      yield* harness.renewal.runOnce;
      expect(harness.calls).toEqual(["issue"]);
      yield* TestClock.adjust("1 second");
      yield* harness.renewal.runOnce;

      expect(harness.calls.slice(0, 3)).toEqual(["issue", "issue", "store"]);
      expect(harness.credentials.get(reference)?.token).toBe(newToken);
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-retry")),
  );

  it.effect(
    "keeps the replacement when remote revocation commits before its response is lost",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(18 * DAY_MS);
        const harness = yield* makeHarness({ revokeLostResponseCount: 1 });
        yield* harness.renewal.runOnce;
        expect(harness.credentials.get(reference)?.token).toBe(newToken);
        expect(harness.credentials.get(reference)?.predecessorCleanupId).toBe(oldSessionId);
        expect(harness.remoteSessions.get(oldSessionId)?.revoked).toBe(true);
        expect(harness.revokeResults).toEqual(["response-lost"]);
        expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
          renewal: "ready",
          cleanupPending: true,
        });

        yield* TestClock.adjust("30 seconds");
        yield* harness.renewal.runOnce;

        expect(harness.credentials.get(reference)?.token).toBe(newToken);
        expect(harness.credentials.get(reference)?.predecessorCleanupId).toBeUndefined();
        expect(harness.calls.filter((call) => call === "issue")).toHaveLength(1);
        expect(harness.calls.filter((call) => call === "revoke")).toHaveLength(2);
        expect(harness.revokeResults).toEqual(["response-lost", false]);
        expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
          renewal: "ready",
          cleanupPending: false,
        });
      }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-lost-revoke")),
  );

  it.effect("keeps the predecessor when a remotely issued replacement response is lost", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ issueLostResponseCount: 1 });
      yield* harness.renewal.runOnce;

      expect(harness.credentials.get(reference)?.token).toBe(oldToken);
      expect(harness.remoteSessions.get(oldSessionId)?.revoked).toBe(false);
      expect(harness.remoteSessions.get("orphan-replacement-session")?.token).toBe(
        "orphan-replacement-token-test-value",
      );
      expect(harness.remoteSessions.get("orphan-replacement-session")?.revoked).toBe(false);
      expect(harness.calls).toEqual(["issue"]);

      yield* harness.renewal.runOnce;
      expect(harness.calls).toEqual(["issue"]);
      yield* TestClock.adjust("30 seconds");
      yield* harness.renewal.runOnce;

      expect(harness.credentials.get(reference)?.token).toBe(newToken);
      expect(harness.remoteSessions.get(oldSessionId)?.revoked).toBe(true);
      expect(harness.remoteSessions.get("orphan-replacement-session")?.revoked).toBe(false);
      expect(harness.credentials.get(reference)?.token).not.toBe(
        "orphan-replacement-token-test-value",
      );
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-lost-issue-response")),
  );

  it.effect("keeps the predecessor when issuance fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ issueFailure: true });
      yield* harness.renewal.runOnce;

      expect(harness.credentials.get(reference)?.token).toBe(oldToken);
      expect(harness.calls).toEqual(["issue"]);
      expect((yield* harness.metadata.listEnvironments)[0]?.renewal).toBe("failed");
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-lost-issue")),
  );

  it.effect("keeps the predecessor when replacement storage fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ storeFailure: true });
      expect(yield* harness.metadata.listEnrollmentReferences).toMatchObject([
        {
          environment: { enabled: true, state: "offline" },
          credentialStorage: "secure-vault",
          credentialItemKey: reference,
        },
      ]);
      yield* harness.renewal.runOnce;

      expect(harness.credentials.get(reference)?.token).toBe(oldToken);
      expect(harness.calls).toEqual(["issue", "store"]);
      expect((yield* harness.metadata.listEnvironments)[0]?.renewal).toBe("failed");
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-store-failure")),
  );

  it.effect("retains a stored replacement and reports cleanup failure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ revokeFailure: true });
      yield* harness.renewal.runOnce;
      const stored = harness.credentials.get(reference);

      expect(stored?.token).toBe(newToken);
      expect(stored?.predecessorCleanupId).toBe(oldSessionId);
      expect(harness.remoteSessions.get(oldSessionId)?.revoked).toBe(false);
      expect(harness.revokeResults).toEqual([]);
      expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
        renewal: "ready",
        cleanupPending: true,
      });
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-cleanup-failure")),
  );

  it.effect("retries a pre-commit revoke failure while retaining the stored replacement", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ revokeFailureCount: 1 });
      yield* harness.renewal.runOnce;

      expect(harness.credentials.get(reference)?.token).toBe(newToken);
      expect(harness.credentials.get(reference)?.predecessorCleanupId).toBe(oldSessionId);
      expect(harness.remoteSessions.get(oldSessionId)?.revoked).toBe(false);
      expect(harness.revokeResults).toEqual([]);
      expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
        renewal: "ready",
        cleanupPending: true,
      });

      yield* TestClock.adjust("30 seconds");
      yield* harness.renewal.runOnce;

      expect(harness.credentials.get(reference)?.token).toBe(newToken);
      expect(harness.credentials.get(reference)?.predecessorCleanupId).toBeUndefined();
      expect(harness.remoteSessions.get(oldSessionId)?.revoked).toBe(true);
      expect(harness.calls.filter((call) => call === "issue")).toHaveLength(1);
      expect(harness.calls.filter((call) => call === "revoke")).toHaveLength(2);
      expect(harness.revokeResults).toEqual([true]);
      expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
        renewal: "ready",
        cleanupPending: false,
      });
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-pre-commit-revoke")),
  );

  it.effect("retries predecessor cleanup after service restart without falling back", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ revokeFailure: true });
      yield* harness.renewal.runOnce;
      const restarted = yield* harness.buildRenewal();
      yield* restarted.runOnce;

      expect(harness.credentials.get(reference)?.token).toBe(newToken);
      expect(harness.calls.filter((call) => call === "issue")).toHaveLength(1);
      expect(harness.calls.filter((call) => call === "revoke")).toHaveLength(2);
      expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
        renewal: "ready",
        cleanupPending: true,
      });
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-restart")),
  );

  it.effect("does not attempt cleanup when the replacement lacks access-write", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ scopes: ["orchestration:read"] });
      yield* harness.renewal.runOnce;
      const stored = harness.credentials.get(reference);

      expect(stored?.token).toBe(newToken);
      expect(stored?.predecessorCleanupId).toBeUndefined();
      expect(harness.calls).toEqual(["issue", "store"]);
      expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
        renewal: "ready",
        cleanupPending: true,
      });

      yield* TestClock.setTime(33 * DAY_MS);
      yield* harness.renewal.runOnce;

      expect(harness.calls).toEqual(["issue", "store", "issue", "store"]);
      expect(harness.credentials.get(reference)?.token).toBe(newToken);
      expect((yield* harness.metadata.listEnvironments)[0]).toMatchObject({
        renewal: "ready",
        cleanupPending: true,
      });
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-no-access-write")),
  );

  it.effect("reports unsupported sources and expired credentials without attempting renewal", () =>
    Effect.gen(function* () {
      const unsupported = yield* makeHarness({ renewalSupported: false });
      yield* unsupported.renewal.runOnce;
      expect((yield* unsupported.metadata.listEnvironments)[0]?.renewal).toBe("unsupported");
      expect(unsupported.calls).toEqual([]);

      yield* TestClock.setTime(31 * DAY_MS);
      const expired = yield* makeHarness();
      yield* expired.renewal.runOnce;
      expect((yield* expired.metadata.listEnvironments)[0]?.renewal).toBe("expired");
      expect(expired.calls).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-unavailable")),
  );

  it.effect("keeps tokens out of SQLite, WAL, renewal errors, and environment status", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(18 * DAY_MS);
      const harness = yield* makeHarness({ issueFailure: true });
      const result = yield* harness.renewal.runOnce.pipe(Effect.exit);
      const database = yield* harness.fileSystem.readFile(harness.config.dbPath);
      const walPath = `${harness.config.dbPath}-wal`;
      const wal = (yield* harness.fileSystem.exists(walPath))
        ? yield* harness.fileSystem.readFile(walPath)
        : new Uint8Array();
      const persisted = NodeBuffer.Buffer.concat([
        NodeBuffer.Buffer.from(database),
        NodeBuffer.Buffer.from(wal),
      ]).toString("utf8");
      const exposed = yield* encodeJson(yield* harness.metadata.getSnapshot);

      expect(Exit.isSuccess(result)).toBe(true);
      expect(persisted).not.toContain(oldToken);
      expect(persisted).not.toContain(newToken);
      expect(exposed).not.toContain(oldToken);
      expect(exposed).not.toContain(newToken);
    }).pipe(Effect.provide(TestClock.layer()), Random.withSeed("renewal-redaction")),
  );
});
