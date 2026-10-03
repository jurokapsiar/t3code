import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";

const Frame = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  requestId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  tag: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
const decodeFrame = Schema.decodeSync(Schema.fromJsonString(Frame));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class FakeSocket implements Socket.WebSocketLike {
  readyState = 1;
  private readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
  readonly url: string;
  readonly frames: Queue.Queue<typeof Frame.Type>;
  readonly closed: Deferred.Deferred<void>;
  constructor(
    url: string,
    frames: Queue.Queue<typeof Frame.Type>,
    closed: Deferred.Deferred<void>,
  ) {
    this.url = url;
    this.frames = frames;
    this.closed = closed;
  }
  addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string | Uint8Array<ArrayBuffer>) {
    Queue.offerUnsafe(
      this.frames,
      decodeFrame(typeof data === "string" ? data : new TextDecoder().decode(data)),
    );
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code, reason });
    Deferred.doneUnsafe(this.closed, Effect.void);
  }
  message(value: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: encode(value) });
  }
}

export const make = Effect.gen(function* () {
  const sockets = yield* Queue.unbounded<FakeSocket>();
  const frames = yield* Queue.unbounded<typeof Frame.Type>();
  const closed = yield* Deferred.make<void>();
  const layer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new FakeSocket(url, frames, closed);
    Queue.offerUnsafe(sockets, socket);
    return socket;
  });
  return { layer, sockets, frames, closed: Deferred.await(closed) };
});
