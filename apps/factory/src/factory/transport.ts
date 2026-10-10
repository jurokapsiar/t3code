import { FactoryRpcGroup } from "@t3tools/contracts/factoryRpc";
import { WsRpcGroup } from "@t3tools/contracts/rpc";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { isFactoryCompatible } from "./protocol";

export { FactoryRpcGroup, WsRpcGroup };
export { factoryPairUrl } from "./protocol";

export class FactoryTransportError extends Data.TaggedError("FactoryTransportError")<{
  readonly reason:
    | "unauthenticated"
    | "auth-check-failed"
    | "invalid-auth-session"
    | "discovery-failed"
    | "invalid-discovery"
    | "factory-disabled"
    | "incompatible-protocol";
  readonly cause?: unknown;
}> {}

export interface FactoryTransportOptions {
  readonly origin?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly webSocketConstructor?: Socket.WebSocketConstructor["Service"];
}

const configRequests = [...WsRpcGroup.requests.values()].filter(
  (rpc) => rpc._tag === "server.getConfig",
);
const ConfigRpcGroup = RpcGroup.make(...configRequests);
const descriptorSchema = configRequests[0].successSchema.fields.environment;

/** One attempt in the caller's Scope. U2 owns retries and client lifetime. */
export function makeFactoryTransport(options: FactoryTransportOptions = {}) {
  return Effect.gen(function* () {
    const origin = new URL(options.origin ?? window.location.origin).origin;
    const fetcher = options.fetch ?? globalThis.fetch;
    const readJson = (path: string, reason: "auth-check-failed" | "discovery-failed") =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetcher(path, {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal,
          });
          if (response.status === 401 || response.status === 403) {
            throw new FactoryTransportError({ reason: "unauthenticated" });
          }
          if (!response.ok) throw new FactoryTransportError({ reason });
          const body: unknown = await response.json();
          return body;
        },
        catch: (cause) =>
          cause instanceof FactoryTransportError
            ? cause
            : new FactoryTransportError({ reason, cause }),
      });
    const session = yield* readJson("/api/auth/session", "auth-check-failed");
    // Only the authentication decision is consumed here; HTTP API schemas stay out of the overview entry.
    if (
      typeof session !== "object" ||
      session === null ||
      !("authenticated" in session) ||
      typeof session.authenticated !== "boolean"
    ) {
      return yield* Effect.fail(new FactoryTransportError({ reason: "invalid-auth-session" }));
    }
    if (!session.authenticated) {
      return yield* Effect.fail(new FactoryTransportError({ reason: "unauthenticated" }));
    }
    // The early artifact has no orchestration protocol constant export. Discover the upgrade parameter.
    const descriptor = yield* readJson("/.well-known/t3/environment", "discovery-failed").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(descriptorSchema))),
      Effect.mapError((cause) =>
        cause instanceof FactoryTransportError
          ? cause
          : new FactoryTransportError({ reason: "invalid-discovery", cause }),
      ),
    );
    if (descriptor.orchestrationProtocolVersion === undefined) {
      return yield* Effect.fail(new FactoryTransportError({ reason: "invalid-discovery" }));
    }
    const url = new URL("/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("orchestrationProtocol", String(descriptor.orchestrationProtocolVersion));
    const socket = yield* Socket.makeWebSocket(url.href).pipe(
      Effect.provideService(
        Socket.WebSocketConstructor,
        options.webSocketConstructor ??
          ((address, protocols) => {
            if (
              protocols !== undefined &&
              typeof protocols !== "string" &&
              !Array.isArray(protocols)
            ) {
              throw new TypeError("Browser WebSocket headers are not supported");
            }
            return new globalThis.WebSocket(address, protocols);
          }),
      ),
    );
    // layerProtocolSocket does not expose retryPolicy in Effect 4. Use the constructor to disable retries.
    const protocol = yield* RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerJson),
    );
    // Reuse the bootstrap client: a second client can miss a disconnect before its receiver starts.
    const factory = yield* RpcClient.make(FactoryRpcGroup.merge(ConfigRpcGroup)).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    const serverConfig = yield* factory["server.getConfig"]({}).pipe(Effect.timeout("10 seconds"));
    if (serverConfig.environment.capabilities.factory !== true) {
      return yield* Effect.fail(new FactoryTransportError({ reason: "factory-disabled" }));
    }
    if (
      !isFactoryCompatible({
        enabled: true,
        protocolVersion: serverConfig.environment.factoryProtocolVersion,
      })
    ) {
      return yield* Effect.fail(new FactoryTransportError({ reason: "incompatible-protocol" }));
    }
    return { factory, serverConfig };
  });
}

export type FactoryTransport = Effect.Success<ReturnType<typeof makeFactoryTransport>>;
