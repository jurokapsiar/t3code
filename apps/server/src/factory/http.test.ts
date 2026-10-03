import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

  it.effect("serves the existing T3 bundle for factory hosting on the same origin", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-static-" });
      yield* fs.writeFileString(`${staticDir}/index.html`, "T3 embedded application");
      const appLayer = Layer.merge(factoryHttpRouteLayer, staticAndDevRouteLayer).pipe(
        Layer.provideMerge(ServerConfig.layer({ ...config, factoryEnabled: true, staticDir })),
        Layer.provideMerge(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));

      for (const path of ["/", "/factory"]) {
        const response = yield* Effect.promise(() =>
          handler(new Request(`http://localhost:3773${path}`)),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toContain("T3 embedded application");
      }
    }),
  );

  it.effect("keeps fresh browser auth on its API and serves the T3 pairing bundle", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-pair-page-" });
      yield* fs.writeFileString(`${staticDir}/index.html`, "T3 pairing application");
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
