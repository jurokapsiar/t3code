import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionRenewal from "./SessionRenewal.ts";
import * as SessionStore from "./SessionStore.ts";

const currentSession: SessionStore.VerifiedSession = {
  sessionId: AuthSessionId.make("current-session"),
  token: "current-token",
  method: "bearer-access-token",
  client: { label: "Factory", deviceType: "bot" },
  expiresAt: DateTime.makeUnsafe(1_800_000_000_000),
  subject: "factory-source",
  scopes: ["orchestration:read"],
  renewedFrom: null,
  rootIssuedAt: DateTime.toUtc(DateTime.makeUnsafe(1_800_000_000_000)),
};

const principal = {
  sessionId: currentSession.sessionId,
  subject: currentSession.subject,
  method: currentSession.method,
  scopes: currentSession.scopes,
};

it("rejects renewal scopes that widen the current session", () => {
  expect(
    SessionRenewal.selectRenewalScopes({
      current: ["orchestration:read"],
      requested: ["orchestration:read", "access:write"],
    }),
  ).toEqual({ ok: false, reason: "scope-widening" });
});

it.effect("does not call the issuer when the requested scopes widen the bearer", () =>
  Effect.gen(function* () {
    let verifyCalls = 0;
    let issueCalls = 0;
    const renewal = SessionRenewal.make({
      verify: () => {
        verifyCalls += 1;
        return Effect.succeed(currentSession);
      },
      issueRenewal: () => {
        issueCalls += 1;
        return Effect.die("Invalid scopes reached session issuance.");
      },
    });

    const error = yield* Effect.flip(
      renewal.renew({
        credential: currentSession.token,
        principal,
        requestedScopes: ["orchestration:read", "access:write"],
      }),
    );

    expect(error._tag).toBe("SessionRenewalScopeError");
    expect(verifyCalls).toBe(0);
    expect(issueCalls).toBe(0);
  }),
);

it("rejects an empty renewal scope set", () => {
  expect(
    SessionRenewal.selectRenewalScopes({
      current: ["orchestration:read"],
      requested: [],
    }),
  ).toEqual({ ok: false, reason: "empty-scope-set" });
});

it.effect("does not verify or issue a bearer with no scopes", () =>
  Effect.gen(function* () {
    let verifyCalls = 0;
    let issueCalls = 0;
    const renewal = SessionRenewal.make({
      verify: () => {
        verifyCalls += 1;
        return Effect.succeed(currentSession);
      },
      issueRenewal: () => {
        issueCalls += 1;
        return Effect.die("Empty scopes reached session issuance.");
      },
    });

    const error = yield* Effect.flip(
      renewal.renew({
        credential: currentSession.token,
        principal,
        requestedScopes: [],
      }),
    );

    expect(error._tag).toBe("SessionRenewalScopeError");
    expect(verifyCalls).toBe(0);
    expect(issueCalls).toBe(0);
  }),
);

it.effect("issues an unchanged-scope normal bearer session and leaves its predecessor valid", () =>
  Effect.gen(function* () {
    const issueInputs: Parameters<SessionRenewal.Issuer["issueRenewal"]>[0][] = [];
    const renewal = SessionRenewal.make({
      verify: () => Effect.succeed(currentSession),
      issueRenewal: (input) => {
        issueInputs.push(input);
        const now = DateTime.makeUnsafe(1_800_000_000_000);
        return Effect.succeed({
          sessionId: AuthSessionId.make("replacement-session"),
          token: "replacement-token",
          method: "bearer-access-token",
          client: input?.client ?? currentSession.client,
          expiresAt: DateTime.add(now, { days: 30 }),
          scopes: input.scopes,
          renewedFrom: input.parentSessionId,
          rootIssuedAt: input.rootIssuedAt,
        });
      },
    });

    const replacement = yield* renewal.renew({
      credential: currentSession.token,
      principal,
    });

    expect(replacement.token).toBe("replacement-token");
    expect(replacement.method).toBe("bearer-access-token");
    expect(replacement.scopes).toEqual(currentSession.scopes);
    expect(issueInputs).toHaveLength(1);
    expect(issueInputs[0]).toEqual({
      parentSessionId: currentSession.sessionId,
      subject: currentSession.subject,
      scopes: currentSession.scopes,
      client: currentSession.client,
      rootIssuedAt: currentSession.rootIssuedAt,
    });
  }),
);

const makeSessionStoreLayer = () =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-renewal-test-" })),
  );

it.layer(NodeServices.layer)("SessionRenewal with SessionStore", (it) => {
  it.effect(
    "records direct renewal lineage and invalidates only unreleased successors on retry",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const root = yield* sessions.issue({
          subject: "factory-source",
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
        });
        const principal = {
          sessionId: root.sessionId,
          subject: "factory-source",
          method: "bearer-access-token" as const,
          scopes: root.scopes,
        };
        const removed = yield* Deferred.make<void>();
        yield* sessions.streamChanges.pipe(
          Stream.runForEach((change) =>
            change.type === "clientRemoved" && change.sessionId !== root.sessionId
              ? Deferred.succeed(removed, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        const renewal = SessionRenewal.make(sessions);
        const first = yield* renewal.renew({ credential: root.token, principal });
        const firstVerified = yield* sessions.verify(first.token);
        expect(firstVerified.renewedFrom).toBe(root.sessionId);
        expect(firstVerified.rootIssuedAt).toEqual(root.rootIssuedAt);
        yield* sessions.markConnected(first.sessionId);
        const retry = yield* renewal.renew({ credential: root.token, principal });

        expect((yield* Effect.flip(sessions.verify(first.token)))._tag).toBe(
          "SessionTokenRevokedError",
        );
        expect((yield* sessions.verify(root.token)).sessionId).toBe(root.sessionId);
        expect((yield* sessions.verify(retry.token)).sessionId).toBe(retry.sessionId);
        yield* Deferred.await(removed);
        const active = yield* sessions.listActive();
        expect(active.find((session) => session.sessionId === first.sessionId)).toBeUndefined();
      }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("serializes concurrent renewals and idempotent releases in SQLite", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const root = yield* sessions.issue({
        subject: "factory-source",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      const principal = {
        sessionId: root.sessionId,
        subject: "factory-source",
        method: "bearer-access-token" as const,
        scopes: root.scopes,
      };
      const renewal = SessionRenewal.make(sessions);
      const attempts = yield* Effect.all(
        [0, 1].map(() => Effect.exit(renewal.renew({ credential: root.token, principal }))),
        { concurrency: "unbounded" },
      );
      const issued = attempts.flatMap((attempt) =>
        attempt._tag === "Success" ? [attempt.value] : [],
      );
      expect(issued.length).toBeGreaterThan(0);
      const checks = yield* Effect.all(
        issued.map((session) => Effect.exit(sessions.verify(session.token))),
        { concurrency: "unbounded" },
      );
      const active = issued.filter((_, index) => checks[index]?._tag === "Success");
      expect(active).toHaveLength(1);
      expect((yield* sessions.verify(root.token)).sessionId).toBe(root.sessionId);

      const releases = yield* Effect.all(
        [0, 1].map(() => sessions.releaseRenewal(active[0]!.sessionId)),
        { concurrency: "unbounded" },
      );
      expect(releases.filter(Boolean)).toHaveLength(1);
      expect((yield* Effect.flip(sessions.verify(root.token)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect((yield* sessions.verify(active[0]!.token)).sessionId).toBe(active[0]!.sessionId);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("linearizes a renewal racing its direct-parent release", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const root = yield* sessions.issue({
        subject: "factory-source",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      const principal = {
        sessionId: root.sessionId,
        subject: "factory-source",
        method: "bearer-access-token" as const,
        scopes: root.scopes,
      };
      const renewal = SessionRenewal.make(sessions);
      const first = yield* renewal.renew({ credential: root.token, principal });
      const [retry, released] = yield* Effect.all(
        [
          Effect.exit(renewal.renew({ credential: root.token, principal })),
          sessions.releaseRenewal(first.sessionId),
        ],
        { concurrency: "unbounded" },
      );

      if (retry._tag === "Success") {
        expect(released).toBe(false);
        expect((yield* sessions.verify(root.token)).sessionId).toBe(root.sessionId);
        expect((yield* sessions.verify(retry.value.token)).sessionId).toBe(retry.value.sessionId);
        expect((yield* Effect.flip(sessions.verify(first.token)))._tag).toBe(
          "SessionTokenRevokedError",
        );
      } else {
        expect(released).toBe(true);
        expect((yield* Effect.flip(sessions.verify(root.token)))._tag).toBe(
          "SessionTokenRevokedError",
        );
        expect((yield* sessions.verify(first.token)).sessionId).toBe(first.sessionId);
      }
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("caps a chained renewal at 90 days from its root issuance", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const sessions = yield* SessionStore.SessionStore;
      const root = yield* sessions.issue({
        subject: "factory-source",
        ttl: Duration.days(120),
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      yield* TestClock.setTime(75 * 24 * 60 * 60 * 1000);

      const replacement = yield* SessionRenewal.make(sessions).renew({
        credential: root.token,
        principal: {
          sessionId: root.sessionId,
          subject: "factory-source",
          method: "bearer-access-token",
          scopes: root.scopes,
        },
      });

      expect(replacement.expiresAt.epochMilliseconds).toBe(90 * 24 * 60 * 60 * 1000);
      expect((yield* sessions.verify(root.token)).sessionId).toBe(root.sessionId);
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("rejects renewal after the immutable root lifetime cap", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const sessions = yield* SessionStore.SessionStore;
      const root = yield* sessions.issue({
        ttl: Duration.days(120),
        subject: "factory-source",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      yield* TestClock.setTime(90 * 24 * 60 * 60 * 1000);
      const error = yield* Effect.flip(
        SessionRenewal.make(sessions).renew({
          credential: root.token,
          principal: {
            sessionId: root.sessionId,
            subject: "factory-source",
            method: "bearer-access-token",
            scopes: root.scopes,
          },
        }),
      );
      expect(error._tag).toBe("SessionRenewalCredentialError");
      expect((yield* sessions.verify(root.token)).sessionId).toBe(root.sessionId);
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("releases only its direct parent idempotently and emits the database revocation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const root = yield* sessions.issue({
        subject: "factory-source",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      const renewal = SessionRenewal.make(sessions);
      const principal = {
        sessionId: root.sessionId,
        subject: "factory-source",
        method: "bearer-access-token" as const,
        scopes: root.scopes,
      };
      const directParent = yield* renewal.renew({ credential: root.token, principal });
      const replacement = yield* renewal.renew({
        credential: directParent.token,
        principal: {
          ...principal,
          sessionId: directParent.sessionId,
        },
      });
      const removed = yield* Deferred.make<void>();
      yield* sessions.streamChanges.pipe(
        Stream.runForEach((change) =>
          change.type === "clientRemoved" && change.sessionId === directParent.sessionId
            ? Deferred.succeed(removed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* sessions.markConnected(directParent.sessionId);
      expect(yield* sessions.releaseRenewal(replacement.sessionId)).toBe(true);
      yield* Deferred.await(removed);
      expect((yield* Effect.flip(sessions.verify(directParent.token)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect((yield* sessions.verify(root.token)).sessionId).toBe(root.sessionId);
      expect((yield* sessions.verify(replacement.token)).sessionId).toBe(replacement.sessionId);
      expect(yield* sessions.releaseRenewal(replacement.sessionId)).toBe(false);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("issues narrowed scopes with the normal lifetime and keeps the predecessor valid", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const original = yield* sessions.issue({
        subject: "factory-source",
        method: "bearer-access-token",
        scopes: ["orchestration:read", "access:write"],
      });
      const principal = {
        sessionId: original.sessionId,
        subject: "factory-source",
        method: "bearer-access-token" as const,
        scopes: original.scopes,
      };
      const start = yield* DateTime.now;
      const replacement = yield* SessionRenewal.make(sessions).renew({
        credential: original.token,
        principal,
        requestedScopes: ["orchestration:read"],
      });
      const predecessor = yield* sessions.verify(original.token);
      const renewed = yield* sessions.verify(replacement.token);
      const delta = replacement.expiresAt.epochMilliseconds - start.epochMilliseconds;

      expect(renewed.subject).toBe("factory-source");
      expect(renewed.scopes).toEqual(["orchestration:read"]);
      expect(predecessor.sessionId).toBe(original.sessionId);
      expect(delta).toBeLessThanOrEqual(Duration.toMillis(Duration.days(30)));
      expect(delta).toBeGreaterThan(Duration.toMillis(Duration.days(30)) - 2_000);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("does not renew expired or revoked bearer sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      let issueCalls = 0;
      const renewal = SessionRenewal.make({
        verify: sessions.verify,
        issueRenewal: (input) => {
          issueCalls += 1;
          return sessions.issueRenewal(input);
        },
      });
      const expired = yield* sessions.issue({
        ttl: Duration.millis(-1),
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      const principalFor = (session: typeof expired, subject: string) => ({
        sessionId: session.sessionId,
        subject,
        method: session.method,
        scopes: session.scopes,
      });

      const expiredError = yield* Effect.flip(
        renewal.renew({
          credential: expired.token,
          principal: principalFor(expired, "expired-subject"),
        }),
      );
      expect(expiredError._tag).toBe("SessionRenewalCredentialError");

      const revoked = yield* sessions.issue({
        subject: "revoked-subject",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      yield* sessions.revoke(revoked.sessionId);
      const revokedError = yield* Effect.flip(
        renewal.renew({
          credential: revoked.token,
          principal: principalFor(revoked, "revoked-subject"),
        }),
      );
      expect(revokedError._tag).toBe("SessionRenewalCredentialError");
      expect(issueCalls).toBe(0);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("keeps the predecessor valid when replacement issuance fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const original = yield* sessions.issue({
        subject: "factory-source",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      const renewal = SessionRenewal.make({
        verify: sessions.verify,
        issueRenewal: () =>
          Effect.fail(
            new SessionStore.SessionCredentialIssueError({ cause: new Error("storage failed") }),
          ),
      });

      const issueError = yield* Effect.flip(
        renewal.renew({
          credential: original.token,
          principal: {
            sessionId: original.sessionId,
            subject: "factory-source",
            method: "bearer-access-token",
            scopes: original.scopes,
          },
        }),
      );
      const predecessor = yield* sessions.verify(original.token);

      expect(issueError._tag).toBe("SessionRenewalInternalError");
      expect(predecessor.sessionId).toBe(original.sessionId);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
});
