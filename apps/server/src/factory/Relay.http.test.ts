import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as Connections from "./Connections.ts";
import { config as sourceConfig } from "./testkit/sourceConfig.ts";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpRouter } from "effect/unstable/http";
import { AuthSessionId, EnvironmentId, FactoryRegistrationId } from "@t3tools/contracts";
import * as Config from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as FactoryRuntime from "./runtimeLayer.ts";
import * as RelayPolicy from "./RelayPolicy.ts";
import { factoryWebSocketRouteLayer } from "./http.ts";

it.layer(
  Config.layerTest(process.cwd(), { prefix: "t3-relay-http-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("relay upgrade boundary", (it) => {
  it.effect("requires explicit protocol, cookie authentication and an exact composite target", () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      let calls = 0;
      const policy = Layer.mock(RelayPolicy.RelayPolicy)({
        authorize: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(
            Effect.andThen(Effect.fail(new RelayPolicy.RelayDenied({ reason: "target-mismatch" }))),
          ),
      });
      const runtime = Layer.mock(FactoryRuntime.FactoryRuntime)({
        enabled: true,
        getRelayPolicy: RelayPolicy.RelayPolicy.pipe(Effect.provide(policy)),
      });
      const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: (request) =>
          request.cookies.factory_session === "fixture"
            ? Effect.succeed({
                sessionId: AuthSessionId.make("browser"),
                subject: "test",
                method: "browser-session-cookie",
                scopes: ["factory:read"],
              })
            : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
      });
      const { handler, dispose } = HttpRouter.toWebHandler(
        factoryWebSocketRouteLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(runtime, auth, Config.layer({ ...config, factoryEnabled: true })),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      for (const [suffix, headers, status] of [
        ["?environmentId=env-a", { cookie: "factory_session=fixture" }, 426],
        [
          "?orchestrationProtocol=1&environmentId=env-a",
          { cookie: "factory_session=fixture" },
          426,
        ],
        ["?orchestrationProtocol=2", { cookie: "factory_session=fixture" }, 400],
        ["?orchestrationProtocol=2&environmentId=env-a", {}, 401],
        [
          "?orchestrationProtocol=2&environmentId=env-a",
          { cookie: "factory_session=fixture", authorization: "Bearer injected" },
          400,
        ],
        [
          "?orchestrationProtocol=2&environmentId=env-a&wsTicket=injected",
          { cookie: "factory_session=fixture" },
          400,
        ],
        [
          "?orchestrationProtocol=2&environmentId=env-a&environmentId=other",
          { cookie: "factory_session=fixture" },
          400,
        ],
        [
          "?orchestrationProtocol=2&environmentId=env-a",
          { cookie: "factory_session=fixture", origin: "https://evil.example" },
          403,
        ],
        [
          "?orchestrationProtocol=2&environmentId=env-a",
          { cookie: "factory_session=fixture" },
          403,
        ],
      ] as const) {
        const response = yield* Effect.promise(() =>
          handler(new Request("http://factory.example/factory/env/a/ws" + suffix, { headers })),
        );
        expect(response.status).toBe(status);
      }
      expect(calls).toBe(1);
    }),
  );
  it.effect(
    "reports an internal cookie validation failure separately from missing authentication",
    () =>
      Effect.gen(function* () {
        const config = yield* Config.ServerConfig;
        const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: () =>
            Effect.fail(
              new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
                cause: "private fixture cause",
              }),
            ),
        });
        const { handler, dispose } = HttpRouter.toWebHandler(
          factoryWebSocketRouteLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                auth,
                Layer.mock(FactoryRuntime.FactoryRuntime)({ enabled: true }),
                Config.layer({ ...config, factoryEnabled: true }),
              ),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(dispose));
        const response = yield* Effect.promise(() =>
          handler(
            new Request(
              "http://factory.example/factory/env/a/ws?orchestrationProtocol=2&environmentId=env-a",
              { headers: { cookie: "factory_session=fixture" } },
            ),
          ),
        );
        expect(response.status).toBe(500);
        expect(yield* Effect.promise(() => response.text())).toBe("Authentication unavailable.");
      }),
  );
  it.effect("returns a failed HTTP upgrade when the upstream credential is rejected", () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const access: Connections.SourceAccess = {
        target: {
          registrationId: FactoryRegistrationId.make("a"),
          environmentId: EnvironmentId.make("env-a"),
        },
        connectionId: {},
        config: sourceConfig(),
        sourceScopes: ["orchestration:read"],
        checkCurrent: Effect.void,
        closed: Effect.never,
        shell: () => Stream.never,
        checkShellCurrent: Effect.void,
        shellSynchronized: Effect.void,
      };
      const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make("browser"),
            subject: "test",
            method: "browser-session-cookie",
            scopes: ["factory:read"],
          }),
      });
      const runtime = Layer.mock(FactoryRuntime.FactoryRuntime)({
        enabled: true,
        getRelayPolicy: Effect.succeed(
          RelayPolicy.RelayPolicy.of({
            authorize: () => Effect.succeed(access),
            observeControl: () => Effect.die("Unexpected control observation in upgrade fixture."),
          }),
        ),
        getRelay: Effect.succeed({
          serve: () => Effect.fail(new Connections.SourceFailure({ reason: "authentication" })),
        }),
      });
      const services = yield* Layer.build(
        HttpRouter.serve(
          factoryWebSocketRouteLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(auth, runtime, Config.layer({ ...config, factoryEnabled: true })),
            ),
          ),
          { disableLogger: true, disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const address = Context.get(services, HttpServer.HttpServer).address;
      if (typeof address === "string" || !("port" in address))
        return yield* Effect.die("No factory test address.");
      const status = yield* Deferred.make<number | undefined>();
      const socket = yield* Socket.makeWebSocket(
        `ws://127.0.0.1:${address.port}/factory/env/a/ws?orchestrationProtocol=2&environmentId=env-a`,
      ).pipe(
        Effect.provideService(Socket.WebSocketConstructor, (url) => {
          const ws = new NodeSocket.NodeWS.WebSocket(url, {
            headers: { cookie: "factory_session=fixture" },
          });
          ws.on("unexpected-response", (_request, response) => {
            Deferred.doneUnsafe(status, Effect.succeed(response.statusCode));
            response.resume();
            ws.close();
          });
          return ws;
        }),
      );
      const opened = yield* socket.reader.pipe(Effect.result);
      expect(opened._tag).toBe("Failure");
      expect(yield* Deferred.await(status)).toBe(503);
    }),
  );
  it.effect("does not acquire runtime or authentication in disabled mode", () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const { handler, dispose } = HttpRouter.toWebHandler(
        factoryWebSocketRouteLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
              Layer.mock(FactoryRuntime.FactoryRuntime)({ enabled: false }),
              Config.layer({ ...config, factoryEnabled: false }),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const response = yield* Effect.promise(() =>
        handler(
          new Request(
            "http://factory.example/factory/env/a/ws?orchestrationProtocol=2&environmentId=env-a",
          ),
        ),
      );
      expect(response.status).toBe(404);
    }),
  );
});
