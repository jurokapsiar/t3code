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
import * as Connections from "./Connections.ts";
import * as NodeSource from "./NodeSource.ts";
import * as SourceShell from "./SourceShell.ts";

export class FactoryRuntime extends Context.Service<
  FactoryRuntime,
  {
    readonly enabled: boolean;
    readonly getMetadata: Effect.Effect<Metadata.Metadata["Service"], FactoryError>;
    readonly getConnections: Effect.Effect<Connections.Connections["Service"], FactoryError>;
    readonly getSourceShell: Effect.Effect<SourceShell.SourceShell["Service"], FactoryError>;
    readonly getEnrollment: Effect.Effect<
      Enrollment.Enrollment["Service"],
      FactoryError | CredentialStore.CredentialStoreError | Enrollment.SourceCredentialExchangeError
    >;
  }
>()("t3/factory/runtimeLayer/FactoryRuntime") {}

export interface FactoryRuntimeOptions {
  readonly sourceTransportLayer?: Layer.Layer<Connections.SourceTransport>;
}

const disabledError = new FactoryError({
  code: "feature-disabled",
  message: "Factory mode is disabled. Start the server with --factory to enable it.",
});

export const layer = ({
  sourceTransportLayer = NodeSource.nodeLayer,
}: FactoryRuntimeOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      if (!config.factoryEnabled) {
        return Layer.succeed(FactoryRuntime, {
          enabled: false,
          getMetadata: Effect.fail(disabledError),
          getConnections: Effect.fail(disabledError),
          getSourceShell: Effect.fail(disabledError),
          getEnrollment: Effect.fail(disabledError),
        });
      }

      const sharedDependenciesLayer = Layer.mergeAll(
        CredentialStore.layer.pipe(Layer.provideMerge(CredentialStore.keyringLayer)),
        Enrollment.sourceLayer,
        sourceTransportLayer,
        Metadata.layer,
        ServerEnvironment.identityLayer,
      );
      const renewalDependenciesLayer = CredentialRenewal.layer.pipe(
        Layer.provideMerge(sharedDependenciesLayer),
      );
      const connectionsLayer = Connections.layer.pipe(Layer.provideMerge(renewalDependenciesLayer));
      const sourceShellLayer = SourceShell.layer.pipe(Layer.provideMerge(connectionsLayer));
      const enrollmentLayer = Enrollment.layer.pipe(
        Layer.provideMerge(
          Connections.registrationLifecycleLayer.pipe(Layer.provideMerge(sourceShellLayer)),
        ),
      );

      return Layer.effect(
        FactoryRuntime,
        Effect.gen(function* () {
          const enrollment = yield* Enrollment.Enrollment;
          const renewal = yield* CredentialRenewal.CredentialRenewal;
          const connections = yield* Connections.Connections;
          const sourceShell = yield* SourceShell.SourceShell;
          yield* connections.start;
          yield* sourceShell.start;
          yield* enrollment.reconcile.pipe(
            Effect.catchTags({
              CredentialStoreError: (error) => Effect.logWarning(error.message),
              FactoryError: (error) => Effect.logWarning(error.message),
            }),
          );
          yield* renewal.start;
          const metadata = yield* Metadata.Metadata;
          return {
            enabled: true,
            getMetadata: Effect.succeed(metadata),
            getConnections: Effect.succeed(connections),
            getSourceShell: Effect.succeed(sourceShell),
            getEnrollment: Effect.succeed(enrollment),
          };
        }),
      ).pipe(Layer.provide(enrollmentLayer));
    }),
  );
