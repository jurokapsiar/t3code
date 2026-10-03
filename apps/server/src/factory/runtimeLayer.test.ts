import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import { FactoryRuntime, layer } from "./runtimeLayer.ts";

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-runtime-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
)("factory runtime", (it) => {
  it.effect("does not start outbound connections when disabled", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      let connectionFactoryCalls = 0;
      const services = yield* Layer.build(
        layer(() => Effect.sync(() => connectionFactoryCalls++)).pipe(
          Layer.provide(ServerConfig.layer({ ...config, factoryEnabled: false })),
        ),
      );
      const factory = Context.get(services, FactoryRuntime);
      const error = yield* Effect.flip(factory.getMetadata);

      expect(factory.enabled).toBe(false);
      expect(error).toMatchObject({ _tag: "FactoryError", code: "feature-disabled" });
      expect(connectionFactoryCalls).toBe(0);
    }),
  );

  it.effect("starts the enabled runtime and exposes persistent metadata", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      let connectionFactoryCalls = 0;
      const services = yield* Layer.build(
        layer(() => Effect.sync(() => connectionFactoryCalls++)).pipe(
          Layer.provide(ServerConfig.layer({ ...config, factoryEnabled: true })),
        ),
      );
      const factory = Context.get(services, FactoryRuntime);
      const metadata = yield* factory.getMetadata;

      expect(factory.enabled).toBe(true);
      expect(typeof metadata.createGroup).toBe("function");
      expect(connectionFactoryCalls).toBe(1);
    }),
  );
});
