import {
  AuthWebSocketTicketResult,
  EnvironmentAuthorizationError,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as ByteSize from "effect/ByteSize";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import * as Connections from "./Connections.ts";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const mapRpcError = (error: { readonly _tag: string }) =>
  new Connections.SourceFailure({
    reason: isAuthorizationError(error)
      ? "authentication"
      : isRpcClientError(error) && error.reason._tag === "RpcClientDefect"
        ? "protocol"
        : "transport",
  });

const guardDecode = <A, E extends { readonly _tag: string }>(stream: Stream.Stream<A, E>) =>
  stream.pipe(
    Stream.mapError(mapRpcError),
    Stream.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Stream.failCause(cause)
        : Cause.hasDies(cause)
          ? Stream.fail(new Connections.SourceFailure({ reason: "protocol" }))
          : Stream.failCause(cause),
    ),
  );

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const constructor = yield* Socket.WebSocketConstructor;
  const openSocket = Effect.fnUntraced(function* (
    input: Parameters<Connections.SourceTransport["Service"]["connect"]>[0],
    highWaterMark?: number,
  ) {
    const base = yield* Effect.try({
      try: () => {
        const url = new URL(input.environment.endpoint);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Invalid source endpoint.");
        return url;
      },
      catch: () => new Connections.SourceFailure({ reason: "protocol" }),
    });
    const ticketUrl = new URL("/api/auth/websocket-ticket", base);
    const ticket = yield* http
      .execute(
        HttpClientRequest.post(ticketUrl.toString()).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${input.credential.token}`),
          HttpClientRequest.setHeader("cache-control", "no-store"),
        ),
      )
      .pipe(
        Effect.mapError(() => new Connections.SourceFailure({ reason: "transport" })),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult)(response).pipe(
                Effect.mapError(() => new Connections.SourceFailure({ reason: "protocol" })),
              )
            : Effect.fail(
                new Connections.SourceFailure({
                  reason:
                    response.status === 401 || response.status === 403
                      ? "authentication"
                      : response.status === 426 || response.status === 404
                        ? "protocol"
                        : "transport",
                }),
              ),
        ),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Connections.SourceFailure({ reason: "transport" })),
        }),
        Effect.provideService(FetchHttpClient.RequestInit, {
          cache: "no-store",
          redirect: "error",
        }),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
      );
    const url = new URL("/ws", base);
    url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
    return yield* Socket.makeWebSocket(url.toString(), {
      openTimeout: "15 seconds",
      highWaterMark,
    });
  });
  const connectRelay: NonNullable<Connections.SourceTransport["Service"]["connectRelay"]> =
    Effect.fnUntraced(function* (input) {
      let reason: Connections.SourceFailure["reason"] = "transport";
      const socket = yield* openSocket(input, 8 * 1024 * 1024).pipe(
        Effect.provideService(Socket.WebSocketConstructor, (url, options) => {
          const ws = constructor(url, options);
          if (ws instanceof NodeSocket.NodeWS.WebSocket) {
            ws.on("unexpected-response", (_request, response) => {
              reason =
                response.statusCode === 426
                  ? "protocol"
                  : response.statusCode === 401 || response.statusCode === 403
                    ? "authentication"
                    : "transport";
              response.resume();
              ws.close();
            });
          }
          return ws;
        }),
      );
      const reader = yield* socket.reader.pipe(
        Effect.mapError(() => new Connections.SourceFailure({ reason })),
      );
      return Socket.make({ reader: Effect.succeed(reader), writer: socket.writer });
    });
  const connect: Connections.SourceTransport["Service"]["connect"] = Effect.fnUntraced(
    function* (input) {
      const closed = yield* Deferred.make<never, Connections.SourceFailure>();
      const hooks = RpcClient.ConnectionHooks.of({
        onConnect: Effect.void,
        onDisconnect: Deferred.fail(
          closed,
          new Connections.SourceFailure({ reason: "transport" }),
        ).pipe(Effect.asVoid),
      });
      const socket = yield* openSocket(input).pipe(
        Effect.provideService(Socket.WebSocketConstructor, (socketUrl, options) => {
          const ws = constructor(socketUrl, options);
          if (ws instanceof NodeSocket.NodeWS.WebSocket) {
            ws.on("unexpected-response", (_request, response) => {
              Deferred.doneUnsafe(
                closed,
                Effect.fail(
                  new Connections.SourceFailure({
                    reason:
                      response.statusCode === 426
                        ? "protocol"
                        : response.statusCode === 401 || response.statusCode === 403
                          ? "authentication"
                          : "transport",
                  }),
                ),
              );
              response.resume();
              ws.close();
            });
          }
          return ws;
        }),
      );
      const socketLayer = Layer.succeed(Socket.Socket, socket);
      const protocol = yield* Layer.build(
        Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              socketLayer,
              RpcSerialization.layerJson,
              Layer.succeed(RpcClient.ConnectionHooks, hooks),
            ),
          ),
        ),
      );
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
      return {
        configs: guardDecode(client[WS_METHODS.subscribeServerConfig]({})),
        shell: (options) =>
          guardDecode(client[ORCHESTRATION_V2_WS_METHODS.subscribeShell](options)),
        closed: Deferred.await(closed),
      } satisfies Connections.SourceSession;
    },
  );
  return Connections.SourceTransport.of({ connect, connectRelay });
});

export const layer = Layer.effect(Connections.SourceTransport, make);
export const nodeLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NodeSocket.layerWebSocketConstructorWS)),
);
