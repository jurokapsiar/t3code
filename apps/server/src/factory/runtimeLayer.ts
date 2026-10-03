import { FactoryError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as CredentialRenewal from "./CredentialRenewal.ts";
import * as Enrollment from "./Enrollment.ts";
import * as Metadata from "./Metadata.ts";

export class FactoryRuntime extends Context.Service<
  FactoryRuntime,
  {
    readonly enabled: boolean;
    readonly getMetadata: Effect.Effect<Metadata.Metadata["Service"], FactoryError>;
    readonly getEnrollment: Effect.Effect<
      Enrollment.Enrollment["Service"],
      FactoryError | CredentialStore.CredentialStoreError | Enrollment.SourceCredentialExchangeError
    >;
  }
>()("t3/factory/runtimeLayer/FactoryRuntime") {}

export interface FactoryRuntimeOptions {
  readonly startConnections?: () => Effect.Effect<void>;
  readonly registrationLifecycleLayer?: Layer.Layer<Enrollment.RegistrationLifecycle>;
}

const disabledError = new FactoryError({
  code: "feature-disabled",
  message: "Factory mode is disabled. Start the server with --factory to enable it.",
});

export const layer = ({
  startConnections = () => Effect.void,
  registrationLifecycleLayer = Enrollment.registrationLifecycleLayer,
}: FactoryRuntimeOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      if (!config.factoryEnabled) {
        return Layer.succeed(FactoryRuntime, {
          enabled: false,
          getMetadata: Effect.fail(disabledError),
          getEnrollment: Effect.fail(disabledError),
        });
      }

      const enrollmentDependenciesLayer = Layer.mergeAll(
        CredentialStore.layer.pipe(Layer.provideMerge(CredentialStore.keyringLayer)),
        Enrollment.sourceLayer,
        registrationLifecycleLayer,
        Metadata.layer,
        ServerEnvironment.identityLayer,
      );
      const renewalDependenciesLayer = CredentialRenewal.layer.pipe(
        Layer.provideMerge(enrollmentDependenciesLayer),
      );
      const enrollmentLayer = Enrollment.layer.pipe(Layer.provideMerge(renewalDependenciesLayer));

      return Layer.effect(
        FactoryRuntime,
        Effect.gen(function* () {
          const enrollment = yield* Enrollment.Enrollment;
          const renewal = yield* CredentialRenewal.CredentialRenewal;
          yield* enrollment.reconcile;
          yield* startConnections();
          yield* renewal.start;
          const metadata = yield* Metadata.Metadata;
          return {
            enabled: true,
            getMetadata: Effect.succeed(metadata),
            getEnrollment: Effect.succeed(enrollment),
          };
        }),
      ).pipe(Layer.provide(enrollmentLayer));
    }),
  );
