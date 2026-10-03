import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { handleStaticAndDevRequest } from "../http.ts";

export const FACTORY_BOOTSTRAP_PATH = "/factory/bootstrap";

class FactoryUiError extends Schema.TaggedError<FactoryUiError>()("FactoryUiError", {
  message: Schema.String,
}) {}

const disabledResponse = () =>
  HttpServerResponse.jsonUnsafe(
    {
      _tag: "FactoryError",
      code: "feature-disabled",
      message: "Factory mode is disabled.",
    },
    { status: 404 },
  );

const bootstrapRoute = HttpRouter.add(
  "GET",
  FACTORY_BOOTSTRAP_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (!config.factoryEnabled) return disabledResponse();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (requestUrl._tag === "None") return HttpServerResponse.text("Bad Request", { status: 400 });
    const first = (value: string | undefined) => value?.split(",", 1)[0]?.trim();
    const host =
      first(request.headers["x-forwarded-host"]) ?? request.headers.host ?? requestUrl.value.host;
    const protocol =
      first(request.headers["x-forwarded-proto"]) ?? requestUrl.value.protocol.slice(0, -1);
    const origin = yield* Effect.try({
      try: () => {
        const url = new URL(`${protocol}://${host}`);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        ) {
          throw new TypeError("Invalid public origin.");
        }
        return url;
      },
      catch: () => new FactoryUiError({ message: "Invalid public origin for the pairing page." }),
    }).pipe(Effect.result);
    if (origin._tag === "Failure")
      return HttpServerResponse.jsonUnsafe(origin.failure, { status: 400 });
    const pairingUrl = new URL("/pair", origin.success);
    // Vite owns the browser's dev port, but the canonical T3 page lives on the backend.
    if (config.devUrl) pairingUrl.port = String(config.port);
    return HttpServerResponse.jsonUnsafe(
      { pairingUrl: pairingUrl.toString() },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);

export const factoryHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const factoryUiDir = config.factoryUiDir;
    if (config.factoryEnabled && factoryUiDir !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* Effect.gen(function* () {
        const directory = yield* fs.stat(factoryUiDir);
        const indexPath = path.join(factoryUiDir, "index.html");
        const index = yield* fs.stat(indexPath);
        if (directory.type !== "Directory" || index.type !== "File" || index.size === 0n) {
          return yield* new FactoryUiError({
            message: "Factory UI directory must contain a built index.html file.",
          });
        }
        yield* fs.readFileString(indexPath);
      }).pipe(
        Effect.mapError(
          () =>
            new FactoryUiError({
              message: "Factory UI directory must contain a readable built index.html file.",
            }),
        ),
      );
    }
    const assets = Effect.gen(function* () {
      if (!config.factoryEnabled) return disabledResponse();
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (url._tag === "None") return HttpServerResponse.text("Bad Request", { status: 400 });
      if (
        ["/factory/env", FACTORY_BOOTSTRAP_PATH].some(
          (prefix) => url.value.pathname === prefix || url.value.pathname.startsWith(`${prefix}/`),
        )
      ) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      if (config.factoryUiDir === undefined) {
        return HttpServerResponse.jsonUnsafe(
          new FactoryUiError({ message: "Set --factory-ui-dir to a built Factory UI directory." }),
          { status: 503 },
        );
      }
      return yield* handleStaticAndDevRequest(new Set(), {
        directory: config.factoryUiDir,
        prefix: "/factory",
      });
    });
    return Layer.mergeAll(bootstrapRoute, HttpRouter.add("GET", "/factory/*", assets));
  }),
);
