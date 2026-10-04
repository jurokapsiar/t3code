import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as Config from "../../config.ts";
import * as Server from "../../server.ts";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ApplicationEvents from "../../persistence/Services/OrchestrationEventStore.ts";
import * as CommandReceipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The production composition, owned by the caller's scope, on an ephemeral port. */
export const startProductionServer = (config: Config.ServerConfig["Service"]) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Context.Context<Layer.Success<typeof Server.layer>>>();
    const fiber = yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(
          Server.layer.pipe(
            Layer.provide(
              Config.layer({
                ...config,
                port: 0,
                host: "127.0.0.1",
                noBrowser: true,
                startupPresentation: "browser",
              }),
            ),
          ),
        );
        yield* Deferred.succeed(ready, services);
        return yield* Effect.never;
      }),
    ).pipe(Effect.forkScoped);
    const services = yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(fiber));
    const address = Context.get(services, HttpServer.HttpServer).address;
    if (typeof address === "string" || !("port" in address))
      return yield* Effect.die("No production test address.");
    return { services, fiber, origin: `http://127.0.0.1:${address.port}`, config };
  });

export const productionEventSink = (
  services: Context.Context<Layer.Success<typeof Server.layer>>,
) =>
  Effect.gen(function* () {
    const infrastructure = Layer.mergeAll(
      EventStore.layerFromOrchestrationEventStore.pipe(
        Layer.provide(
          Layer.succeed(
            ApplicationEvents.OrchestrationEventStore,
            Context.get(services, ApplicationEvents.OrchestrationEventStore),
          ),
        ),
      ),
      ProjectionStore.layer,
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient)),
      ),
    );
    return Context.get(
      yield* Layer.build(EventSink.layer.pipe(Layer.provide(infrastructure))),
      EventSink.EventSinkV2,
    );
  });

export const productionCommandReceipts = (
  services: Context.Context<Layer.Success<typeof Server.layer>>,
) =>
  Effect.gen(function* () {
    const layer = CommandReceipts.layer.pipe(
      Layer.provide(Layer.succeed(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient))),
    );
    return Context.get(yield* Layer.build(layer), CommandReceipts.CommandReceiptStoreV2);
  });
