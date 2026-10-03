import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";

export const FACTORY_BOOTSTRAP_PATH = "/factory/bootstrap";

export const factoryHttpRouteLayer = HttpRouter.add(
  "GET",
  FACTORY_BOOTSTRAP_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (!config.factoryEnabled) {
      return HttpServerResponse.jsonUnsafe(
        {
          _tag: "FactoryError",
          code: "feature-disabled",
          message: "Factory mode is disabled.",
        },
        { status: 404 },
      );
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    if (requestUrl._tag === "None") {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const pairingUrl = new URL("/pair", requestUrl.value);
    if (config.devUrl) {
      pairingUrl.protocol = "http:";
      pairingUrl.hostname = "localhost";
    }
    return HttpServerResponse.jsonUnsafe({ pairingUrl: pairingUrl.toString() });
  }),
);
