import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Socket from "effect/unstable/socket/Socket";

export const memorySocket = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<string, Socket.SocketError>();
  const outgoing = yield* Queue.unbounded<string>();
  const closed = yield* Deferred.make<void>();
  const close = Queue.fail(
    incoming,
    new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) }),
  ).pipe(Effect.andThen(Deferred.succeed(closed, undefined)), Effect.asVoid);
  const socket = Socket.make({
    reader: Effect.acquireRelease(
      Effect.succeed({
        pull: Queue.take(incoming).pipe(Effect.map((frame) => [frame] as const)),
        upgrade: () => Effect.void,
      }),
      () => close,
    ),
    writer: Effect.succeed({
      write: (frame) =>
        Socket.isCloseEvent(frame)
          ? close
          : Queue.offer(
              outgoing,
              typeof frame === "string" ? frame : new TextDecoder().decode(frame),
            ).pipe(Effect.asVoid),
      writeAll: (frames) =>
        Effect.forEach(
          frames,
          (frame) =>
            Queue.offer(
              outgoing,
              typeof frame === "string" ? frame : new TextDecoder().decode(frame),
            ),
          { discard: true },
        ),
    }),
  });
  return { socket, incoming, outgoing, close, closed: Deferred.await(closed) };
});
