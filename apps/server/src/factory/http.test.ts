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
import { factoryHttpRouteLayer } from "./http.ts";

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
      const factoryUiDir = yield* fs.makeTempDirectoryScoped({ prefix: "empty-factory-ui-" });
      const result = yield* HttpRouter.toHttpEffect(factoryHttpRouteLayer).pipe(
        Effect.provide(ServerConfig.layer({ ...config, factoryEnabled: true, factoryUiDir })),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({ _tag: "FactoryUiError" });
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
