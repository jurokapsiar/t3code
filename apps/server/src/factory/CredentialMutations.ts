import type { FactoryRegistrationId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class CredentialMutations extends Context.Service<
  CredentialMutations,
  {
    readonly withLock: <A, E, R>(
      registrationId: FactoryRegistrationId,
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/factory/CredentialMutations") {}

const make = Effect.sync(() => {
  const locks = new Map<FactoryRegistrationId, { semaphore: Semaphore.Semaphore; users: number }>();
  const withLock: CredentialMutations["Service"]["withLock"] = (registrationId, operation) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        let entry = locks.get(registrationId);
        if (entry === undefined) {
          entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          locks.set(registrationId, entry);
        }
        entry.users += 1;
        return entry;
      }),
      (entry) => entry.semaphore.withPermits(1)(operation),
      (entry) =>
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0) locks.delete(registrationId);
        }),
    );
  return CredentialMutations.of({ withLock });
});

export const layer = Layer.effect(CredentialMutations, make);
