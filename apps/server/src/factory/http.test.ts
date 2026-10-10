import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
// @effect-diagnostics nodeBuiltinImport:off - the cancellation proof uses a test-owned native HTTP listener.
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttp from "node:http";
import { attachmentUploadRouteLayer } from "../http.ts";
import { issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import { FactoryRegistrationId, EnvironmentId, AuthSessionId } from "@t3tools/contracts";
import * as Connections from "./Connections.ts";
import * as RelayPolicy from "./RelayPolicy.ts";
import * as SourceShell from "./SourceShell.ts";
import * as HttpRelay from "./HttpRelay.ts";
import * as FactoryRuntime from "./runtimeLayer.ts";
import * as NodeSource from "./NodeSource.ts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Socket from "effect/unstable/socket/Socket";
import { config as sourceConfig } from "./testkit/sourceConfig.ts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpRouter } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { staticAndDevRouteLayer } from "../http.ts";
import { factoryHttpRouteLayer, factorySourceHttpRouteLayer } from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-http-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("factory HTTP hosting", (it) => {
  it.effect("returns the canonical localhost pairing page from a Vite proxy request", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const staticDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-factory-assets-" })),
      );
      const appLayer = Layer.merge(factoryHttpRouteLayer, staticAndDevRouteLayer).pipe(
        Layer.provideMerge(
          ServerConfig.layer({
            ...config,
            factoryEnabled: true,
            port: 3773,
            devUrl: new URL("http://localhost:5733"),
            staticDir,
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });

      yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
      const response = yield* Effect.promise(() =>
        handler(
          new Request("http://localhost:3773/factory/bootstrap", {
            headers: { host: "localhost:3773" },
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        pairingUrl: "http://localhost:3773/pair",
      });
    }),
  );

  it.effect("mounts the opted-in Factory build without replacing T3 or reserved routes", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-static-" });
      const factoryUiDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-static-" });
      yield* fs.writeFileString(`${staticDir}/index.html`, "T3 application");
      yield* fs.makeDirectory(`${staticDir}/assets`);
      yield* fs.writeFileString(`${staticDir}/assets/t3.js`, "T3 script");
      yield* fs.writeFileString(
        `${factoryUiDir}/index.html`,
        '<script src="/factory/assets/main.js"></script>Factory application',
      );
      yield* fs.makeDirectory(`${factoryUiDir}/assets`);
      yield* fs.writeFileString(`${factoryUiDir}/assets/main.js`, "Factory script");
      for (const devUrl of [undefined, new URL("http://localhost:5733")]) {
        const { handler, dispose } = HttpRouter.toWebHandler(
          Layer.merge(factoryHttpRouteLayer, staticAndDevRouteLayer).pipe(
            Layer.provideMerge(
              ServerConfig.layer({
                ...config,
                factoryEnabled: true,
                staticDir,
                factoryUiDir,
                devUrl,
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
        for (const [path, content] of [
          ["/", "T3 application"],
          ["/pair", "T3 application"],
          ["/assets/t3.js", "T3 script"],
          ["/factory", "Factory application"],
          ["/factory/", "Factory application"],
          ["/factory/projects/project", "Factory application"],
          ["/factory/assets/main.js", "Factory script"],
        ]) {
          const response = yield* Effect.promise(() =>
            handler(
              new Request(`http://192.168.1.42:3773${path}`, {
                headers: { host: "192.168.1.42:3773" },
              }),
            ),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.text())).toContain(content);
        }
        for (const path of [
          "/factory/assets/missing.js",
          "/factory/env",
          "/factory/env/source/chat",
          "/factory/bootstrap/missing",
        ]) {
          const response = yield* Effect.promise(() =>
            handler(
              new Request(`http://192.168.1.42:3773${path}`, {
                headers: { host: "192.168.1.42:3773" },
              }),
            ),
          );
          expect(response.status).toBe(404);
        }
      }
    }),
  );

  it.effect("preserves LAN and forwarded browser hosts and canonical pairing ports", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      for (const [devUrl, headers, expected] of [
        [
          new URL("http://localhost:5733"),
          { host: "192.168.1.42:3773" },
          "http://192.168.1.42:3773/pair",
        ],
        [
          new URL("http://localhost:5733"),
          {
            host: "localhost:3773",
            "x-forwarded-host": "192.168.1.42:3000",
            "x-forwarded-proto": "http",
          },
          "http://192.168.1.42:3773/pair",
        ],
        [
          new URL("http://localhost:5733"),
          {
            host: "localhost:3773",
            "x-forwarded-host": "localhost:3000",
            "x-forwarded-proto": "http",
          },
          "http://localhost:3773/pair",
        ],
        [
          undefined,
          {
            host: "localhost:3773",
            "x-forwarded-host": "factory.example.test",
            "x-forwarded-proto": "https",
          },
          "https://factory.example.test/pair",
        ],
      ] as const) {
        const { handler, dispose } = HttpRouter.toWebHandler(
          factoryHttpRouteLayer.pipe(
            Layer.provideMerge(
              ServerConfig.layer({ ...config, factoryEnabled: true, port: 3773, devUrl }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost:3773/factory/bootstrap", { headers })),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({ pairingUrl: expected });
      }
    }),
  );

  it.effect("fails startup with a typed error for a configured directory without a build", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "invalid-factory-ui-" });
      yield* fs.makeDirectory(`${root}/empty-index`);
      yield* fs.writeFileString(`${root}/empty-index/index.html`, "");
      yield* fs.writeFileString(`${root}/not-a-directory`, "Factory");
      for (const factoryUiDir of [
        root,
        `${root}/missing`,
        `${root}/not-a-directory`,
        `${root}/empty-index`,
      ]) {
        const result = yield* HttpRouter.toHttpEffect(factoryHttpRouteLayer).pipe(
          Effect.provide(ServerConfig.layer({ ...config, factoryEnabled: true, factoryUiDir })),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toMatchObject({ _tag: "FactoryUiError" });
      }
    }),
  );

  it.effect("never falls back to T3 when Factory UI is absent or disabled", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "no-factory-ui-" });
      yield* fs.writeFileString(`${staticDir}/index.html`, "T3 application");
      for (const factoryEnabled of [false, true]) {
        const { handler, dispose } = HttpRouter.toWebHandler(
          Layer.merge(factoryHttpRouteLayer, staticAndDevRouteLayer).pipe(
            Layer.provideMerge(
              ServerConfig.layer({
                ...config,
                staticDir,
                factoryEnabled,
                ...(factoryEnabled ? {} : { factoryUiDir: "/missing/disabled-ui" }),
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost:3773/factory/assets/main.js")),
        );
        expect(response.status).toBe(factoryEnabled ? 503 : 404);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: factoryEnabled ? "FactoryUiError" : "FactoryError",
        });
      }
    }),
  );

  it.effect("keeps fresh browser auth on its API and serves the T3 pairing bundle", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-pair-page-" });
      yield* fs.writeFileString(
        `${staticDir}/index.html`,
        '<script src="/assets/pair.js"></script>T3 pairing application',
      );
      yield* fs.makeDirectory(`${staticDir}/assets`);
      yield* fs.writeFileString(`${staticDir}/assets/pair.js`, "T3 pairing script");
      const authConfig = ServerConfig.layer({
        ...config,
        factoryEnabled: true,
        devUrl: new URL("http://localhost:5733"),
        staticDir,
      });
      const environmentAuthLayer = EnvironmentAuth.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.identityLayer),
        Layer.provide(authConfig),
      );
      const authRoutesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
        Layer.provide(authHttpApiLayer),
        Layer.provide(environmentAuthenticatedAuthLayer),
        Layer.provideMerge(environmentAuthLayer),
        Layer.provide(authConfig),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );
      const appLayer = Layer.merge(authRoutesLayer, staticAndDevRouteLayer).pipe(
        Layer.provideMerge(authConfig),
        Layer.provideMerge(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
      const crypto = yield* Crypto.Crypto;
      const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("Not used by this route."),
        remove: () => Effect.void,
      });
      const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
        Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      );
      const unauthenticated = yield* Effect.promise(() =>
        handler(new Request("http://localhost:3773/api/auth/session"), requestContext),
      );
      expect(unauthenticated.status).toBe(200);
      expect(yield* Effect.promise(() => unauthenticated.json())).toMatchObject({
        authenticated: false,
      });

      const pairingPage = yield* Effect.promise(() =>
        handler(new Request("http://localhost:3773/pair?token=one-time-token"), requestContext),
      );
      expect(pairingPage.status).toBe(200);
      expect(pairingPage.headers.get("location")).toBeNull();
      expect(yield* Effect.promise(() => pairingPage.text())).toContain("T3 pairing application");
      const pairingScript = yield* Effect.promise(() =>
        handler(new Request("http://localhost:3773/assets/pair.js"), requestContext),
      );
      expect(pairingScript.status).toBe(200);
      expect(pairingScript.headers.get("location")).toBeNull();
      expect(yield* Effect.promise(() => pairingScript.text())).toBe("T3 pairing script");
    }),
  );

  it.effect("does not advertise bootstrap when factory mode is disabled", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const appLayer = factoryHttpRouteLayer.pipe(
        Layer.provideMerge(ServerConfig.layer({ ...config, factoryEnabled: false })),
        Layer.provideMerge(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });

      yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost:3773/factory/bootstrap")),
      );
      expect(response.status).toBe(404);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "feature-disabled",
      });
    }),
  );
});

const relayHarness = Effect.fnUntraced(function* (
  options: {
    response?: Response;
    scopes?: readonly ("factory:read" | "factory:control")[];
    fresh?: boolean;
    uploads?: boolean;
    closed?: Connections.SourceAccess["closed"];
    connectHttp?: NonNullable<Connections.SourceTransport["Service"]["connectHttp"]>;
    endpoint?: string;
  } = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const upstream: { url: string; headers: Readonly<Record<string, string>>; method: string }[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      upstream.push({ url: request.url, headers: request.headers, method: request.method });
      return HttpClientResponse.fromWeb(
        request,
        options.response ??
          new Response(request.url, {
            headers: { "set-cookie": "source=secret", "content-type": "text/plain" },
          }),
      );
    }),
  );
  const transportServices = yield* Layer.build(
    NodeSource.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(Socket.WebSocketConstructor, () => {
            throw new Error("No socket for HTTP.");
          }),
        ),
      ),
    ),
  );
  const transport = Context.get(transportServices, Connections.SourceTransport);
  const now = yield* DateTime.now;
  const credential = {
    token: "source-owned-secret",
    sourceSessionId: AuthSessionId.make("source"),
    scopes: ["orchestration:read", "orchestration:operate"] as const,
    issuedAt: now,
    expiresAt: DateTime.add(now, { days: 1 }),
  };
  const source = (registrationId: string): Connections.SourceAccess => ({
    target: {
      registrationId: FactoryRegistrationId.make(registrationId),
      environmentId: EnvironmentId.make(`env-${registrationId}`),
    },
    connectionId: {},
    config: {
      ...sourceConfig(`env-${registrationId}`),
      environment: {
        ...sourceConfig(`env-${registrationId}`).environment,
        capabilities: { repositoryIdentity: false, attachmentUploads: options.uploads ?? true },
      },
    },
    sourceScopes: credential.scopes,
    checkCurrent: Effect.void,
    shell: () => Stream.empty,
    closed: options.closed ?? Effect.never,
    checkShellCurrent: Effect.void,
    shellSynchronized: Effect.void,
  });
  const connections = Layer.mock(Connections.Connections)({
    resolveTarget: (target) =>
      target.environmentId === `env-${target.registrationId}`
        ? Effect.succeed(source(target.registrationId))
        : Effect.fail(new Connections.SourceFailure({ reason: "identity" })),
    openHttp: (access) =>
      (options.connectHttp ?? transport.connectHttp!)({
        environment: {
          ...access.target,
          endpoint: options.endpoint ?? `https://${access.target.registrationId}.source.test`,
          label: "Source",
          platform: null,
          enabled: true,
          state: "online",
          credentialStorage: "secure-vault",
          credentialExpiresAt: null,
          renewal: "unsupported",
          lastSeenAt: null,
          revision: 1,
        },
        credential,
      }),
  });
  const dependencies = Layer.mergeAll(
    connections,
    Layer.mock(SourceShell.SourceShell)({
      isSynchronized: () => Effect.succeed(options.fresh ?? true),
    }),
    ServerConfig.layer({ ...config, factoryEnabled: true }),
  );
  const services = yield* Layer.build(
    HttpRelay.layer.pipe(
      Layer.provideMerge(RelayPolicy.layer.pipe(Layer.provideMerge(dependencies))),
    ),
  );
  const runtime = Layer.mock(FactoryRuntime.FactoryRuntime)({
    enabled: true,
    getHttpRelay: Effect.succeed(Context.get(services, HttpRelay.HttpRelay)),
  });
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) =>
      request.cookies.factory_session === "fixture"
        ? Effect.succeed({
            sessionId: AuthSessionId.make("browser"),
            subject: "test",
            method: "browser-session-cookie",
            scopes: options.scopes ?? ["factory:read", "factory:control"],
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    factorySourceHttpRouteLayer.pipe(
      Layer.provideMerge(Layer.mergeAll(runtime, auth, dependencies)),
      Layer.provideMerge(NodeServices.layer),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const request = (path: string, init?: RequestInit) =>
    Effect.promise(() =>
      handler(
        new Request(`https://factory.test${path}`, {
          ...init,
          headers: {
            cookie: "factory_session=fixture",
            "x-t3-orchestration-protocol": "2",
            ...init?.headers,
          },
        }),
      ),
    );
  return { request, upstream, relay: Context.get(services, HttpRelay.HttpRelay) };
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-relay-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("detail HTTP relay", (it) => {
  it.effect.each([
    ["text/html", "file.html", undefined],
    [
      "text/html",
      "file.html",
      "default-src * 'unsafe-inline'; sandbox allow-scripts allow-same-origin",
    ],
    ["image/svg+xml", "file.svg", undefined],
    [
      "image/svg+xml",
      "file.svg",
      "default-src * 'unsafe-inline'; sandbox allow-scripts allow-same-origin",
    ],
  ] as const)(
    "sandboxes relayed %s regardless of upstream CSP",
    ([contentType, fileName, upstreamCsp]) =>
      Effect.gen(function* () {
        for (const method of ["GET", "HEAD"] as const) {
          for (const ranged of [false, true]) {
            const body = contentType === "text/html" ? "<script>1</script>" : "<svg/>";
            const h = yield* relayHarness({
              scopes: ["factory:read"],
              response: new Response(method === "HEAD" ? null : body, {
                status: ranged ? 206 : 200,
                headers: {
                  "content-type": contentType,
                  "content-length": String(body.length),
                  "content-disposition": `inline; filename="${fileName}"`,
                  "accept-ranges": "bytes",
                  ...(ranged
                    ? { "content-range": `bytes 0-${body.length - 1}/${body.length}` }
                    : {}),
                  ...(upstreamCsp === undefined ? {} : { "content-security-policy": upstreamCsp }),
                  "set-cookie": "source=secret",
                },
              }),
            });
            const response = yield* h.request(
              `/factory/env/a/api/assets/signed/${fileName}?environmentId=env-a`,
              {
                method,
                headers: ranged ? { range: "bytes=0-" } : {},
              },
            );
            expect(response.status).toBe(ranged ? 206 : 200);
            expect(response.headers.get("content-security-policy")).toBe(
              "default-src 'none'; sandbox",
            );
            expect(response.headers.get("content-type")).toBe(contentType);
            expect(response.headers.get("content-disposition")).toBe(
              `inline; filename="${fileName}"`,
            );
            expect(response.headers.get("cache-control")).toBe("private, no-store");
            expect(response.headers.get("x-content-type-options")).toBe("nosniff");
            expect(response.headers.get("set-cookie")).toBeNull();
            if (ranged)
              expect(response.headers.get("content-range")).toBe(
                `bytes 0-${body.length - 1}/${body.length}`,
              );
            if (method === "HEAD")
              expect(response.headers.get("content-length")).toBe(String(body.length));
            expect(yield* Effect.promise(() => response.text())).toBe(
              method === "HEAD" ? "" : body,
            );
          }
        }
      }),
  );
  it.effect.each([
    ["GET", "api/projects", 200, "application/json", '{"projects":[]}'],
    ["GET", "api/assets/signed/file.png", 200, "image/png", "image bytes"],
    ["POST", "api/attachments/upload/grant", 204, "application/json", null],
  ] as const)(
    "sandboxes every admitted %s response for %s",
    ([method, path, status, contentType, body]) =>
      Effect.gen(function* () {
        const h = yield* relayHarness({
          response: new Response(body, { status, headers: { "content-type": contentType } }),
        });
        const response = yield* h.request(`/factory/env/a/${path}?environmentId=env-a`, {
          method,
          ...(method === "POST" ? { body: "upload" } : {}),
        });
        expect(response.status).toBe(status);
        expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
        expect(yield* Effect.promise(() => response.text())).toBe(body ?? "");
      }),
  );

  it.effect("keeps two simultaneous prefixes separate and removes browser and source cookies", () =>
    Effect.gen(function* () {
      const h = yield* relayHarness();
      const responses = yield* Effect.all(
        ["a", "b"].map((id) =>
          h
            .request(`/factory/env/${id}/api/projects?environmentId=env-${id}`)
            .pipe(Effect.map((response) => ({ id, response }))),
        ),
        { concurrency: 2 },
      );
      for (const { id, response } of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(yield* Effect.promise(() => response.text())).toBe(
          `https://${id}.source.test/api/projects`,
        );
      }
      expect(h.upstream.map((r) => r.headers.authorization)).toEqual([
        "Bearer source-owned-secret",
        "Bearer source-owned-secret",
      ]);
      expect(h.upstream.every((r) => r.headers.cookie === undefined)).toBe(true);
    }),
  );
  it.effect(
    "rejects forbidden routes, target switches, extra query, browser auth and protocol mismatch",
    () =>
      Effect.gen(function* () {
        const h = yield* relayHarness();
        for (const [path, headers, status] of [
          ["api/auth/session?environmentId=env-a", {}, 403],
          ["api/projects?environmentId=wrong", {}, 403],
          ["api/projects?environmentId=env-a&extra=1", {}, 400],
          ["api/projects?environmentId=env-a&environmentId=env-a", {}, 400],
          ["api/projects", {}, 400],
          ["api/projects?environmentId=env-a", { authorization: "Bearer browser" }, 400],
          ["api/projects?environmentId=env-a", { cookie: "" }, 401],
          [
            "api/orchestration/threads/t/bounded?environmentId=env-a",
            { "x-t3-orchestration-protocol": "1" },
            426,
          ],
          ["api/orchestration/threads/t/history?environmentId=env-a&cursor=invalid", {}, 400],
          ["api/assets/signed/%252e%252e/file.png?environmentId=env-a", {}, 400],
        ] as const) {
          expect((yield* h.request(`/factory/env/a/${path}`, { headers })).status).toBe(status);
        }
        expect(h.upstream).toHaveLength(0);
      }),
  );
  it.effect("rejects foreign origins, unsupported methods and declared oversized bodies", () =>
    Effect.gen(function* () {
      const h = yield* relayHarness();
      expect(
        (yield* h.request("/factory/env/a/api/projects?environmentId=env-a", {
          headers: { origin: "https://other.test" },
        })).status,
      ).toBe(403);
      expect(
        (yield* h.request("/factory/env/a/api/projects?environmentId=env-a", { method: "POST" }))
          .status,
      ).toBe(403);
      expect(
        (yield* h.request("/factory/env/a/api/attachments/upload/grant?environmentId=env-a", {
          method: "POST",
          headers: { "content-length": String(HttpRelay.HTTP_RELAY_UPLOAD_LIMIT + 1) },
        })).status,
      ).toBe(413);
      expect(h.upstream).toHaveLength(0);
      const source = yield* relayHarness({
        response: new Response("oversized", {
          headers: { "content-length": String(HttpRelay.HTTP_RELAY_DETAIL_LIMIT + 1) },
        }),
      });
      expect(
        (yield* source.request("/factory/env/a/api/projects?environmentId=env-a")).status,
      ).toBe(502);
    }),
  );
  it.effect("preserves native missing, expiry and range responses but refuses redirects", () =>
    Effect.gen(function* () {
      for (const status of [404, 403, 206, 416, 302]) {
        const h = yield* relayHarness({
          response: new Response(status === 206 ? "part" : "missing", {
            status,
            headers: {
              "content-range": "bytes 1-4/10",
              location: "https://unsafe.test",
              "set-cookie": "source=secret",
              "content-type": "image/png",
            },
          }),
        });
        const response = yield* h.request(
          "/factory/env/a/api/assets/signed/file.png?environmentId=env-a",
          { headers: { range: "bytes=1-4" } },
        );
        expect(response.status).toBe(status === 302 ? 502 : status);
        if (status !== 302)
          expect(response.headers.get("content-security-policy")).toBe(
            "default-src 'none'; sandbox",
          );
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        if (status === 206) {
          expect(response.headers.get("content-range")).toBe("bytes 1-4/10");
          expect(yield* Effect.promise(() => response.text())).toBe("part");
        }
        expect(h.upstream[0]?.headers.range).toBe("bytes=1-4");
      }
    }),
  );
  it.effect("requires fresh control and upload capability through the shared policy", () =>
    Effect.gen(function* () {
      for (const options of [
        { scopes: ["factory:read"] as const },
        { fresh: false },
        { uploads: false },
      ]) {
        const h = yield* relayHarness(options);
        const response = yield* h.request(
          "/factory/env/a/api/attachments/upload/payload.signature?environmentId=env-a",
          { method: "POST", body: "bytes" },
        );
        expect(response.status).toBe(403);
        expect(h.upstream).toHaveLength(0);
      }
    }),
  );
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-stream-expiry-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("source HTTP streaming lease", (it) => {
  it.effect("cancels the upstream body when its source lease closes", () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<never, Connections.SourceFailure>();
      const cancelled = yield* Deferred.make<void>();
      const stream = Stream.concat(
        Stream.succeed(new TextEncoder().encode("first")),
        Stream.fromEffect(Effect.never),
      ).pipe(Stream.ensuring(Deferred.succeed(cancelled, undefined)));
      const body = yield* Stream.toReadableStreamEffect(stream);
      const h = yield* relayHarness({
        response: new Response(body),
        closed: Deferred.await(closed),
      });
      const response = yield* h.request(
        "/factory/env/a/api/assets/grant/file.png?environmentId=env-a",
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe(
        "first",
      );
      yield* Deferred.fail(closed, new Connections.SourceFailure({ reason: "authentication" }));
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: () => "stream-failed" as const,
      }).pipe(Effect.result);
      expect(next).toMatchObject({ _tag: "Failure", failure: "stream-failed" });
      yield* Deferred.await(cancelled);
    }),
  );
});

it.effect("does not acquire auth or runtime for a disabled HTTP relay", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const appLayer = factorySourceHttpRouteLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ServerConfig.layer({ ...config, factoryEnabled: false }),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: () => Effect.die("Disabled route acquired auth."),
          }),
          Layer.mock(FactoryRuntime.FactoryRuntime)({
            enabled: false,
            getHttpRelay: Effect.die("Disabled route acquired runtime."),
          }),
        ),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://factory.test/factory/env/a/api/projects?environmentId=environment-a"),
        Context.empty(),
      ),
    );
    expect(response.status).toBe(404);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-off-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect.each([
  { direction: "upload", limit: HttpRelay.HTTP_RELAY_UPLOAD_LIMIT },
  { direction: "response", limit: HttpRelay.HTTP_RELAY_DETAIL_LIMIT },
  { direction: "response", limit: HttpRelay.HTTP_RELAY_ASSET_LIMIT },
] as const)(
  "streams $direction bytes up to $limit and rejects the next byte before forwarding",
  ({ direction, limit }) =>
    Effect.gen(function* () {
      const chunk = new Uint8Array(64 * 1024);
      const body = Stream.fromIterable(Array.from({ length: limit / chunk.length }, () => chunk));
      const consume = (stream: Stream.Stream<Uint8Array, HttpRelay.HttpRelayError>) =>
        Stream.runFold(
          stream,
          () => 0,
          (total, item) => total + item.length,
        );
      expect(yield* consume(HttpRelay.boundRelayBody(body, limit, direction))).toBe(limit);
      let delivered = 0;
      const rejected = yield* HttpRelay.boundRelayBody(
        Stream.concat(body, Stream.succeed(new Uint8Array(1))),
        limit,
        direction,
      ).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            delivered += item.length;
          }),
        ),
        Stream.runDrain,
        Effect.result,
      );
      expect(rejected).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "HttpRelayError",
          reason: direction === "upload" ? "upload-too-large" : "response-too-large",
          status: direction === "upload" ? 413 : 502,
        },
      });
      expect(delivered).toBe(limit);
    }),
);

it.effect("pulls relay bytes only on demand and cancels the pending producer", () =>
  Effect.gen(function* () {
    let pulls = 0;
    const cancelled = yield* Deferred.make<void>();
    const body = Stream.fromEffect(
      Effect.sync(() => {
        pulls++;
        return new Uint8Array(1);
      }),
    ).pipe(
      Stream.concat(Stream.fromEffect(Effect.never)),
      Stream.ensuring(Deferred.succeed(cancelled, undefined)),
    );
    const bounded = HttpRelay.boundRelayBody(body, 1, "upload");
    expect(pulls).toBe(0);
    const pulled = yield* Deferred.make<void>();
    const consumer = yield* bounded.pipe(
      Stream.tap(() => Deferred.succeed(pulled, undefined)),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Deferred.await(pulled);
    expect(pulls).toBe(1);
    yield* Fiber.interrupt(consumer);
    yield* Deferred.await(cancelled);
  }),
);

it.live(
  "disconnects an upload through the relay and removes the native source partial file",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const partWritten = yield* Deferred.make<void>();
      const partRemoved = yield* Deferred.make<void>();
      const observedFs: FileSystem.FileSystem = {
        ...fs,
        sink: (path, options) =>
          fs
            .sink(path, options)
            .pipe(
              Sink.mapInputEffect((chunk: Uint8Array) =>
                path.endsWith(".part")
                  ? Deferred.succeed(partWritten, undefined).pipe(Effect.as(chunk))
                  : Effect.succeed(chunk),
              ),
            ),
        remove: (path, options) =>
          fs
            .remove(path, options)
            .pipe(
              Effect.tap(() =>
                path.endsWith(".part") ? Deferred.succeed(partRemoved, undefined) : Effect.void,
              ),
            ),
      };
      const config = yield* ServerConfig.ServerConfig;
      const secrets = yield* Layer.build(ServerSecretStore.layer);
      const platform = yield* Layer.build(NodeServices.layer);
      const sourceServices = Context.merge(platform, secrets).pipe(
        Context.add(ServerConfig.ServerConfig, config),
        Context.add(FileSystem.FileSystem, observedFs),
      );
      const upload = yield* issueAttachmentUploadUrl({
        type: "file",
        name: "disconnect.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }).pipe(Effect.provide(sourceServices));
      const listener = NodeHttpServer.layer(() => NodeHttp.createServer(), {
        host: "127.0.0.1",
        port: 0,
      });
      const source = yield* Layer.build(
        HttpRouter.serve(
          attachmentUploadRouteLayer.pipe(Layer.provideMerge(Layer.succeedContext(sourceServices))),
          { disableLogger: true },
        ).pipe(
          Layer.provideMerge(listener),
          Layer.provideMerge(Layer.succeedContext(sourceServices)),
        ),
      );
      const address = Context.get(source, HttpServer.HttpServer).address;
      if (typeof address === "string" || !("port" in address))
        return yield* Effect.die("No isolated HTTP source.");
      const nodeSource = yield* Layer.build(NodeSource.nodeLayer);
      const transport = Context.get(nodeSource, Connections.SourceTransport);
      const h = yield* relayHarness({
        endpoint: `http://127.0.0.1:${address.port}`,
        connectHttp: transport.connectHttp!,
      });
      const producerCancelled = yield* Deferred.make<void>();
      const body = Stream.concat(
        Stream.succeed(new Uint8Array([1, 2, 3])),
        Stream.fromEffect(Effect.never),
      ).pipe(Stream.ensuring(Deferred.succeed(producerCancelled, undefined)));
      const readable = Stream.toReadableStream(body);
      const controller = new AbortController();
      const init = {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: readable,
        signal: controller.signal,
        duplex: "half" as const,
      };
      const response = yield* h
        .request(`/factory/env/a${upload.relativeUrl}?environmentId=env-a`, init)
        .pipe(Effect.forkScoped);
      yield* Effect.raceFirst(
        Deferred.await(partWritten),
        Fiber.join(response).pipe(
          Effect.flatMap((reply) => Effect.die(`Upload returned before a chunk: ${reply.status}`)),
        ),
      );
      controller.abort();
      yield* Deferred.await(partRemoved);
      yield* Deferred.await(producerCancelled);
      yield* Fiber.interrupt(response);
      expect(yield* fs.readDirectory(config.attachmentsDir)).toEqual([]);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-upload-cancel-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  { timeout: 15_000 },
);

const drainHttpUpload: NonNullable<Connections.SourceTransport["Service"]["connectHttp"]> = () =>
  Effect.succeed({
    execute: (request) =>
      request.body._tag === "Stream"
        ? request.body.stream.pipe(
            Stream.mapError(() => new Connections.SourceFailure({ reason: "transport" })),
            Stream.runDrain,
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
          )
        : Effect.die("Expected streaming upload."),
  });

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-slow-upload-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("upload timing", (it) => {
  it.effect("keeps a progressing upload alive beyond the header deadline", () =>
    Effect.gen(function* () {
      const gates = yield* Effect.all([
        Deferred.make<void>(),
        Deferred.make<void>(),
        Deferred.make<void>(),
      ]);
      const demanded = yield* Effect.all([
        Deferred.make<void>(),
        Deferred.make<void>(),
        Deferred.make<void>(),
      ]);
      const body = Stream.fromIterable([0, 1, 2]).pipe(
        Stream.flatMap((index) =>
          Stream.fromEffect(
            Deferred.succeed(demanded[index]!, undefined).pipe(
              Effect.andThen(Deferred.await(gates[index]!)),
              Effect.as(new Uint8Array(1)),
            ),
          ),
        ),
      );
      const readable = yield* Stream.toReadableStreamEffect(body);
      const h = yield* relayHarness({ connectHttp: drainHttpUpload });
      const init = { method: "POST", body: readable, duplex: "half" as const };
      const request = HttpServerRequest.fromWeb(
        new Request(
          "https://factory.test/factory/env/a/api/attachments/upload/grant?environmentId=env-a",
          init,
        ),
      );
      const upload = yield* h.relay
        .forward({
          request,
          target: {
            registrationId: FactoryRegistrationId.make("a"),
            environmentId: EnvironmentId.make("env-a"),
          },
          callerScopes: ["factory:control"],
        })
        .pipe(Effect.forkScoped);
      for (let index = 0; index < 3; index++) {
        yield* Deferred.await(demanded[index]!);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.succeed(gates[index]!, undefined);
      }
      expect((yield* Fiber.join(upload)).status).toBe(204);
    }),
  );
  it.effect("fails a stalled upload with an explicit timeout and cancels its producer", () =>
    Effect.gen(function* () {
      const demanded = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const body = Stream.fromEffect(
        Deferred.succeed(demanded, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Stream.ensuring(Deferred.succeed(cancelled, undefined)));
      const readable = yield* Stream.toReadableStreamEffect(body);
      const h = yield* relayHarness({ connectHttp: drainHttpUpload });
      const request = HttpServerRequest.fromWeb(
        new Request(
          "https://factory.test/factory/env/a/api/attachments/upload/grant?environmentId=env-a",
          { method: "POST", body: readable, duplex: "half" },
        ),
      );
      const upload = yield* h.relay
        .forward({
          request,
          target: {
            registrationId: FactoryRegistrationId.make("a"),
            environmentId: EnvironmentId.make("env-a"),
          },
          callerScopes: ["factory:control"],
        })
        .pipe(Effect.scoped, Effect.result, Effect.forkScoped);
      yield* Deferred.await(demanded);
      yield* TestClock.adjust("21 seconds");
      expect(yield* Fiber.join(upload)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "HttpRelayError", reason: "transport", status: 504 },
      });
      yield* Deferred.await(cancelled);
    }),
  );
});
