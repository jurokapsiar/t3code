import { assert, it } from "@effect/vitest";
import { FactoryRegistrationId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as CredentialMutations from "./CredentialMutations.ts";

const a = FactoryRegistrationId.make("source-a");
const b = FactoryRegistrationId.make("source-b");

it.effect(
  "queues only the same registration while a slow source holds its credential mutation",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(CredentialMutations.layer);
      const mutations = Context.get(services, CredentialMutations.CredentialMutations);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const attempted = yield* Deferred.make<void>();
      const order: string[] = [];
      const first = yield* mutations
        .withLock(
          a,
          Effect.gen(function* () {
            order.push("a-first");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* Deferred.succeed(attempted, undefined).pipe(
        Effect.andThen(
          mutations.withLock(
            a,
            Effect.sync(() => {
              order.push("a-second");
            }),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(attempted);
      yield* mutations.withLock(
        b,
        Effect.sync(() => {
          order.push("b");
        }),
      );
      assert.deepEqual(order, ["a-first", "b"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(order, ["a-first", "b", "a-second"]);
    }),
);

it.effect("cancels waiters and holders without releasing another mutation's permit", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(CredentialMutations.layer);
    const mutations = Context.get(services, CredentialMutations.CredentialMutations);
    const entered = yield* Deferred.make<void>();
    const attempted = yield* Deferred.make<void>();
    const order: string[] = [];
    const holder = yield* mutations
      .withLock(a, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const waiter = yield* Deferred.succeed(attempted, undefined).pipe(
      Effect.andThen(
        mutations.withLock(
          a,
          Effect.sync(() => {
            order.push("canceled");
          }),
        ),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(attempted);
    yield* Fiber.interrupt(waiter);
    const nextAttempt = yield* Deferred.make<void>();
    const next = yield* Deferred.succeed(nextAttempt, undefined).pipe(
      Effect.andThen(
        mutations.withLock(
          a,
          Effect.sync(() => {
            order.push("next");
          }),
        ),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(nextAttempt);
    assert.deepEqual(order, []);
    yield* Fiber.interrupt(holder);
    yield* Fiber.join(next);
    yield* mutations.withLock(
      a,
      Effect.sync(() => {
        order.push("after");
      }),
    );
    assert.deepEqual(order, ["next", "after"]);
  }),
);
