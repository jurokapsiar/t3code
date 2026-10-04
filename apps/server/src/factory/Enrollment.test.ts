import * as NodeBuffer from "node:buffer";

import { afterEach, assert, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
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
  FactoryRegistrationId,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as CredentialMutations from "./CredentialMutations.ts";
import * as CredentialRenewal from "./CredentialRenewal.ts";
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
    const failWrite = yield* Ref.make(options.failCredentialWrite);
    let failCompensation = false;
    const ownerWakes: Array<Parameters<Enrollment.RegistrationLifecycle["Service"]["enabled"]>[0]> =
      [];
    const supervisorStartsRef = yield* Ref.make(0);
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, { days: 1 });
    let metadataForExchange: Metadata.Metadata["Service"] | undefined;
    let advanceRevisionOnNextExchange = false;
    let exchangeGate:
      | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
      | undefined;
    let nextMutation: Deferred.Deferred<void> | undefined;
    const renewedTokens: string[] = [];
    const observedMutationsLayer = Layer.effect(
      CredentialMutations.CredentialMutations,
      Effect.gen(function* () {
        const mutations = yield* CredentialMutations.CredentialMutations;
        return CredentialMutations.CredentialMutations.of({
          withLock: (registrationId, operation) =>
            Effect.suspend(() => {
              const signal = nextMutation;
              nextMutation = undefined;
              return (
                signal === undefined ? Effect.void : Deferred.succeed(signal, undefined)
              ).pipe(Effect.andThen(mutations.withLock(registrationId, operation)));
            }),
        });
      }),
    ).pipe(Layer.provide(CredentialMutations.layer));
    const storeLayer = Layer.succeed(
      CredentialStore.CredentialStore,
      CredentialStore.CredentialStore.of({
        get: (reference) => Effect.succeed(Option.fromNullishOr(credentials.get(reference))),
        set: (reference, credential) =>
          Effect.gen(function* () {
            if (
              (yield* Ref.get(failWrite)) ||
              (failCompensation && credential.token === storedCredential)
            ) {
              return yield* new CredentialStore.CredentialStoreError({
                operation: "write",
                backend: "secure-vault",
              });
            }
            credentials.set(reference, credential);
          }),
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
        exchange: ({ credential }) =>
          Effect.gen(function* () {
            const gate = exchangeGate;
            exchangeGate = undefined;
            if (gate !== undefined) {
              yield* Deferred.succeed(gate.entered, undefined);
              yield* Deferred.await(gate.release);
            }
            if (advanceRevisionOnNextExchange && metadataForExchange !== undefined) {
              advanceRevisionOnNextExchange = false;
              const current = (yield* metadataForExchange.listEnvironments)[0];
              if (current !== undefined) {
                yield* metadataForExchange
                  .updateEnvironment({
                    registrationId: current.registrationId,
                    revision: current.revision,
                    label: "Concurrent edit",
                  })
                  .pipe(
                    Effect.mapError(
                      () => new Enrollment.SourceCredentialExchangeError({ operation: "exchange" }),
                    ),
                  );
              }
            }
            return {
              token:
                credential === sourceCredential
                  ? storedCredential
                  : storedCredential + ":" + credential,
              sourceSessionId: AuthSessionId.make("source-session"),
              issuedAt,
              expiresAt,
              scopes: ["orchestration:read"],
              renewalSupported: options.renewalSupported ?? false,
            };
          }),
        renew: ({ credential }) =>
          Effect.gen(function* () {
            renewedTokens.push(credential.token);
            const gate = exchangeGate;
            exchangeGate = undefined;
            if (gate !== undefined) {
              yield* Deferred.succeed(gate.entered, undefined);
              yield* Deferred.await(gate.release);
            }
            return {
              ...credential,
              token: credential.token + ":renewed",
              issuedAt: yield* DateTime.now,
            };
          }),
        revoke: () =>
          Effect.fail(new Enrollment.SourceCredentialExchangeError({ operation: "revoke" })),
      }),
    );
    const lifecycleLayer = Layer.succeed(
      Enrollment.RegistrationLifecycle,
      Enrollment.RegistrationLifecycle.of({
        enabled: (environment) =>
          Effect.sync(() => ownerWakes.push(environment)).pipe(
            Effect.andThen(Ref.update(supervisorStartsRef, (count) => count + 1)),
          ),
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
      observedMutationsLayer,
      storeLayer,
      sourceLayer,
      lifecycleLayer,
    ).pipe(Layer.provideMerge(metadataAndIdentityLayer));
    const services = yield* Layer.buildWithScope(
      Layer.mergeAll(Enrollment.layer, CredentialRenewal.layer).pipe(
        Layer.provideMerge(enrollmentDependenciesLayer),
      ),
      scope,
    );
    const enrollment = Context.get(services, Enrollment.Enrollment);
    const metadata = Context.get(services, Metadata.Metadata);
    metadataForExchange = metadata;
    const sql = Context.get(services, SqlClient.SqlClient);
    const readRegistration = Effect.gen(function* () {
      const registrations = yield* metadata.listEnvironments;
      assert.equal(registrations.length, 1);
      return registrations[0]!;
    });

    return {
      enroll: (credential = input.sourceCredential) =>
        enrollment.enroll({ ...input, sourceCredential: credential }),
      readRegistration,
      supervisorStarts: Ref.get(supervisorStartsRef),
      ownerWakes,
      credentials,
      config: isolatedConfig,
      fileSystem,
      metadata,
      enrollment,
      sql,
      failRemoval,
      failWrite,
      failCompensation: () => {
        failCompensation = true;
      },
      renewedTokens,
      assertCredentialFree: (value: unknown) =>
        Effect.gen(function* () {
          const snapshot = yield* metadata.getSnapshot;
          const database = yield* fileSystem.readFile(isolatedConfig.dbPath);
          const walPath = `${isolatedConfig.dbPath}-wal`;
          const wal = (yield* fileSystem.exists(walPath))
            ? yield* fileSystem.readFile(walPath)
            : new Uint8Array();
          const persisted = NodeBuffer.Buffer.concat([database, wal]).toString("utf8");
          for (const secret of [sourceCredential, storedCredential, "private-"]) {
            assert.notInclude(encodeJson({ value, snapshot }), secret);
            assert.notInclude(persisted, secret);
          }
        }),
      renewal: Context.get(services, CredentialRenewal.CredentialRenewal),
      holdNextExchange: Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        exchangeGate = { entered, release };
        return { entered: Deferred.await(entered), release: Deferred.succeed(release, undefined) };
      }),
      observeNextMutation: Effect.gen(function* () {
        const signal = yield* Deferred.make<void>();
        nextMutation = signal;
        return { attempted: Deferred.await(signal) };
      }),
      advanceRevisionOnNextExchange: () => {
        advanceRevisionOnNextExchange = true;
      },
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
  it.effect("serializes overlapping re-enrollments without restoring a stale credential", () =>
    Effect.gen(function* () {
      const h = yield* makeEnrollmentHarness({ failCredentialWrite: false });
      yield* h.enroll();
      const gate = yield* h.holdNextExchange;
      const first = yield* h
        .enroll("first-private-bootstrap")
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* gate.entered;
      const read = yield* h.observeNextMutation;
      const second = yield* h
        .enroll("second-private-bootstrap")
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* read.attempted;
      yield* gate.release;
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.isTrue(results.every(Exit.isSuccess));
      assert.equal(
        [...h.credentials.values()][0]?.token,
        storedCredential + ":second-private-bootstrap",
      );
      assert.equal(h.credentials.size, 1);
      yield* h.assertCredentialFree(results);
    }),
  );

  it.effect("does not recreate a removed credential during rejected re-enrollment rollback", () =>
    Effect.gen(function* () {
      const h = yield* makeEnrollmentHarness({ failCredentialWrite: false });
      const registered = yield* h.enroll();
      const gate = yield* h.holdNextExchange;
      const replacement = yield* h
        .enroll("private-removal-bootstrap")
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* gate.entered;
      const edited = yield* h.metadata.updateEnvironment({
        registrationId: registered.registrationId,
        revision: registered.revision,
        label: "Concurrent edit",
      });
      const read = yield* h.observeNextMutation;
      const removal = yield* h.enrollment
        .remove({ registrationId: edited.registrationId, revision: edited.revision })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* read.attempted;
      const whileExchanging = yield* h.metadata.getSnapshot;
      yield* gate.release;
      assert.isTrue(Exit.isFailure(yield* Fiber.join(replacement)));
      assert.isTrue((yield* Fiber.join(removal)).removed);
      assert.equal(h.credentials.size, 0);
      assert.deepEqual((yield* h.metadata.getSnapshot).environments, []);
      assert.equal(whileExchanging.environments[0]?.state, "offline");
      yield* h.assertCredentialFree(whileExchanging);
    }),
  );

  it.effect("serializes renewal with re-enrollment on the same credential reference", () =>
    Effect.gen(function* () {
      const h = yield* makeEnrollmentHarness({
        failCredentialWrite: false,
        renewalSupported: true,
      });
      yield* h.enroll();
      yield* TestClock.adjust("18 hours");
      const gate = yield* h.holdNextExchange;
      const renewal = yield* h.renewal.runOnce.pipe(Effect.forkChild({ startImmediately: true }));
      yield* gate.entered;
      const read = yield* h.observeNextMutation;
      const enrollment = yield* h
        .enroll("private-post-renewal-bootstrap")
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* read.attempted;
      yield* gate.release;
      yield* Fiber.join(renewal);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(enrollment)));
      assert.equal([...h.credentials.values()][0]?.token, storedCredential + ":renewed");
      assert.equal(h.credentials.size, 1);
      yield* h.assertCredentialFree(yield* h.metadata.getSnapshot);
    }),
  );

  it.effect(
    "renewal reads the successful re-enrollment credential after waiting for its mutation",
    () =>
      Effect.gen(function* () {
        const h = yield* makeEnrollmentHarness({
          failCredentialWrite: false,
          renewalSupported: true,
        });
        yield* h.enroll();
        yield* TestClock.adjust("18 hours");
        const gate = yield* h.holdNextExchange;
        const enrollment = yield* h
          .enroll("private-before-renewal-bootstrap")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* gate.entered;
        const read = yield* h.observeNextMutation;
        const renewal = yield* h.renewal.runOnce.pipe(Effect.forkChild({ startImmediately: true }));
        yield* read.attempted;
        yield* gate.release;
        yield* Fiber.join(enrollment);
        yield* Fiber.join(renewal);
        assert.deepEqual(h.renewedTokens, [storedCredential + ":private-before-renewal-bootstrap"]);
        assert.equal(
          [...h.credentials.values()][0]?.token,
          storedCredential + ":private-before-renewal-bootstrap:renewed",
        );
        assert.equal(h.credentials.size, 1);
      }),
  );

  it.effect(
    "preserves the enrolled credential and revision when replacement store write fails",
    () =>
      Effect.gen(function* () {
        const h = yield* makeEnrollmentHarness({ failCredentialWrite: false });
        const original = yield* h.enroll();
        yield* Ref.set(h.failWrite, true);
        const result = yield* h.enroll("private-failed-write-bootstrap").pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        assert.equal((yield* h.readRegistration).revision, original.revision);
        assert.equal([...h.credentials.values()][0]?.token, storedCredential);
        assert.notInclude(encodeJson(result), "private-failed-write-bootstrap");
      }),
  );

  it.effect("releases credential mutation ownership when a source exchange is interrupted", () =>
    Effect.gen(function* () {
      const h = yield* makeEnrollmentHarness({ failCredentialWrite: false });
      yield* h.enroll();
      const gate = yield* h.holdNextExchange;
      const canceled = yield* h
        .enroll("private-canceled-bootstrap")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* gate.entered;
      yield* Fiber.interrupt(canceled);
      assert.equal([...h.credentials.values()][0]?.token, storedCredential);
      yield* h.enroll("private-after-cancel-bootstrap");
      assert.equal(
        [...h.credentials.values()][0]?.token,
        storedCredential + ":private-after-cancel-bootstrap",
      );
    }),
  );

  it.effect("renews another source while re-enrollment holds a registration's mutation lock", () =>
    Effect.gen(function* () {
      const h = yield* makeEnrollmentHarness({
        failCredentialWrite: false,
        renewalSupported: true,
      });
      const first = yield* h.enroll();
      const secondId = FactoryRegistrationId.make("parallel-registration");
      const second = yield* h.metadata.createEnvironment({
        ...first,
        registrationId: secondId,
        environmentId: EnvironmentId.make("parallel-environment"),
        endpoint: "https://parallel.example",
        label: "Parallel source",
        enabled: false,
        state: "pending",
        credentialStorage: null,
        credentialExpiresAt: null,
        revision: 0,
      });
      const credential = [...h.credentials.values()][0]!;
      h.credentials.set("parallel-reference", credential);
      yield* h.metadata.markEnrollment({
        registrationId: second.registrationId,
        credentialStorage: "secure-vault",
        credentialItemKey: "parallel-reference",
        credentialExpiresAt: credential.expiresAt,
      });
      const renewed = yield* Stream.toQueue(h.renewal.subscribeRenewals, { capacity: 8 });
      yield* TestClock.adjust("18 hours");
      const gate = yield* h.holdNextExchange;
      const enrollment = yield* h
        .enroll("private-slow-bootstrap")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* gate.entered;
      const scan = yield* h.renewal.runOnce.pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(yield* Queue.take(renewed), secondId);
      assert.equal(h.credentials.get("parallel-reference")?.token, storedCredential + ":renewed");
      yield* gate.release;
      yield* Fiber.join(enrollment);
      yield* Fiber.join(scan);
    }),
  );

  it.effect("re-enrolls an existing source with the same registration identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnrollmentHarness({ failCredentialWrite: false });
      const first = yield* harness.enroll();
      const replacementCredential = "replacement-source-bootstrap-credential";
      const second = yield* harness.enroll(replacementCredential).pipe(Effect.exit);

      assert.isTrue(Exit.isSuccess(second));
      if (Exit.isFailure(second)) return;
      assert.equal(second.value.registrationId, first.registrationId);
      assert.equal((yield* harness.readRegistration).registrationId, first.registrationId);
      assert.equal(harness.credentials.size, 1);
      assert.equal(
        [...harness.credentials.values()][0]?.token,
        storedCredential + ":" + replacementCredential,
      );
    }),
  );

  it.effect("restores the previous credential when a concurrent edit rejects replacement", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnrollmentHarness({ failCredentialWrite: false });
      const registered = yield* harness.enroll();
      harness.advanceRevisionOnNextExchange();

      const result = yield* harness
        .enroll("replacement-source-bootstrap-credential")
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      const current = yield* harness.readRegistration;
      assert.equal(current.label, "Concurrent edit");
      assert.equal(current.registrationId, registered.registrationId);
      assert.equal(harness.credentials.size, 1);
      assert.equal([...harness.credentials.values()][0]?.token, storedCredential);
    }),
  );

  it.effect(
    "wakes the owner with durable current metadata when compensation fails and permits explicit recovery",
    () =>
      Effect.gen(function* () {
        const h = yield* makeEnrollmentHarness({ failCredentialWrite: false });
        const original = yield* h.enroll();
        h.advanceRevisionOnNextExchange();
        h.failCompensation();
        const error = yield* h.enroll("private-replacement").pipe(Effect.flip);
        assert.equal(error._tag, "CredentialStoreError");
        const current = yield* h.readRegistration;
        assert.equal(current.registrationId, original.registrationId);
        assert.equal(current.revision, original.revision + 1);
        assert.equal(current.label, "Concurrent edit");
        assert.deepEqual(current.credentialExpiresAt, original.credentialExpiresAt);
        assert.isTrue(current.enabled);
        assert.equal(
          [...h.credentials.values()][0]?.token,
          storedCredential + ":private-replacement",
        );
        assert.equal(yield* h.supervisorStarts, 2);
        assert.deepEqual(h.ownerWakes[1], current);
        yield* h.assertCredentialFree(error);
        const recovered = yield* h.enroll("private-recovery");
        assert.equal(recovered.registrationId, original.registrationId);
        assert.equal([...h.credentials.values()][0]?.token, storedCredential + ":private-recovery");
        assert.equal(yield* h.supervisorStarts, 3);
      }),
  );

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
