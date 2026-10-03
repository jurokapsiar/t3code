import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  FactoryEnvironmentView,
  FactoryRegistrationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";
import * as Connections from "./Connections.ts";
import * as NodeSource from "./NodeSource.ts";
import * as FakeSocket from "./testkit/FakeSocket.ts";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";

const environment = FactoryEnvironmentView.make({
  registrationId: FactoryRegistrationId.make("source"),
  environmentId: EnvironmentId.make("env-a"),
  endpoint: "https://source.example",
  label: "Source",
  platform: null,
  enabled: true,
  state: "offline",
  credentialStorage: "secure-vault",
  credentialExpiresAt: null,
  cleanupPending: false,
  renewal: "unsupported",
  lastSeenAt: null,
  revision: 1,
});

const encodeFailure = Schema.encodeEffect(Schema.fromJsonString(Connections.SourceFailure));
it.effect.each([401, 403, 426, 503])(
  "classifies HTTP %i without a socket or a mutation",
  (status) =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.method + " " + request.url);
          return HttpClientResponse.fromWeb(request, Response.json({}, { status }));
        }),
      );
      const services = yield* Layer.build(
        NodeSource.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(HttpClient.HttpClient, http),
              Layer.succeed(Socket.WebSocketConstructor, () => {
                throw new Error("Unexpected socket.");
              }),
            ),
          ),
        ),
      );
      const now = yield* DateTime.now;
      const transport = Context.get(services, Connections.SourceTransport);
      const error = yield* Effect.flip(
        transport.connect({
          environment,
          credential: {
            token: "test-access-token",
            sourceSessionId: AuthSessionId.make("session"),
            scopes: ["orchestration:read"],
            issuedAt: now,
            expiresAt: DateTime.add(now, { days: 30 }),
          },
        }),
      );
      expect(error.reason).toBe(
        status === 401 || status === 403
          ? "authentication"
          : status === 426
            ? "protocol"
            : "transport",
      );
      expect(requests).toEqual(["POST https://source.example/api/auth/websocket-ticket"]);
      expect(yield* encodeFailure(error)).not.toContain("test-access-token");
    }),
);

it.effect(
  "uses a one-use ticket, real RPC frames, and consumer cancellation without provider actions",
  () =>
    Effect.gen(function* () {
      const fake = yield* FakeSocket.make;
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ ticket: "one-use-ticket", expiresAt: "2099-01-01T00:00:00Z" }),
          );
        }),
      );
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const services = yield* Layer.buildWithScope(
        NodeSource.layer.pipe(
          Layer.provide(Layer.merge(fake.layer, Layer.succeed(HttpClient.HttpClient, http))),
        ),
        scope,
      );
      const now = yield* DateTime.now;
      const source = yield* Context.get(services, Connections.SourceTransport)
        .connect({
          environment,
          credential: {
            token: "test-access-token",
            sourceSessionId: AuthSessionId.make("session"),
            scopes: ["orchestration:read"],
            issuedAt: now,
            expiresAt: DateTime.add(now, { days: 30 }),
          },
        })
        .pipe(Scope.provide(scope));
      const socket = yield* Queue.take(fake.sockets);
      expect(socket.url).toBe(
        "wss://source.example/ws?wsTicket=one-use-ticket&orchestrationProtocol=2",
      );
      expect(socket.url).not.toContain("test-access-token");
      expect(requests[0]?.headers.authorization).toBe("Bearer test-access-token");
      expect(requests[0]?.headers.cookie).toBeUndefined();
      const consumer = yield* source
        .shell({ batchedReplay: true, afterSequence: 7 })
        .pipe(Stream.runDrain, Effect.forkScoped);
      const request = yield* Queue.take(fake.frames);
      expect(request).toMatchObject({
        _tag: "Request",
        tag: "orchestration.subscribeShell",
        payload: { batchedReplay: true, afterSequence: 7 },
      });
      socket.message({ _tag: "Chunk", requestId: request.id, values: [{ kind: "synchronized" }] });
      expect(yield* Queue.take(fake.frames)).toMatchObject({ _tag: "Ack", requestId: request.id });
      yield* Fiber.interrupt(consumer);
      const cancellation = yield* Queue.take(fake.frames);
      expect(cancellation).toMatchObject({ _tag: "Interrupt", requestId: request.id });
      expect(socket.readyState).toBe(1);
      yield* Scope.close(scope, Exit.void);
      yield* fake.closed;
    }),
);
