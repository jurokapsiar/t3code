import * as NodeBuffer from "node:buffer";

import { afterEach, assert, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthRevokeClientSessionInput,
  AuthSessionRenewalRequest,
  AuthSessionId,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentId,
  FactoryEnvironmentEnrollInput,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as Enrollment from "./Enrollment.ts";
import * as Metadata from "./Metadata.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";

afterEach(() => vi.unstubAllGlobals());

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRenewalRequest = Schema.decodeEffect(Schema.fromJsonString(AuthSessionRenewalRequest));
const decodeRevokeInput = Schema.decodeEffect(Schema.fromJsonString(AuthRevokeClientSessionInput));

const sourceCredential = "fixed-source-bootstrap-credential-for-tests";
const storedCredential = "fixed-source-access-token-for-tests";
const input = FactoryEnvironmentEnrollInput.make({
  endpoint: "https://source.example",
  label: "Source",
  sourceCredential,
});

const makeEnrollmentHarness = (options: {
  readonly failCredentialWrite: boolean;
  readonly failCredentialRemoval?: boolean;
  readonly renewalSupported?: boolean;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-factory-enrollment-data-",
    });
    const isolatedConfig = {
      ...config,
      stateDir: dataDirectory,
      dbPath: path.join(dataDirectory, "statev2.sqlite"),
      environmentIdPath: path.join(dataDirectory, "environment-id"),
      secretsDir: path.join(dataDirectory, "secrets"),
    };
    const credentials = new Map<string, CredentialStore.StoredCredential>();
    const failRemoval = yield* Ref.make(options.failCredentialRemoval ?? false);
    const supervisorStartsRef = yield* Ref.make(0);
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, { days: 1 });
    const storeLayer = Layer.succeed(
      CredentialStore.CredentialStore,
      CredentialStore.CredentialStore.of({
        get: (reference) => Effect.succeed(Option.fromNullishOr(credentials.get(reference))),
        set: (reference, credential) =>
          options.failCredentialWrite
            ? Effect.fail(
                new CredentialStore.CredentialStoreError({
                  operation: "write",
                  backend: "secure-vault",
                }),
              )
            : Effect.sync(() => void credentials.set(reference, credential)),
        remove: (reference) =>
          Effect.gen(function* () {
            if (yield* Ref.get(failRemoval)) {
              return yield* new CredentialStore.CredentialStoreError({
                operation: "remove",
                backend: "secure-vault",
              });
            }
            credentials.delete(reference);
          }),
      }),
    );
    const sourceLayer = Layer.succeed(
      Enrollment.SourceCredentialExchange,
      Enrollment.SourceCredentialExchange.of({
        discover: () =>
          Effect.succeed({
            environmentId: EnvironmentId.make("source-environment"),
            platform: null,
            ...(options.renewalSupported === undefined
              ? {}
              : { capabilities: { factoryRenewal: options.renewalSupported } }),
          }),
        exchange: ({ credential }) => {
          assert.equal(credential, sourceCredential);
          return Effect.succeed({
            token: storedCredential,
            sourceSessionId: AuthSessionId.make("source-session"),
            issuedAt,
            expiresAt,
            scopes: ["orchestration:read"],
            renewalSupported: options.renewalSupported ?? false,
          });
        },
        renew: () =>
          Effect.fail(new Enrollment.SourceCredentialExchangeError({ operation: "renew" })),
        revoke: () =>
          Effect.fail(new Enrollment.SourceCredentialExchangeError({ operation: "revoke" })),
      }),
    );
    const lifecycleLayer = Layer.succeed(
      Enrollment.RegistrationLifecycle,
      Enrollment.RegistrationLifecycle.of({
        enabled: () => Ref.update(supervisorStartsRef, (count) => count + 1),
        removing: () => Effect.void,
      }),
    );
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const infrastructureLayer = Layer.mergeAll(
      ServerConfig.layer(isolatedConfig),
      makeSqlitePersistenceLive(isolatedConfig.dbPath),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const metadataAndIdentityLayer = Layer.mergeAll(
      Metadata.layer,
      ServerEnvironment.identityLayer,
    ).pipe(Layer.provideMerge(infrastructureLayer));
    const enrollmentDependenciesLayer = Layer.mergeAll(
      storeLayer,
      sourceLayer,
      lifecycleLayer,
    ).pipe(Layer.provideMerge(metadataAndIdentityLayer));
    const services = yield* Layer.buildWithScope(
      Enrollment.layer.pipe(Layer.provideMerge(enrollmentDependenciesLayer)),
      scope,
    );
    const enrollment = Context.get(services, Enrollment.Enrollment);
    const metadata = Context.get(services, Metadata.Metadata);
    const sql = Context.get(services, SqlClient.SqlClient);
    const readRegistration = Effect.gen(function* () {
      const registrations = yield* metadata.listEnvironments;
      assert.equal(registrations.length, 1);
      return registrations[0]!;
    });

    return {
      enroll: () => enrollment.enroll(input),
      readRegistration,
      supervisorStarts: Ref.get(supervisorStartsRef),
      credentials,
      config: isolatedConfig,
      fileSystem,
      metadata,
      enrollment,
      sql,
      failRemoval,
    };
  });

it.effect("discovers sources through the injected Effect HTTP client", () =>
  Effect.gen(function* () {
    const requestedUrls: string[] = [];
    let globalFetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      globalFetchCalls += 1;
      return Response.json({
        environmentId: "source-environment",
        platform: { os: "linux", arch: "x64" },
      });
    });
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        requestedUrls.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId: "source-environment",
            platform: { os: "linux", arch: "x64" },
          }),
        );
      }),
    );
    const services = yield* Layer.build(
      Enrollment.sourceLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient))),
    );
    const source = Context.get(services, Enrollment.SourceCredentialExchange);
    const discovered = yield* source.discover("https://source.example");

    assert.deepEqual(discovered, {
      environmentId: EnvironmentId.make("source-environment"),
      platform: { os: "linux", arch: "x64" },
    });
    assert.deepEqual(requestedUrls, ["https://source.example/.well-known/t3/environment"]);
    assert.equal(globalFetchCalls, 0);
  }),
);

const makeExchangeHttpLayer = (
  scope: string,
  sessionScopes: ReadonlyArray<string>,
  requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: string | undefined;
  }>,
) => {
  const token = `${NodeBuffer.Buffer.from(JSON.stringify({ sid: "source-session" })).toString("base64url")}.signature`;
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body._tag === "Uint8Array" ? request.body.text : undefined,
      });
      if (request.url.endsWith("/oauth/token")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: token,
            issued_token_type: AuthAccessTokenType,
            token_type: "Bearer",
            expires_in: 3600,
            scope,
          }),
        );
      }
      if (request.url.endsWith("/api/auth/session")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["bearer-access-token"],
              sessionCookieName: "t3_session",
            },
            scopes: sessionScopes,
            sessionMethod: "bearer-access-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          environmentId: "source-environment",
          platform: null,
          capabilities: { factoryRenewal: true },
        }),
      );
    }),
  );
  return {
    token,
    layer: Enrollment.sourceLayer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    ),
  };
};

it.effect("exchanges the bootstrap credential over the source auth endpoints", () =>
  Effect.gen(function* () {
    const requests: Parameters<typeof makeExchangeHttpLayer>[2] = [];
    const { token, layer } = makeExchangeHttpLayer(
      AuthStandardClientScopes.join(" "),
      AuthStandardClientScopes,
      requests,
    );
    const services = yield* Layer.build(layer);
    const source = Context.get(services, Enrollment.SourceCredentialExchange);
    const credential = yield* source.exchange({
      endpoint: "https://source.example",
      credential: sourceCredential,
      environmentId: EnvironmentId.make("source-environment"),
    });
    const tokenRequest = requests[0]!;
    const form = new URLSearchParams(tokenRequest.body);

    assert.equal(credential.token, token);
    assert.equal(credential.sourceSessionId, AuthSessionId.make("source-session"));
    assert.deepEqual(credential.scopes, AuthStandardClientScopes);
    assert.isTrue(credential.renewalSupported);
    assert.equal(requests.length, 3);
    assert.equal(tokenRequest.method, "POST");
    assert.equal(tokenRequest.url, "https://source.example/oauth/token");
    assert.equal(tokenRequest.headers["cache-control"], "no-store");
    assert.equal(form.get("grant_type"), AuthTokenExchangeGrantType);
    assert.equal(form.get("subject_token"), sourceCredential);
    assert.equal(form.get("subject_token_type"), AuthEnvironmentBootstrapTokenType);
    assert.equal(form.get("requested_token_type"), AuthAccessTokenType);
    assert.equal(form.get("scope"), AuthStandardClientScopes.join(" "));
    assert.equal(requests[1]!.headers.authorization, `Bearer ${token}`);
    assert.equal(requests[1]!.url, "https://source.example/api/auth/session");
    assert.equal(requests[2]!.url, "https://source.example/.well-known/t3/environment");
  }),
);

it.effect("rejects issued scopes outside the standard client allowlist", () =>
  Effect.gen(function* () {
    const requests: Parameters<typeof makeExchangeHttpLayer>[2] = [];
    const { layer } = makeExchangeHttpLayer("access:write", ["access:write"], requests);
    const services = yield* Layer.build(layer);
    const source = Context.get(services, Enrollment.SourceCredentialExchange);
    const failure = yield* source
      .exchange({
        endpoint: "https://source.example",
        credential: sourceCredential,
        environmentId: EnvironmentId.make("source-environment"),
      })
      .pipe(Effect.flip);

    assert.equal(failure._tag, "SourceCredentialExchangeError");
    assert.equal(failure.operation, "validate");
    assert.notInclude(encodeJson(failure), sourceCredential);
  }),
);

const makeRenewalHttpLayer = (
  requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: string | undefined;
  }>,
  revokeStatus = 200,
  renewalResponse: {
    readonly issuedScope?: string;
    readonly sessionScopes?: ReadonlyArray<string>;
  } = {},
) => {
  const replacementToken = `${NodeBuffer.Buffer.from(JSON.stringify({ sid: "replacement-session" })).toString("base64url")}.signature`;
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body._tag === "Uint8Array" ? request.body.text : undefined,
      });
      if (request.url.endsWith("/api/auth/renew")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: replacementToken,
            issued_token_type: AuthAccessTokenType,
            token_type: "Bearer",
            expires_in: 30 * 24 * 60 * 60,
            scope: renewalResponse.issuedScope ?? "orchestration:read",
          }),
        );
      }
      if (request.url.endsWith("/api/auth/session")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["bearer-access-token"],
              sessionCookieName: "t3_session",
            },
            scopes: renewalResponse.sessionScopes ?? ["orchestration:read"],
            sessionMethod: "bearer-access-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ revoked: true }, { status: revokeStatus }),
      );
    }),
  );
  return {
    replacementToken,
    layer: Enrollment.sourceLayer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    ),
  };
};

it.effect("renews through the existing source endpoint and narrows scopes", () =>
  Effect.gen(function* () {
    const requests: Parameters<typeof makeRenewalHttpLayer>[0] = [];
    const { replacementToken, layer } = makeRenewalHttpLayer(requests);
    const services = yield* Layer.build(layer);
    const source = Context.get(services, Enrollment.SourceCredentialExchange);
    const oldCredential: CredentialStore.StoredCredential = {
      token: "old-bearer-token-for-renewal-test",
      sourceSessionId: AuthSessionId.make("previous-session"),
      issuedAt: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe(30 * 24 * 60 * 60 * 1000),
      scopes: ["orchestration:read", "access:write"],
      renewalSupported: true,
    };
    const renewed = yield* source.renew({
      endpoint: "https://source.example",
      credential: oldCredential,
    });
    const revoked = yield* source.revoke({
      endpoint: "https://source.example",
      credential: renewed.token,
      sessionId: oldCredential.sourceSessionId,
    });

    assert.equal(renewed.token, replacementToken);
    assert.equal(renewed.sourceSessionId, AuthSessionId.make("replacement-session"));
    assert.deepEqual(renewed.scopes, ["orchestration:read"]);
    assert.isTrue(renewed.renewalSupported);
    assert.isTrue(revoked.revoked);
    assert.deepEqual(
      requests.map(({ method, url }) => [method, url]),
      [
        ["POST", "https://source.example/api/auth/renew"],
        ["GET", "https://source.example/api/auth/session"],
        ["POST", "https://source.example/api/auth/clients/revoke"],
      ],
    );
    assert.equal(requests[0]?.headers.authorization, `Bearer ${oldCredential.token}`);
    assert.equal(requests[0]?.headers["cache-control"], "no-store");
    assert.deepEqual(yield* decodeRenewalRequest(requests[0]?.body ?? "{}"), {
      scopes: ["orchestration:read", "access:write"],
    });
    assert.equal(requests[2]?.headers.authorization, `Bearer ${replacementToken}`);
    assert.deepEqual(yield* decodeRevokeInput(requests[2]?.body ?? "{}"), {
      sessionId: oldCredential.sourceSessionId,
    });
  }),
);

it.effect("rejects a renewal whose validated session duplicates scopes", () =>
  Effect.gen(function* () {
    const requests: Parameters<typeof makeRenewalHttpLayer>[0] = [];
    const { layer, replacementToken } = makeRenewalHttpLayer(requests, 200, {
      issuedScope: "orchestration:read access:write",
      sessionScopes: ["orchestration:read", "orchestration:read"],
    });
    const services = yield* Layer.build(layer);
    const source = Context.get(services, Enrollment.SourceCredentialExchange);
    const failure = yield* source
      .renew({
        endpoint: "https://source.example",
        credential: {
          token: "old-bearer-token-for-renewal-test",
          sourceSessionId: AuthSessionId.make("previous-session"),
          issuedAt: DateTime.makeUnsafe(0),
          expiresAt: DateTime.makeUnsafe(30 * 24 * 60 * 60 * 1000),
          scopes: ["orchestration:read", "access:write"],
        },
      })
      .pipe(Effect.flip);

    assert.equal(failure.operation, "validate");
    assert.notInclude(String(failure), replacementToken);
    assert.notInclude(encodeJson(failure), replacementToken);
  }),
);

it.effect("keeps a forbidden revoke response credential-free", () =>
  Effect.gen(function* () {
    const requests: Parameters<typeof makeRenewalHttpLayer>[0] = [];
    const { layer } = makeRenewalHttpLayer(requests, 403);
    const services = yield* Layer.build(layer);
    const source = Context.get(services, Enrollment.SourceCredentialExchange);
    const failure = yield* source
      .revoke({
        endpoint: "https://source.example",
        credential: "replacement-secret-for-denial-test",
        sessionId: AuthSessionId.make("previous-session"),
      })
      .pipe(Effect.flip);

    assert.equal(failure.operation, "revoke");
    assert.notInclude(String(failure), "replacement-secret-for-denial-test");
    assert.notInclude(encodeJson(failure), "replacement-secret-for-denial-test");
  }),
);

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-enrollment-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("factory enrollment", (it) => {
  it.effect("marks advertised renewal support in the environment view", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnrollmentHarness({
        failCredentialWrite: false,
        renewalSupported: true,
      });
      const environment = yield* harness.enroll();

      assert.equal(environment.renewal, "ready");
      assert.equal(harness.credentials.values().next().value?.renewalSupported, true);
    }),
  );

  it.effect("does not enable a registration after a failed credential write", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnrollmentHarness({ failCredentialWrite: true });
      const result = yield* harness.enroll().pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      const registration = yield* harness.readRegistration;
      assert.equal(registration.state, "pending");
      assert.equal(yield* harness.supervisorStarts, 0);
      assert.notInclude(encodeJson(result), storedCredential);
    }),
  );

  it.effect(
    "enables a stored source as offline and keeps its credential out of metadata and SQLite",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeEnrollmentHarness({ failCredentialWrite: false });
        const result = yield* harness.enroll();
        const registration = yield* harness.readRegistration;
        const snapshot = yield* harness.metadata.getSnapshot;
        const serialized = encodeJson({ result, registration, snapshot });
        const database = yield* harness.fileSystem.readFile(harness.config.dbPath);
        const walPath = `${harness.config.dbPath}-wal`;
        const wal = (yield* harness.fileSystem.exists(walPath))
          ? yield* harness.fileSystem.readFile(walPath)
          : new Uint8Array();
        const persistedBytes = NodeBuffer.Buffer.concat([
          NodeBuffer.Buffer.from(database),
          NodeBuffer.Buffer.from(wal),
        ]).toString("utf8");

        assert.equal(registration.state, "offline");
        assert.isTrue(registration.enabled);
        assert.equal(yield* harness.supervisorStarts, 1);
        assert.notInclude(serialized, storedCredential);
        assert.notInclude(persistedBytes, storedCredential);
        assert.isTrue(
          [...harness.credentials.values()].some((entry) => entry.token === storedCredential),
        );
        assert.isTrue(result.revision > 0);
      }),
  );

  it.effect("reconciles a stored credential after enrollment metadata finalization fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnrollmentHarness({ failCredentialWrite: false });
      yield* harness.sql`
        CREATE TRIGGER fail_factory_enrollment
        BEFORE UPDATE OF enabled ON factory_environments
        BEGIN SELECT RAISE(ABORT, 'test finalization failure'); END
      `;
      const result = yield* harness.enroll().pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(result));
      const registration = yield* harness.readRegistration;
      assert.equal(registration.state, "pending");
      assert.equal(yield* harness.supervisorStarts, 0);
      yield* harness.sql`DROP TRIGGER fail_factory_enrollment`;
      yield* harness.enrollment.reconcile;
      assert.equal((yield* harness.readRegistration).state, "offline");
      assert.equal(yield* harness.supervisorStarts, 1);
    }),
  );

  it.effect("keeps a removing registration visible when credential deletion fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnrollmentHarness({
        failCredentialWrite: false,
        failCredentialRemoval: true,
      });
      const enrolled = yield* harness.enroll();
      const result = yield* harness.enrollment
        .remove({ registrationId: enrolled.registrationId, revision: enrolled.revision })
        .pipe(Effect.exit);
      const registration = yield* harness.readRegistration;

      assert.isTrue(Exit.isFailure(result));
      assert.equal(registration.state, "removing");
      assert.isFalse(registration.enabled);
      assert.equal(harness.credentials.size, 1);
      assert.notInclude(encodeJson(result), storedCredential);

      yield* Ref.set(harness.failRemoval, false);
      yield* harness.enrollment.reconcile;
      assert.equal((yield* harness.metadata.listEnvironments).length, 0);
      assert.equal(harness.credentials.size, 0);
    }),
  );
});
