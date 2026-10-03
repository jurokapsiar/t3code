import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");

          const bearerPairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(bearerPairingResponse.status).toBe(200);
          const bearerPairing = (await bearerPairingResponse.json()) as { credential: string };
          const accessTokenResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: bearerPairing.credential,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "orchestration:read",
              }),
            }),
            requestContext,
          );
          expect(accessTokenResponse.status).toBe(200);
          const accessToken = (await accessTokenResponse.json()) as { access_token: string };
          const cookieRenewalResponse = await environmentA.handler(
            postJson(
              "/api/auth/renew",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(cookieRenewalResponse.status).toBe(401);
          const renewalResponse = await environmentA.handler(
            postJson(
              "/api/auth/renew",
              { scopes: ["orchestration:read"] },
              { authorization: `Bearer ${accessToken.access_token}` },
            ),
            requestContext,
          );
          expect(renewalResponse.status).toBe(200);
          expect(renewalResponse.headers.get("cache-control")).toBe("no-store");
          const renewed = (await renewalResponse.json()) as {
            access_token: string;
            token_type: string;
            expires_in: number;
            scope: string;
          };
          expect(renewed.token_type).toBe("Bearer");
          expect(renewed.scope).toBe("orchestration:read");
          expect(renewed.expires_in).toBeGreaterThan(30 * 24 * 60 * 60 - 2);
          expect(renewed.access_token).not.toBe(accessToken.access_token);

          const oldSessionResponse = await environmentA.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { authorization: `Bearer ${accessToken.access_token}` },
            }),
            requestContext,
          );
          expect(oldSessionResponse.status).toBe(200);
          expect(await oldSessionResponse.json()).toMatchObject({ authenticated: true });

          const widenedResponse = await environmentA.handler(
            postJson(
              "/api/auth/renew",
              { scopes: ["access:write"] },
              { authorization: `Bearer ${accessToken.access_token}` },
            ),
            requestContext,
          );
          expect(widenedResponse.status).toBe(400);
          expect(await widenedResponse.text()).not.toContain(accessToken.access_token);
          const emptyScopesResponse = await environmentA.handler(
            postJson(
              "/api/auth/renew",
              { scopes: [] },
              { authorization: "Bearer " + accessToken.access_token },
            ),
            requestContext,
          );
          expect(emptyScopesResponse.status).toBe(400);
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
