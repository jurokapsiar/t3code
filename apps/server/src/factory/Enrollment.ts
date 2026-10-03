import {
  AuthAccessTokenResult,
  AuthClientSessionRevokeResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthSessionId,
  AuthSessionState,
  AuthSessionRenewalRequest,
  AuthRevokeClientSessionInput,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  ExecutionEnvironmentDescriptor,
  FactoryCredentialStorage,
  FactoryEnvironmentEnrollInput,
  FactoryEnvironmentView,
  FactoryRegistrationId,
  FactoryError,
  FactoryEnvironmentsRemoveRpc,
  type AuthTokenExchangeRequest,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as Metadata from "./Metadata.ts";

const AuthSessionClaims = Schema.Struct({ sid: AuthSessionId });
const SourceEnvironmentIdentity = Schema.Struct({
  environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
  platform: Schema.NullOr(ExecutionEnvironmentDescriptor.fields.platform),
  capabilities: Schema.optionalKey(
    Schema.Struct({ factoryRenewal: Schema.optionalKey(Schema.Boolean) }),
  ),
});
type SourceEnvironmentIdentity = typeof SourceEnvironmentIdentity.Type;

const decodeAuthSessionClaimsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuthSessionClaims),
);

export class SourceCredentialExchangeError extends Schema.TaggedError<SourceCredentialExchangeError>()(
  "SourceCredentialExchangeError",
  {
    operation: Schema.Literals(["discover", "exchange", "validate", "renew", "revoke"]),
  },
) {
  override get message(): string {
    return `The source credential ${this.operation} request failed.`;
  }
}

export class SourceCredentialExchange extends Context.Service<
  SourceCredentialExchange,
  {
    readonly discover: (
      endpoint: string,
    ) => Effect.Effect<SourceEnvironmentIdentity, SourceCredentialExchangeError>;
    readonly exchange: (input: {
      readonly endpoint: string;
      readonly credential: string;
      readonly environmentId: SourceEnvironmentIdentity["environmentId"];
    }) => Effect.Effect<CredentialStore.StoredCredential, SourceCredentialExchangeError>;
    readonly renew: (input: {
      readonly endpoint: string;
      readonly credential: CredentialStore.StoredCredential;
    }) => Effect.Effect<CredentialStore.StoredCredential, SourceCredentialExchangeError>;
    readonly revoke: (input: {
      readonly endpoint: string;
      readonly credential: string;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<AuthClientSessionRevokeResult, SourceCredentialExchangeError>;
  }
>()("t3/factory/Enrollment/SourceCredentialExchange") {}

const endpointUrl = (
  endpoint: string,
  route: string,
  operation: SourceCredentialExchangeError["operation"],
) => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return Effect.fail(new SourceCredentialExchangeError({ operation }));
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return Effect.fail(new SourceCredentialExchangeError({ operation }));
  }
  url.pathname = route;
  url.search = "";
  url.hash = "";
  return Effect.succeed(url);
};

const noStore = <Request extends HttpClientRequest.HttpClientRequest>(request: Request) =>
  request.pipe(HttpClientRequest.setHeader("cache-control", "no-store"));

const fetchJson = <S extends Schema.Constraint>(input: {
  readonly client: HttpClient.HttpClient;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly schema: S;
  readonly operation: SourceCredentialExchangeError["operation"];
}): Effect.Effect<S["Type"], SourceCredentialExchangeError, S["DecodingServices"]> =>
  input.client.execute(input.request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
    Effect.timeout("10 seconds"),
    Effect.mapError(() => new SourceCredentialExchangeError({ operation: input.operation })),
    Effect.provideService(FetchHttpClient.RequestInit, {
      cache: "no-store",
      redirect: "error",
    }),
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
  );

const makeSourceCredentialExchange = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const discover: SourceCredentialExchange["Service"]["discover"] = (endpoint) =>
    Effect.gen(function* () {
      const url = yield* endpointUrl(endpoint, "/.well-known/t3/environment", "discover");
      return yield* fetchJson({
        client,
        request: noStore(HttpClientRequest.get(url.toString())),
        schema: SourceEnvironmentIdentity,
        operation: "discover",
      });
    });

  const exchange: SourceCredentialExchange["Service"]["exchange"] = (input) => {
    const payload: AuthTokenExchangeRequest = {
      grant_type: AuthTokenExchangeGrantType,
      subject_token: input.credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      scope: AuthStandardClientScopes.join(" "),
      client_label: "T3 Code Factory",
      client_device_type: "bot",
    };

    return Effect.gen(function* () {
      const tokenUrl = yield* endpointUrl(input.endpoint, "/oauth/token", "exchange");
      const issued = yield* fetchJson({
        client,
        request: noStore(
          HttpClientRequest.post(tokenUrl.toString()).pipe(
            HttpClientRequest.bodyUrlParams(payload),
          ),
        ),
        schema: AuthAccessTokenResult,
        operation: "exchange",
      });
      if (issued.token_type !== "Bearer") {
        return yield* new SourceCredentialExchangeError({ operation: "exchange" });
      }

      const sessionUrl = yield* endpointUrl(input.endpoint, "/api/auth/session", "validate");
      const session = yield* fetchJson({
        client,
        request: noStore(
          HttpClientRequest.get(sessionUrl.toString()).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${issued.access_token}`),
          ),
        ),
        schema: AuthSessionState,
        operation: "validate",
      });
      if (
        !session.authenticated ||
        session.sessionMethod !== "bearer-access-token" ||
        session.expiresAt === undefined ||
        session.scopes === undefined
      ) {
        return yield* new SourceCredentialExchangeError({ operation: "validate" });
      }
      const issuedScopes = parseOAuthScope(issued.scope);
      const allowedScopes = new Set<string>(AuthStandardClientScopes);
      if (
        issuedScopes === null ||
        issuedScopes.length !== issued.scope.split(" ").length ||
        issuedScopes.some((scope) => !allowedScopes.has(scope)) ||
        new Set(session.scopes).size !== session.scopes.length ||
        session.scopes.length !== issuedScopes.length ||
        session.scopes.some((scope) => !issuedScopes.includes(scope))
      ) {
        return yield* new SourceCredentialExchangeError({ operation: "validate" });
      }

      const descriptor = yield* discover(input.endpoint);
      if (descriptor.environmentId !== input.environmentId) {
        return yield* new SourceCredentialExchangeError({ operation: "validate" });
      }

      const encodedClaims = issued.access_token.split(".")[0];
      if (!encodedClaims) {
        return yield* new SourceCredentialExchangeError({ operation: "validate" });
      }
      const claimsJson = yield* Effect.fromResult(
        Encoding.decodeBase64UrlString(encodedClaims),
      ).pipe(Effect.mapError(() => new SourceCredentialExchangeError({ operation: "validate" })));
      const claims = yield* decodeAuthSessionClaimsJson(claimsJson).pipe(
        Effect.mapError(() => new SourceCredentialExchangeError({ operation: "validate" })),
      );
      const issuedAt = yield* DateTime.now;
      return {
        token: issued.access_token,
        sourceSessionId: claims.sid,
        issuedAt,
        expiresAt: session.expiresAt,
        scopes: session.scopes,
        renewalSupported: descriptor.capabilities?.factoryRenewal === true,
      } satisfies CredentialStore.StoredCredential;
    });
  };

  const renew: SourceCredentialExchange["Service"]["renew"] = (input) =>
    Effect.gen(function* () {
      const url = yield* endpointUrl(input.endpoint, "/api/auth/renew", "renew");
      const request = yield* HttpClientRequest.post(url.toString()).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${input.credential.token}`),
        HttpClientRequest.bodyJson(
          AuthSessionRenewalRequest.make({ scopes: input.credential.scopes }),
        ),
        Effect.map(noStore),
        Effect.mapError(() => new SourceCredentialExchangeError({ operation: "renew" })),
      );
      const issued = yield* fetchJson({
        client,
        request,
        schema: AuthAccessTokenResult,
        operation: "renew",
      });
      if (issued.token_type !== "Bearer") {
        return yield* new SourceCredentialExchangeError({ operation: "renew" });
      }
      const issuedScopes = parseOAuthScope(issued.scope);
      const allowedScopes = new Set<string>(input.credential.scopes);
      if (
        issuedScopes === null ||
        issuedScopes.length !== issued.scope.split(" ").length ||
        issuedScopes.length === 0 ||
        issuedScopes.some((scope) => !allowedScopes.has(scope))
      ) {
        return yield* new SourceCredentialExchangeError({ operation: "validate" });
      }

      const sessionUrl = yield* endpointUrl(input.endpoint, "/api/auth/session", "validate");
      const session = yield* fetchJson({
        client,
        request: noStore(
          HttpClientRequest.get(sessionUrl.toString()).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${issued.access_token}`),
          ),
        ),
        schema: AuthSessionState,
        operation: "validate",
      });
      if (
        !session.authenticated ||
        session.sessionMethod !== "bearer-access-token" ||
        session.expiresAt === undefined ||
        session.scopes === undefined ||
        new Set(session.scopes).size !== session.scopes.length ||
        session.scopes.length !== issuedScopes.length ||
        session.scopes.some((scope) => !issuedScopes.includes(scope))
      ) {
        return yield* new SourceCredentialExchangeError({ operation: "validate" });
      }

      const encodedClaims = issued.access_token.split(".")[0];
      if (!encodedClaims) {
        return yield* new SourceCredentialExchangeError({ operation: "validate" });
      }
      const claimsJson = yield* Effect.fromResult(
        Encoding.decodeBase64UrlString(encodedClaims),
      ).pipe(Effect.mapError(() => new SourceCredentialExchangeError({ operation: "validate" })));
      const claims = yield* decodeAuthSessionClaimsJson(claimsJson).pipe(
        Effect.mapError(() => new SourceCredentialExchangeError({ operation: "validate" })),
      );
      const issuedAt = yield* DateTime.now;
      return {
        token: issued.access_token,
        sourceSessionId: claims.sid,
        issuedAt,
        expiresAt: session.expiresAt,
        scopes: session.scopes,
        renewalSupported: true,
      } satisfies CredentialStore.StoredCredential;
    });

  const revoke: SourceCredentialExchange["Service"]["revoke"] = (input) =>
    Effect.gen(function* () {
      const url = yield* endpointUrl(input.endpoint, "/api/auth/clients/revoke", "revoke");
      const request = yield* HttpClientRequest.post(url.toString()).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${input.credential}`),
        HttpClientRequest.bodyJson(
          AuthRevokeClientSessionInput.make({ sessionId: input.sessionId }),
        ),
        Effect.map(noStore),
        Effect.mapError(() => new SourceCredentialExchangeError({ operation: "revoke" })),
      );
      return yield* fetchJson({
        client,
        request,
        schema: AuthClientSessionRevokeResult,
        operation: "revoke",
      });
    });

  return SourceCredentialExchange.of({ discover, exchange, renew, revoke });
});

export const sourceLayer = Layer.effect(SourceCredentialExchange, makeSourceCredentialExchange);

export class RegistrationLifecycle extends Context.Service<
  RegistrationLifecycle,
  {
    readonly enabled: (environment: FactoryEnvironmentView) => Effect.Effect<void>;
    readonly removing: (environment: FactoryEnvironmentView) => Effect.Effect<void>;
  }
>()("t3/factory/Enrollment/RegistrationLifecycle") {}

export class Enrollment extends Context.Service<
  Enrollment,
  {
    readonly enroll: (
      input: FactoryEnvironmentEnrollInput,
    ) => Effect.Effect<
      FactoryEnvironmentView,
      FactoryError | CredentialStore.CredentialStoreError | SourceCredentialExchangeError
    >;
    readonly remove: (
      input: typeof FactoryEnvironmentsRemoveRpc.payloadSchema.Type,
    ) => Effect.Effect<
      { readonly removed: boolean },
      FactoryError | CredentialStore.CredentialStoreError
    >;
    readonly reconcile: Effect.Effect<void, FactoryError | CredentialStore.CredentialStoreError>;
  }
>()("t3/factory/Enrollment") {}

const internalFailure = () =>
  new FactoryError({
    code: "operation-failed",
    message: "The factory could not complete the credential operation.",
  });

const makeCredentialReference = (
  crypto: Crypto.Crypto,
  installationId: string,
  registrationId: string,
) =>
  crypto
    .digest("SHA-256", new TextEncoder().encode(`${installationId}:${registrationId}`))
    .pipe(Effect.mapError(internalFailure), Effect.map(Encoding.encodeHex));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const metadata = yield* Metadata.Metadata;
  const credentials = yield* CredentialStore.CredentialStore;
  const source = yield* SourceCredentialExchange;
  const lifecycle = yield* RegistrationLifecycle;
  const crypto = yield* Crypto.Crypto;
  const installationId = yield* identity.getEnvironmentId;

  const selectedStorage: FactoryCredentialStorage = config.factoryCredentialStore ?? "secure-vault";
  const ensureSelectedStorage = (storage: FactoryCredentialStorage) =>
    storage === selectedStorage
      ? Effect.void
      : Effect.fail(
          new CredentialStore.CredentialStoreError({
            operation: "read",
            backend: selectedStorage,
          }),
        );

  const completeEnrollment = (input: {
    readonly registrationId: FactoryRegistrationId;
    readonly credential: CredentialStore.StoredCredential;
    readonly credentialItemKey: string;
    readonly storage: FactoryCredentialStorage;
  }) =>
    Effect.gen(function* () {
      yield* metadata.markEnrollment({
        registrationId: input.registrationId,
        credentialStorage: input.storage,
        credentialItemKey: input.credentialItemKey,
        credentialExpiresAt: input.credential.expiresAt,
      });
      const now = yield* DateTime.now;
      const renewal =
        DateTime.toEpochMillis(input.credential.expiresAt) <= DateTime.toEpochMillis(now)
          ? "expired"
          : input.credential.renewalSupported === true
            ? "ready"
            : "unsupported";
      const current = yield* metadata.setRenewalStatus(input.registrationId, renewal);
      yield* lifecycle.enabled(current);
      return current;
    });

  const enroll: Enrollment["Service"]["enroll"] = (input) =>
    Effect.gen(function* () {
      const discovered = yield* source.discover(input.endpoint);
      if (discovered.environmentId === installationId) {
        return yield* new FactoryError({
          code: "invalid-request",
          message: "A factory cannot enroll itself as a source.",
        });
      }

      const current = yield* metadata.listEnvironments;
      const existing = current.find((entry) => entry.environmentId === discovered.environmentId);
      if (
        existing !== undefined &&
        (existing.state !== "pending" || existing.endpoint !== input.endpoint)
      ) {
        return yield* new FactoryError({
          code: "conflict",
          message: "This source environment is already registered.",
        });
      }

      const registrationId =
        existing?.registrationId ??
        FactoryRegistrationId.make(
          yield* crypto.randomUUIDv4.pipe(Effect.mapError(internalFailure)),
        );
      const pending =
        existing ??
        (yield* metadata.createEnvironment({
          registrationId,
          environmentId: discovered.environmentId,
          endpoint: input.endpoint,
          label: input.label,
          platform: discovered.platform,
          enabled: false,
          state: "pending",
          credentialStorage: null,
          credentialExpiresAt: null,
          renewal: "unsupported",
          cleanupPending: false,
          lastSeenAt: null,
          revision: 0,
        }));
      const reference = yield* makeCredentialReference(crypto, installationId, registrationId);
      const knownReference = yield* metadata.getCredentialReference(registrationId);

      if (knownReference !== null) {
        yield* ensureSelectedStorage(knownReference.storage);
        const stored = yield* credentials.get(knownReference.itemKey);
        if (Option.isSome(stored)) {
          return yield* completeEnrollment({
            registrationId,
            credential: stored.value,
            credentialItemKey: knownReference.itemKey,
            storage: knownReference.storage,
          });
        }
      }

      yield* metadata.markPendingEnrollment({
        registrationId,
        credentialStorage: selectedStorage,
        credentialItemKey: reference,
      });
      const credential = yield* source.exchange({
        endpoint: input.endpoint,
        credential: input.sourceCredential,
        environmentId: pending.environmentId,
      });
      yield* credentials.set(reference, credential);
      return yield* completeEnrollment({
        registrationId,
        credential,
        credentialItemKey: reference,
        storage: selectedStorage,
      });
    });

  const remove: Enrollment["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      const current = yield* metadata.getSnapshot;
      const environment = current.environments.find(
        (entry) => entry.registrationId === input.registrationId,
      );
      if (environment === undefined) {
        return yield* new FactoryError({
          code: "not-found",
          message: "The source environment does not exist.",
        });
      }
      const removing = yield* metadata.markRemoving({
        registrationId: input.registrationId,
        revision: input.revision,
      });
      yield* lifecycle.removing(removing);

      const reference = yield* metadata.getCredentialReference(input.registrationId);
      if (reference !== null) {
        yield* ensureSelectedStorage(reference.storage);
        yield* credentials.remove(reference.itemKey);
        yield* metadata.clearCredentialReference(input.registrationId);
      }

      return yield* metadata.removeEnvironment({
        registrationId: input.registrationId,
        revision: (yield* metadata.getSnapshot).environments.find(
          (entry) => entry.registrationId === input.registrationId,
        )!.revision,
      });
    });

  const reconcile: Enrollment["Service"]["reconcile"] = Effect.gen(function* () {
    const references = yield* metadata.listEnrollmentReferences;
    for (const reference of references) {
      const environment = reference.environment;
      if (environment.state === "removing") {
        yield* lifecycle.removing(environment);
        const hasCredentialReference =
          reference.credentialStorage !== null && reference.credentialItemKey !== null;
        if (hasCredentialReference) {
          yield* ensureSelectedStorage(reference.credentialStorage);
          yield* credentials.remove(reference.credentialItemKey);
          yield* metadata.clearCredentialReference(environment.registrationId);
        }
        const latest = (yield* metadata.getSnapshot).environments.find(
          (entry) => entry.registrationId === environment.registrationId,
        );
        if (latest !== undefined) {
          yield* metadata.removeEnvironment({
            registrationId: latest.registrationId,
            revision: latest.revision,
          });
        }
        continue;
      }

      if (
        environment.state !== "pending" ||
        reference.credentialStorage === null ||
        reference.credentialItemKey === null
      ) {
        continue;
      }

      yield* ensureSelectedStorage(reference.credentialStorage);
      const stored = yield* credentials.get(reference.credentialItemKey);
      if (Option.isSome(stored)) {
        yield* completeEnrollment({
          registrationId: environment.registrationId,
          credential: stored.value,
          credentialItemKey: reference.credentialItemKey,
          storage: reference.credentialStorage,
        });
      }
    }
  });

  return Enrollment.of({ enroll, remove, reconcile });
});

export const layer = Layer.effect(Enrollment, make);
