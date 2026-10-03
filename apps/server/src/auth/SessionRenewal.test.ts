import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
      issue: () => {
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
      issue: () => {
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
    const issueInputs: Parameters<SessionRenewal.Issuer["issue"]>[0][] = [];
    const renewal = SessionRenewal.make({
      verify: () => Effect.succeed(currentSession),
      issue: (input) => {
        issueInputs.push(input);
        const now = DateTime.makeUnsafe(1_800_000_000_000);
        return Effect.succeed({
          sessionId: AuthSessionId.make("replacement-session"),
          token: "replacement-token",
          method: "bearer-access-token",
          client: input?.client ?? currentSession.client,
          expiresAt: DateTime.add(now, { days: 30 }),
          scopes: input?.scopes ?? [],
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
    expect(issueInputs[0]).toMatchObject({
      subject: currentSession.subject,
      method: "bearer-access-token",
      scopes: currentSession.scopes,
      client: currentSession.client,
      ttl: Duration.days(30),
    });
    expect(issueInputs[0]?.replaceActiveForSubjectAndMethod).toBeUndefined();
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
        issue: (input) => {
          issueCalls += 1;
          return sessions.issue(input);
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
        issue: () =>
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
