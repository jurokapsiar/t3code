import type {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
  ServerConfig,
  ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Connections from "../Connections.ts";

export const make = Effect.gen(function* () {
  const attempts = yield* Queue.unbounded<{
    readonly input: Parameters<Connections.SourceTransport["Service"]["connect"]>[0];
    readonly ready: (config: ServerConfig) => Effect.Effect<boolean>;
    readonly emitConfig: (event: ServerConfigStreamEvent) => Effect.Effect<boolean>;
    readonly emitShell: (item: OrchestrationV2ShellStreamItem) => Effect.Effect<boolean>;
    readonly fail: (reason: Connections.SourceFailure["reason"]) => Effect.Effect<boolean>;
    readonly failShell: (reason: Connections.SourceFailure["reason"]) => Effect.Effect<boolean>;
    readonly closed: Effect.Effect<void>;
    readonly shellCalls: Queue.Queue<OrchestrationV2SubscribeShellInput>;
    readonly shellCancellations: Queue.Queue<void>;
  }>();
  const calls: Parameters<Connections.SourceTransport["Service"]["connect"]>[0][] = [];
  const layer = Layer.succeed(
    Connections.SourceTransport,
    Connections.SourceTransport.of({
      connect: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          const ready = yield* Deferred.make<ServerConfig>();
          const failed = yield* Deferred.make<never, Connections.SourceFailure>();
          const shellFailed = yield* Deferred.make<never, Connections.SourceFailure>();
          const closed = yield* Deferred.make<void>();
          const configs = yield* PubSub.unbounded<ServerConfigStreamEvent>();
          const shell = yield* PubSub.unbounded<OrchestrationV2ShellStreamItem>();
          const shellCalls = yield* Queue.unbounded<OrchestrationV2SubscribeShellInput>();
          const shellCancellations = yield* Queue.unbounded<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
          yield* Queue.offer(attempts, {
            input,
            ready: (config) => Deferred.succeed(ready, config),
            emitConfig: (event) => PubSub.publish(configs, event),
            emitShell: (item) => PubSub.publish(shell, item),
            fail: (reason) => Deferred.fail(failed, new Connections.SourceFailure({ reason })),
            failShell: (reason) =>
              Deferred.fail(shellFailed, new Connections.SourceFailure({ reason })),
            closed: Deferred.await(closed),
            shellCalls,
            shellCancellations,
          });
          return {
            configs: Stream.concat(
              Stream.fromEffect(
                Deferred.await(ready).pipe(
                  Effect.map((config) => ({
                    version: 1 as const,
                    type: "snapshot" as const,
                    config,
                  })),
                ),
              ),
              Stream.fromPubSub(configs),
            ),
            shell: (options) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(shell);
                  yield* Queue.offer(shellCalls, options);
                  return Stream.fromSubscription(subscription).pipe(
                    Stream.merge(Stream.fromEffect(Deferred.await(shellFailed)), {
                      haltStrategy: "either",
                    }),
                    Stream.ensuring(Queue.offer(shellCancellations, undefined)),
                  );
                }),
              ),
            closed: Deferred.await(failed),
          } satisfies Connections.SourceSession;
        }),
    }),
  );
  return { layer, attempts, calls };
});
