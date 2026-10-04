import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, FactoryRegistrationId, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Config from "../config.ts";
import * as Connections from "./Connections.ts";
import * as SourceShell from "./SourceShell.ts";
import * as RelayPolicy from "./RelayPolicy.ts";
import * as Relay from "./Relay.ts";
import { config } from "./testkit/sourceConfig.ts";
import { classifyRelayFrame } from "./Relay.ts";

it("rejects unknown and server-origin frames on the browser leg", () => {
  expect(classifyRelayFrame({ _tag: "UnknownFrame" })).toEqual({
    kind: "reject",
    reason: "invalid-frame",
  });
  expect(classifyRelayFrame({ _tag: "Chunk", requestId: 1, values: [{}] })).toEqual({
    kind: "reject",
    reason: "invalid-frame",
  });
});
it("accepts actual Effect request metadata and control frames", () => {
  const frame = {
    _tag: "Request",
    id: 1,
    tag: "server.getConfig",
    payload: {},
    headers: [],
    traceId: "trace",
    spanId: "span",
    sampled: true,
  };
  expect(classifyRelayFrame(frame)).toEqual({ kind: "request", frame });
  for (const frame of [
    { _tag: "Ack", requestId: 1 },
    { _tag: "Interrupt", requestId: "1" },
    { _tag: "Ping" },
    { _tag: "Eof" },
  ]) {
    expect(classifyRelayFrame(frame)).toEqual({ kind: "control", frame });
  }
});
it("denies method, header injection, notifications, and malformed IDs", () => {
  for (const patch of [
    { tag: "server.signalProcess" },
    { headers: [["authorization", "bearer injected"]] },
    { headers: [["x-environment-id", "other"]] },
    { isNotification: true },
    { id: {} },
    { id: -1 },
    { payload: undefined },
  ]) {
    expect(
      classifyRelayFrame({
        _tag: "Request",
        id: 1,
        tag: "server.getConfig",
        payload: {},
        headers: [],
        ...patch,
      }).kind,
    ).toBe("reject");
  }
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      id: Schema.optional(Schema.String),
      requestId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      tag: Schema.optional(Schema.String),
      payload: Schema.optional(Schema.Unknown),
      headers: Schema.optional(Schema.Array(Schema.Unknown)),
      exit: Schema.optional(Schema.Struct({ value: Schema.Unknown })),
    }),
  ),
);
const encodeConfig = Schema.encodeEffect(ServerConfigStreamEvent);
const encodeNativeExit = Schema.encodeSync(
  Schema.toCodecJson(Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Unknown)),
);
const request = (id: string | number, tag = "server.getConfig", payload: unknown = {}) =>
  encodeJson({ _tag: "Request", id, tag, payload, headers: [] });
import { memorySocket } from "./testkit/RelaySocket.ts";
const harness = (
  options: {
    callerScopes?: ReadonlyArray<"factory:read" | "factory:control">;
    sourceScopes?: Connections.SourceAccess["sourceScopes"];
    synchronized?: boolean;
    version?: number;
    identity?: string;
    sourceId?: string;
    handshake?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const upstream = yield* memorySocket;
    const browser = yield* memorySocket;
    const ended = yield* Deferred.make<never, Connections.SourceFailure>();
    const target = {
      registrationId: FactoryRegistrationId.make("a"),
      environmentId: EnvironmentId.make(options.sourceId ?? "env-a"),
    };
    let current = true;
    let opens = 0;
    const access: Connections.SourceAccess = {
      target,
      connectionId: {},
      config: {
        ...config(options.sourceId ?? "env-a"),
        environment: {
          ...config(options.sourceId ?? "env-a").environment,
          capabilities: { repositoryIdentity: false, threadSettlement: true },
        },
      },
      sourceScopes: options.sourceScopes ?? [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
      ],
      checkCurrent: Effect.suspend(() =>
        current
          ? Effect.void
          : Effect.fail(new Connections.SourceFailure({ reason: "authentication" })),
      ),
      closed: Deferred.await(ended),
      shell: Stream.never,
      acknowledgeShell: () => Effect.void,
    };
    const settings = yield* Config.ServerConfig;
    const connections = Layer.mock(Connections.Connections)({
      resolveTarget: (input) =>
        input.environmentId === target.environmentId &&
        input.registrationId === target.registrationId
          ? Effect.succeed(access)
          : Effect.fail(new Connections.SourceFailure({ reason: "identity" })),
      openRelay: () =>
        Effect.sync(() => {
          opens++;
          return upstream.socket;
        }),
    });
    const deps = Layer.mergeAll(
      connections,
      Config.layer({ ...settings, factoryEnabled: true }),
      Layer.mock(SourceShell.SourceShell)({
        isSynchronized: () => Effect.succeed(options.synchronized ?? true),
      }),
    );
    const services = yield* Layer.build(
      Relay.layer.pipe(Layer.provideMerge(RelayPolicy.layer.pipe(Layer.provideMerge(deps)))),
    );
    const relay = Context.get(services, Relay.Relay);
    const fiber = yield* relay
      .serve({
        socket: browser.socket,
        target,
        callerScopes: options.callerScopes ?? ["factory:read", "factory:control"],
      })
      .pipe(Effect.forkScoped);
    const handshake = decodeJson(
      yield* Effect.raceFirst(
        Queue.take(upstream.outgoing),
        Fiber.join(fiber).pipe(Effect.andThen(Effect.die("Relay ended before handshake."))),
      ),
    );
    expect(handshake).toMatchObject({
      _tag: "Request",
      tag: "subscribeServerConfig",
      payload: {},
      headers: [],
    });
    if (options.handshake !== false) {
      yield* Queue.offer(
        upstream.incoming,
        encodeJson({
          _tag: "Chunk",
          requestId: handshake.id,
          values: [
            yield* encodeConfig({
              version: 1,
              type: "snapshot",
              config: config(
                options.identity ?? options.sourceId ?? "env-a",
                true,
                options.version,
              ),
            }),
          ],
        }),
      );
      if (options.version === undefined && options.identity === undefined)
        expect(decodeJson(yield* Queue.take(upstream.outgoing))).toEqual({
          _tag: "Ack",
          requestId: handshake.id,
        });
    }
    return {
      relay,
      upstream,
      browser,
      fiber,
      target,
      configRequestId: handshake.id,
      get opens() {
        return opens;
      },
      expire: Effect.sync(() => {
        current = false;
      }).pipe(
        Effect.andThen(
          Deferred.fail(ended, new Connections.SourceFailure({ reason: "authentication" })),
        ),
      ),
    };
  });
const testLayer = Config.layerTest(process.cwd(), { prefix: "t3-relay-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(testLayer)("scoped relay", (it) => {
  it.effect("preserves request IDs, command payload bytes and source result bytes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const raw =
        '{ "_tag": "Request", "id": 7, "tag": "server.getConfig", "payload": {}, "headers": [], "traceId": "trace", "spanId": "span", "sampled": true }';
      yield* Queue.offer(h.browser.incoming, raw);
      expect(yield* Queue.take(h.upstream.outgoing)).toBe(raw);
      const result =
        '{"_tag":"Exit", "requestId":7, "exit":{"_tag":"Success","value":{"usage":null,"terminal":{"truncated":true},"options":["first","second"]}}}';
      yield* Queue.offer(h.upstream.incoming, result);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(result);
      yield* h.browser.close;
      yield* Fiber.await(h.fiber);
      yield* h.upstream.closed;
      expect(h.opens).toBe(1);
    }),
  );
  it.effect.each([{ version: 1 }, { identity: "replacement" }])(
    "rejects initial source protocol or identity mismatch %j",
    (options) =>
      Effect.gen(function* () {
        const h = yield* harness(options);
        const result = yield* Fiber.await(h.fiber);
        expect(Exit.isFailure(result)).toBe(true);
        yield* h.upstream.closed;
      }),
  );
  it.effect.each([
    { callerScopes: ["factory:read"] as const },
    { synchronized: false },
    { sourceScopes: ["orchestration:read"] as const },
  ])("denies control on restricted or stale caller %j", (options) =>
    Effect.gen(function* () {
      const h = yield* harness(options);
      yield* Queue.offer(
        h.browser.incoming,
        request(1, "terminal.write", { threadId: "thread", terminalId: "term", data: "x" }),
      );
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
      expect(yield* Queue.size(h.upstream.outgoing)).toBe(0);
    }),
  );
  it.effect("uses isolated raw ID namespaces for two sources on the same relay service", () =>
    Effect.gen(function* () {
      const makeSource = (registrationId: string, environmentId: string) =>
        Effect.gen(function* () {
          const browser = yield* memorySocket;
          const upstream = yield* memorySocket;
          const access: Connections.SourceAccess = {
            target: {
              registrationId: FactoryRegistrationId.make(registrationId),
              environmentId: EnvironmentId.make(environmentId),
            },
            connectionId: {},
            config: config(environmentId),
            sourceScopes: ["orchestration:read"],
            checkCurrent: Effect.void,
            closed: Effect.never,
            shell: Stream.never,
            acknowledgeShell: () => Effect.void,
          };
          return { browser, upstream, access };
        });
      const sources = [yield* makeSource("a", "env-a"), yield* makeSource("b", "env-b")];
      const settings = yield* Config.ServerConfig;
      const dependencies = Layer.mergeAll(
        Config.layer({ ...settings, factoryEnabled: true }),
        Layer.mock(SourceShell.SourceShell)({ isSynchronized: () => Effect.succeed(true) }),
        Layer.mock(Connections.Connections)({
          resolveTarget: (target) => {
            const source = sources.find(
              (source) =>
                source.access.target.registrationId === target.registrationId &&
                source.access.target.environmentId === target.environmentId,
            );
            return source === undefined
              ? Effect.fail(new Connections.SourceFailure({ reason: "identity" }))
              : Effect.succeed(source.access);
          },
          openRelay: (access) => {
            const source = sources.find(
              (source) => source.access.connectionId === access.connectionId,
            );
            return source === undefined
              ? Effect.fail(new Connections.SourceFailure({ reason: "unavailable" }))
              : Effect.succeed(source.upstream.socket);
          },
        }),
      );
      const services = yield* Layer.build(
        Relay.layer.pipe(
          Layer.provideMerge(RelayPolicy.layer.pipe(Layer.provideMerge(dependencies))),
        ),
      );
      const relay = Context.get(services, Relay.Relay);
      const consumers = yield* Effect.forEach(sources, (source) =>
        Effect.gen(function* () {
          const fiber = yield* relay
            .serve({
              socket: source.browser.socket,
              target: source.access.target,
              callerScopes: ["factory:read"],
            })
            .pipe(Effect.forkScoped);
          const toSource = () =>
            Effect.raceFirst(
              Queue.take(source.upstream.outgoing),
              Fiber.join(fiber).pipe(
                Effect.andThen(Effect.die("Relay ended before source packet.")),
              ),
            );
          const fromBrowser = () =>
            Effect.raceFirst(
              Queue.take(source.browser.outgoing),
              Fiber.join(fiber).pipe(
                Effect.andThen(Effect.die("Relay ended before browser packet.")),
              ),
            );
          const handshake = decodeJson(yield* toSource());
          yield* Queue.offer(
            source.upstream.incoming,
            encodeJson({
              _tag: "Chunk",
              requestId: handshake.id,
              values: [
                yield* encodeConfig({ version: 1, type: "snapshot", config: source.access.config }),
              ],
            }),
          );
          expect(decodeJson(yield* toSource())).toEqual({ _tag: "Ack", requestId: handshake.id });
          return { ...source, toSource, fromBrowser };
        }),
      );
      for (const source of consumers) {
        yield* Queue.offer(source.browser.incoming, request(1));
        expect(yield* source.toSource()).toBe(request(1));
      }
      for (const source of consumers) {
        const reply = encodeJson({
          _tag: "Exit",
          requestId: 1,
          exit: { _tag: "Success", value: source.access.target.environmentId },
        });
        yield* Queue.offer(source.upstream.incoming, reply);
        expect(yield* source.fromBrowser()).toBe(reply);
      }
    }),
  );
  it.effect("tracks stream acknowledgements and cancellation without changing milestones", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Queue.offer(h.browser.incoming, request("stream", "subscribeTerminalEvents"));
      yield* Queue.take(h.upstream.outgoing);
      const chunk =
        '{"_tag":"Chunk","requestId":"stream","values":[{"kind":"accepted"},{"kind":"provider-completed","finalizedAt":null}]}';
      yield* Queue.offer(h.upstream.incoming, chunk);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(chunk);
      for (const tag of ["Ack", "Interrupt"]) {
        const raw = encodeJson({ _tag: tag, requestId: "stream" });
        yield* Queue.offer(h.browser.incoming, raw);
        expect(yield* Queue.take(h.upstream.outgoing)).toBe(raw);
      }
      const end = encodeJson({
        _tag: "Exit",
        requestId: "stream",
        exit: encodeNativeExit(Exit.interrupt(42)),
      });
      yield* Queue.offer(h.upstream.incoming, end);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(end);
      yield* Queue.offer(h.browser.incoming, '{"_tag":"Interrupt","requestId":"stream"}');
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
    }),
  );
  it.effect("accepts a late chunk Ack and one cancellation raced with a native Exit", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const sourceFrame = () =>
        Effect.raceFirst(
          Queue.take(h.upstream.outgoing),
          Fiber.join(h.fiber).pipe(
            Effect.andThen(Effect.die("Relay closed on a legal late control.")),
          ),
        );
      yield* Queue.offer(h.browser.incoming, request(1, "subscribeTerminalEvents"));
      yield* sourceFrame();
      const chunk = encodeJson({ _tag: "Chunk", requestId: 1, values: [{}] });
      yield* Queue.offer(h.upstream.incoming, chunk);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(chunk);
      const cancel = encodeJson({ _tag: "Interrupt", requestId: 1 });
      yield* Queue.offer(h.browser.incoming, cancel);
      expect(yield* sourceFrame()).toBe(cancel);
      const cancelled = encodeJson({
        _tag: "Exit",
        requestId: 1,
        exit: encodeNativeExit(Exit.interrupt(42)),
      });
      yield* Queue.offer(h.upstream.incoming, cancelled);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(cancelled);
      const ack = encodeJson({ _tag: "Ack", requestId: 1 });
      yield* Queue.offer(h.browser.incoming, ack);
      expect(yield* sourceFrame()).toBe(ack);
      yield* Queue.offer(h.browser.incoming, request(2));
      yield* sourceFrame();
      const completed = encodeJson({
        _tag: "Exit",
        requestId: 2,
        exit: { _tag: "Success", value: null },
      });
      yield* Queue.offer(h.upstream.incoming, completed);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(completed);
      const lateCancel = encodeJson({ _tag: "Interrupt", requestId: 2 });
      yield* Queue.offer(h.browser.incoming, lateCancel);
      expect(yield* sourceFrame()).toBe(lateCancel);
      yield* Queue.offer(h.browser.incoming, ack);
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
    }),
  );
  it.effect("does not repeat terminal input when its acknowledgement is lost", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const raw = request(3, "terminal.write", {
        threadId: "thread",
        terminalId: "term",
        data: "one write",
      });
      yield* Queue.offer(h.browser.incoming, raw);
      expect(yield* Queue.take(h.upstream.outgoing)).toBe(raw);
      yield* h.upstream.close;
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
      expect(h.opens).toBe(1);
      expect(yield* Queue.size(h.upstream.outgoing)).toBe(0);
    }),
  );
  it.effect("closes an idle relay on expiry without waiting for a browser request", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.expire;
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
      yield* h.upstream.closed;
    }),
  );
  it.effect.each([
    request(1),
    '{"_tag":"Interrupt","requestId":999}',
    request(2, "terminal.write", {}),
    '{"_tag":"Request","id":2,"tag":"server.getConfig","payload":{},"headers":[],"target":{"environmentId":"other"}}',
  ])(
    "rejects duplicate, unknown cancellation, invalid payload or target-switch frame %s",
    (frame) =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* Queue.offer(h.browser.incoming, request(1));
        yield* Queue.take(h.upstream.outgoing);
        yield* Queue.offer(h.browser.incoming, frame);
        expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
        expect(yield* Queue.size(h.upstream.outgoing)).toBe(0);
      }),
  );
  it.effect("accepts the exact UTF-8 request byte limit and rejects the next byte", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const base = encodeJson({
        _tag: "Request",
        id: 1,
        tag: "server.getConfig",
        payload: {},
        headers: [],
        spanId: "",
      });
      const remaining = 1024 * 1024 - new TextEncoder().encode(base).byteLength;
      const exact = base.replace(
        '"spanId":""',
        '"spanId":"' + "\u00e9".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2) + '"',
      );
      expect(new TextEncoder().encode(exact).byteLength).toBe(1024 * 1024);
      yield* Queue.offer(h.browser.incoming, exact);
      expect(yield* Queue.take(h.upstream.outgoing)).toBe(exact);
      yield* Queue.offer(h.browser.incoming, exact + " ");
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
    }),
  );
  it.effect("accepts 128 batch items and rejects 129 before forwarding", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const batch = "[" + Array.from({ length: 128 }, (_, i) => request(i)).join(",") + "]";
      yield* Queue.offer(h.browser.incoming, batch);
      expect(yield* Queue.take(h.upstream.outgoing)).toBe(batch);
      yield* Queue.offer(
        h.browser.incoming,
        "[" + Array.from({ length: 129 }, () => '{"_tag":"Ping"}').join(",") + "]",
      );
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
    }),
  );
  it.effect("bounds outstanding IDs even across individually valid frames", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (let i = 0; i < 128; i++) {
        yield* Queue.offer(h.browser.incoming, request(i));
        yield* Queue.take(h.upstream.outgoing);
      }
      yield* Queue.offer(h.browser.incoming, request(128));
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
    }),
  );
  it.effect("bounds source response bytes and chunk item counts", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Queue.offer(h.browser.incoming, request(1));
      yield* Queue.take(h.upstream.outgoing);
      const base = '{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":""}}';
      const exact = base.replace(
        '"value":""',
        '"value":"' + "x".repeat(8 * 1024 * 1024 - base.length) + '"',
      );
      yield* Queue.offer(h.upstream.incoming, exact);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(exact);
      yield* Queue.offer(h.upstream.incoming, exact + " ");
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
      const other = yield* harness();
      yield* Queue.offer(other.browser.incoming, request(1));
      yield* Queue.take(other.upstream.outgoing);
      const acceptedChunk = encodeJson({
        _tag: "Chunk",
        requestId: 1,
        values: Array.from({ length: 128 }, () => ({})),
      });
      yield* Queue.offer(other.upstream.incoming, acceptedChunk);
      expect(yield* Queue.take(other.browser.outgoing)).toBe(acceptedChunk);
      yield* Queue.offer(
        other.upstream.incoming,
        encodeJson({
          _tag: "Chunk",
          requestId: 1,
          values: Array.from({ length: 129 }, () => ({})),
        }),
      );
      expect(Exit.isFailure(yield* Fiber.await(other.fiber))).toBe(true);
    }),
  );
  it.effect("forwards source authentication failures unchanged", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Queue.offer(h.browser.incoming, request(4));
      yield* Queue.take(h.upstream.outgoing);
      const raw =
        '{"_tag":"Exit","requestId":4,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","reason":"expired"}}]}}';
      yield* Queue.offer(h.upstream.incoming, raw);
      expect(yield* Queue.take(h.browser.outgoing)).toBe(raw);
    }),
  );

  it.effect(
    "removes only supervisor config frames from a mixed source batch and keeps public bytes",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* Queue.offer(h.browser.incoming, request(8));
        yield* Queue.take(h.upstream.outgoing);
        const publicReply =
          ' { "_tag": "Exit", "requestId": 8, "exit": { "_tag": "Success", "value": { "unreportedUsage": null, "text": "a,b" } } } ';
        const configEvent = yield* encodeConfig({ version: 1, type: "snapshot", config: config() });
        yield* Queue.offer(
          h.upstream.incoming,
          "[" +
            encodeJson({ _tag: "Chunk", requestId: h.configRequestId, values: [configEvent] }) +
            "," +
            publicReply +
            "]",
        );
        expect(
          yield* Effect.raceFirst(
            Queue.take(h.browser.outgoing),
            Fiber.join(h.fiber).pipe(
              Effect.andThen(Effect.die("Relay ended before public reply.")),
            ),
          ),
        ).toBe("[" + publicReply + "]");
      }),
  );

  it.effect("waits for the native configuration handshake and closes at 15 seconds", () =>
    Effect.gen(function* () {
      const h = yield* harness({ handshake: false });
      yield* Queue.offer(h.browser.incoming, request(1));
      yield* TestClock.adjust("14 seconds");
      expect(yield* Queue.size(h.upstream.outgoing)).toBe(0);
      expect(yield* Queue.size(h.browser.incoming)).toBe(1);
      yield* TestClock.adjust("1 second");
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
      yield* h.upstream.closed;
    }),
  );

  it.effect("closes on source identity changes after the initial handshake", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Queue.offer(
        h.upstream.incoming,
        encodeJson({
          _tag: "Chunk",
          requestId: h.configRequestId,
          values: [
            yield* encodeConfig({ version: 1, type: "snapshot", config: config("replacement") }),
          ],
        }),
      );
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
      yield* h.upstream.closed;
    }),
  );
  it.effect("retains completed IDs and caps lifetime tracking at exactly 10,000", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (let id = 0; id < 10_000; id++) {
        const raw = request(id);
        yield* Queue.offer(h.browser.incoming, raw);
        expect(yield* Queue.take(h.upstream.outgoing)).toBe(raw);
        const reply = encodeJson({
          _tag: "Exit",
          requestId: id,
          exit: { _tag: "Success", value: null },
        });
        yield* Queue.offer(h.upstream.incoming, reply);
        expect(yield* Queue.take(h.browser.outgoing)).toBe(reply);
      }
      yield* Queue.offer(h.browser.incoming, request(10_000));
      expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
      expect(yield* Queue.size(h.upstream.outgoing)).toBe(0);
      const duplicate = yield* harness();
      yield* Queue.offer(duplicate.browser.incoming, request(1));
      yield* Queue.take(duplicate.upstream.outgoing);
      yield* Queue.offer(
        duplicate.upstream.incoming,
        encodeJson({ _tag: "Exit", requestId: 1, exit: { _tag: "Success", value: null } }),
      );
      yield* Queue.take(duplicate.browser.outgoing);
      yield* Queue.offer(duplicate.browser.incoming, request(1));
      expect(Exit.isFailure(yield* Fiber.await(duplicate.fiber))).toBe(true);
    }),
  );

  it.effect("validates native JSON-coded dates without rewriting their payload", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const raw = request(6, "orchestration.dispatchCommand", {
        type: "thread.settle",
        commandId: "settle-id",
        threadId: "thread",
        settledAt: "2026-10-03T00:00:00.000Z",
      });
      yield* Queue.offer(h.browser.incoming, raw);
      expect(
        yield* Effect.raceFirst(
          Queue.take(h.upstream.outgoing),
          Fiber.join(h.fiber).pipe(
            Effect.andThen(Effect.die("Relay ended before native dated payload.")),
          ),
        ),
      ).toBe(raw);
    }),
  );
});
