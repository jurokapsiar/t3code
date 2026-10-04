import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ServerConfigStreamEvent,
  WsRpcGroup,
  type AuthEnvironmentScope,
  type FactoryRemoteTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as Socket from "effect/unstable/socket/Socket";
import * as Connections from "./Connections.ts";
import * as RelayPolicy from "./RelayPolicy.ts";

export const RELAY_MAX_REQUEST_BYTES = 1024 * 1024;
export const RELAY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const RELAY_MAX_ITEMS = 128;
const configId = "-1";
// The native envelope has binary codec holes. JSON fills those holes with JSON
// values; retain its actual envelope fields rather than inventing another RPC.
const Request = Schema.Struct({
  ...RpcMessage.EncodedSchema.members[0].fields,
  payload: Schema.Unknown,
});
const Controls = Schema.Union([
  RpcMessage.EncodedSchema.members[1],
  RpcMessage.EncodedSchema.members[2],
  RpcMessage.EncodedSchema.members[3],
  RpcMessage.EncodedSchema.members[4],
]);
const Chunk = Schema.Struct({
  ...RpcMessage.EncodedSchema.members[5].fields,
  values: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1)),
});
const JsonExit = Schema.toEncoded(
  Schema.toCodecJson(Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Unknown)),
);
const Response = Schema.Union([
  Chunk,
  Schema.Struct({ ...RpcMessage.EncodedSchema.members[6].fields, exit: JsonExit }),
  Schema.Struct({ ...RpcMessage.EncodedSchema.members[7].fields, defect: Schema.Unknown }),
  RpcMessage.EncodedSchema.members[8],
]);
const strict = { onExcessProperty: "error" } as const;
const exact = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema, strict);
  return (value: unknown): value is S["Type"] => Option.isSome(decode(value));
};
const isRequest = exact(Request);
const isControl = exact(Controls);
const isResponse = exact(Response);
const JsonFrame = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonFrame);
const decodeJson = Schema.decodeEffect(JsonFrame);
const decodeConfig = Schema.decodeUnknownEffect(Schema.toCodecJson(ServerConfigStreamEvent));
const isId = (id: string | number) =>
  typeof id === "number" ? Number.isSafeInteger(id) && id >= 0 : id.length > 0 && id.length <= 128;

type Classification =
  | { readonly kind: "request"; readonly frame: typeof Request.Type }
  | {
      readonly kind: "control";
      readonly frame:
        | RpcMessage.AckEncoded
        | RpcMessage.InterruptEncoded
        | RpcMessage.Ping
        | RpcMessage.Eof;
    }
  | {
      readonly kind: "reject";
      readonly reason: "invalid-frame" | "method-not-allowed" | "invalid-headers";
    };
export const classifyRelayFrame = (frame: unknown): Classification => {
  if (isRequest(frame)) {
    if (
      !isId(frame.id) ||
      frame.id === configId ||
      frame.isNotification ||
      frame.payload === undefined
    )
      return { kind: "reject", reason: "invalid-frame" };
    if (frame.headers.length !== 0) return { kind: "reject", reason: "invalid-headers" };
    if (!Object.hasOwn(RelayPolicy.relayPolicy, frame.tag))
      return { kind: "reject", reason: "method-not-allowed" };
    return { kind: "request", frame };
  }
  if (isControl(frame) && (frame._tag === "Ping" || frame._tag === "Eof" || isId(frame.requestId)))
    return { kind: "control", frame };
  return { kind: "reject", reason: "invalid-frame" };
};

export class RelayRejected extends Schema.TaggedError<RelayRejected>()("RelayRejected", {
  reason: Schema.Literals([
    "invalid-frame",
    "method-not-allowed",
    "invalid-headers",
    "frame-too-large",
    "too-many-items",
    "duplicate-id",
    "tracking-limit",
    "unknown-id",
    "invalid-ack",
    "invalid-payload",
    "source-protocol",
    "target-mismatch",
  ]),
}) {
  override get message() {
    return `The source relay closed: ${this.reason}.`;
  }
}
export class Relay extends Context.Service<
  Relay,
  {
    readonly serve: (input: {
      readonly socket: Socket.Socket;
      readonly target: FactoryRemoteTarget;
      readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<
      void,
      RelayRejected | RelayPolicy.RelayDenied | Connections.SourceFailure | Socket.SocketError
    >;
  }
>()("t3/factory/Relay") {}

const decodeFrame = (raw: string | Uint8Array, limit: number) =>
  Effect.gen(function* () {
    const bytes =
      typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (bytes > limit) return yield* new RelayRejected({ reason: "frame-too-large" });
    const text = yield* Effect.try({
      try: () =>
        typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw),
      catch: () => new RelayRejected({ reason: "invalid-frame" }),
    });
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(() => new RelayRejected({ reason: "invalid-frame" })),
    );
    const frames: ReadonlyArray<unknown> = Array.isArray(decoded) ? decoded : [decoded];
    if (frames.length === 0 || frames.length > RELAY_MAX_ITEMS)
      return yield* new RelayRejected({ reason: "too-many-items" });
    return frames;
  });

// Only mixed batches need surgery: remove the private handshake envelope while
// retaining the original JSON text of every public response, including its holes.
const batchSegments = (raw: string | Uint8Array) => {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const segments: string[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[" || char === "{") {
      if (depth++ === 0) start = i + 1;
    } else if (char === "]" || char === "}") {
      if (--depth === 0) segments.push(text.slice(start, i));
    } else if (char === "," && depth === 1) {
      segments.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return segments;
};

const make = Effect.gen(function* () {
  const policy = yield* RelayPolicy.RelayPolicy;
  const connections = yield* Connections.Connections;
  const decodePayloads = new Map(
    [...WsRpcGroup.requests].map(([tag, rpc]) => [
      tag,
      Schema.decodeUnknownEffect(Schema.toCodecJson(rpc.payloadSchema)),
    ]),
  );

  const serve: Relay["Service"]["serve"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const access = yield* policy.authorize({
          ...input,
          method: "subscribeServerConfig",
          payload: {},
        });
        const upstream = yield* connections.openRelay(access);
        const sourceReader = yield* upstream.reader;
        const sourceWriter = yield* upstream.writer;
        const browserReader = yield* input.socket.reader;
        const browserWriter = yield* input.socket.writer;
        yield* Effect.addFinalizer(() =>
          browserWriter
            .write(new Socket.CloseEvent(1008, "Source relay closed."))
            .pipe(Effect.catchTag("SocketError", () => Effect.void)),
        );
        const ready = yield* Deferred.make<void>();
        const requests = new Map<string | number, { ack: boolean; interrupted: boolean }>();
        // Native Ack/Interrupt can race Exit. Retain only a bounded recent grace window,
        // never completed requests in the active/concurrency accounting.
        const completed = new Map<string | number, { ack: boolean; interrupted: boolean }>();
        let eof = false;
        yield* sourceWriter.write(
          encodeJson({
            _tag: "Request",
            id: configId,
            tag: "subscribeServerConfig",
            payload: {},
            headers: [],
          }),
        );
        const sourceLoop = Effect.gen(function* () {
          while (true) {
            for (const raw of yield* sourceReader.pull) {
              const frames = yield* decodeFrame(raw, RELAY_MAX_RESPONSE_BYTES);
              let internal = false;
              const publicIndexes: number[] = [];
              for (const [index, frame] of frames.entries()) {
                if (!isResponse(frame))
                  return yield* new RelayRejected({ reason: "invalid-frame" });
                if (frame._tag === "Chunk" || frame._tag === "Exit") {
                  if (!isId(frame.requestId))
                    return yield* new RelayRejected({ reason: "invalid-frame" });
                  if (frame.requestId === configId) {
                    internal = true;
                    if (frame._tag !== "Chunk")
                      return yield* new RelayRejected({ reason: "source-protocol" });
                    for (const value of frame.values) {
                      const event = yield* decodeConfig(value).pipe(
                        Effect.mapError(() => new RelayRejected({ reason: "source-protocol" })),
                      );
                      if (event.type === "snapshot") {
                        if (event.config.environment.environmentId !== input.target.environmentId)
                          return yield* new RelayRejected({ reason: "target-mismatch" });
                        if (
                          event.config.environment.orchestrationProtocolVersion !==
                          ORCHESTRATION_PROTOCOL_VERSION
                        )
                          return yield* new RelayRejected({ reason: "source-protocol" });
                        yield* Deferred.succeed(ready, undefined);
                      } else if (!(yield* Deferred.isDone(ready)))
                        return yield* new RelayRejected({ reason: "source-protocol" });
                    }
                    yield* sourceWriter.write(encodeJson({ _tag: "Ack", requestId: configId }));
                    continue;
                  }
                  const tracked = requests.get(frame.requestId);
                  if (tracked === undefined)
                    return yield* new RelayRejected({ reason: "unknown-id" });
                  if (frame._tag === "Exit") {
                    requests.delete(frame.requestId);
                    if (completed.size >= RELAY_MAX_ITEMS) {
                      const oldest = completed.keys().next();
                      if (!oldest.done) completed.delete(oldest.value);
                    }
                    completed.set(frame.requestId, tracked);
                  } else {
                    if (tracked.ack) return yield* new RelayRejected({ reason: "invalid-ack" });
                    tracked.ack = true;
                  }
                }
                publicIndexes.push(index);
              }
              if (!internal) yield* browserWriter.write(raw);
              else if (publicIndexes.length !== 0) {
                const segments = batchSegments(raw);
                yield* browserWriter.write(
                  `[${publicIndexes.map((index) => segments[index]).join(",")}]`,
                );
              }
            }
          }
        });
        const browserLoop = Effect.gen(function* () {
          yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () => Effect.fail(new RelayRejected({ reason: "source-protocol" })),
            }),
          );
          while (true) {
            for (const raw of yield* browserReader.pull) {
              const frames = yield* decodeFrame(raw, RELAY_MAX_REQUEST_BYTES);
              for (const value of frames) {
                const classified = classifyRelayFrame(value);
                if (classified.kind === "reject")
                  return yield* new RelayRejected({ reason: classified.reason });
                const frame = classified.frame;
                if (frame._tag === "Request") {
                  if (eof || requests.has(frame.id) || completed.has(frame.id))
                    return yield* new RelayRejected({ reason: "duplicate-id" });
                  if (requests.size >= RELAY_MAX_ITEMS)
                    return yield* new RelayRejected({ reason: "tracking-limit" });
                  const decodePayload = decodePayloads.get(frame.tag);
                  if (decodePayload === undefined)
                    return yield* new RelayRejected({ reason: "method-not-allowed" });
                  yield* decodePayload(frame.payload).pipe(
                    Effect.mapError(() => new RelayRejected({ reason: "invalid-payload" })),
                  );
                  const current = yield* policy.authorize({
                    target: input.target,
                    method: frame.tag,
                    payload: frame.payload,
                    callerScopes: input.callerScopes,
                  });
                  if (current.connectionId !== access.connectionId)
                    return yield* new RelayRejected({ reason: "target-mismatch" });
                  yield* current.checkCurrent;
                  requests.set(frame.id, { ack: false, interrupted: false });
                } else {
                  yield* access.checkCurrent;
                  if (frame._tag === "Eof") eof = true;
                  else if (frame._tag !== "Ping") {
                    const tracked = requests.get(frame.requestId) ?? completed.get(frame.requestId);
                    if (tracked === undefined)
                      return yield* new RelayRejected({ reason: "unknown-id" });
                    if (frame._tag === "Ack") {
                      if (!tracked.ack) return yield* new RelayRejected({ reason: "invalid-ack" });
                      tracked.ack = false;
                    } else {
                      if (tracked.interrupted)
                        return yield* new RelayRejected({ reason: "unknown-id" });
                      tracked.interrupted = true;
                    }
                  }
                }
              }
              yield* sourceWriter.write(raw);
            }
          }
        });
        return yield* Effect.raceFirst(access.closed, Effect.raceFirst(sourceLoop, browserLoop));
      }),
    );
  return Relay.of({ serve });
});
export const layer = Layer.effect(Relay, make);
