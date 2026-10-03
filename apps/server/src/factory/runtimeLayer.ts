import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FactoryError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Metadata from "./Metadata.ts";

export class FactoryRuntime extends Context.Service<
  FactoryRuntime,
  {
    readonly enabled: boolean;
    readonly getMetadata: Effect.Effect<Metadata.Metadata["Service"], FactoryError>;
  }
>()("t3/factory/runtimeLayer/FactoryRuntime") {}

const disabledError = new FactoryError({
  code: "feature-disabled",
  message: "Factory mode is disabled. Start the server with --factory to enable it.",
});

export const layer = (startConnections: () => Effect.Effect<void> = () => Effect.void) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      if (!config.factoryEnabled) {
        return Layer.succeed(FactoryRuntime, {
          enabled: false,
          getMetadata: Effect.fail(disabledError),
        });
      }

      return Layer.effect(
        FactoryRuntime,
        Effect.gen(function* () {
          yield* startConnections();
          const metadata = yield* Metadata.Metadata;
          return {
            enabled: true,
            getMetadata: Effect.succeed(metadata),
          };
        }),
      ).pipe(Layer.provide(Metadata.layer));
    }),
  );
