import { FactoryError, FactoryRpcGroup, FactoryRpcMethods } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { authorizeRpcEffect, requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "../observability/RpcInstrumentation.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as Enrollment from "./Enrollment.ts";
import * as FactoryRuntime from "./runtimeLayer.ts";

const isFactoryError = Schema.is(FactoryError);

const safeFactoryEnrollmentError = (
  error:
    | FactoryError
    | CredentialStore.CredentialStoreError
    | Enrollment.SourceCredentialExchangeError,
) =>
  isFactoryError(error)
    ? error
    : new FactoryError({
        code: "operation-failed",
        message:
          "Factory could not complete this operation. Verify the source and credential store, then retry.",
      });

export const makeFactoryRpcHandlers = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  factoryRuntime: FactoryRuntime.FactoryRuntime["Service"],
) => {
  const observeRpcEffect = <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) =>
    instrumentRpcEffect(
      method,
      authorizeRpcEffect(currentSession.scopes, requiredScopeForRpcMethod(method), effect),
      traceAttributes,
    );
  const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
    method: string,
    effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) =>
    instrumentRpcStreamEffect(
      method,
      authorizeRpcEffect(currentSession.scopes, requiredScopeForRpcMethod(method), effect),
      traceAttributes,
    );

  return FactoryRpcGroup.of({
    [FactoryRpcMethods.overviewSubscribe]: (_input) =>
      observeRpcStreamEffect(
        FactoryRpcMethods.overviewSubscribe,
        factoryRuntime.getOverview.pipe(Effect.map((overview) => overview.subscribe)),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.environmentsEnroll]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.environmentsEnroll,
        factoryRuntime.getEnrollment.pipe(
          Effect.flatMap((enrollment) => enrollment.enroll(input)),
          Effect.mapError(safeFactoryEnrollmentError),
        ),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.environmentsList]: (_input) =>
      observeRpcEffect(
        FactoryRpcMethods.environmentsList,
        factoryRuntime.getMetadata.pipe(Effect.flatMap((metadata) => metadata.listEnvironments)),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.environmentsUpdate]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.environmentsUpdate,
        factoryRuntime.getConnections.pipe(
          Effect.flatMap((connections) => connections.updateEnvironment(input)),
        ),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.environmentsRemove]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.environmentsRemove,
        factoryRuntime.getEnrollment.pipe(
          Effect.flatMap((enrollment) => enrollment.remove(input)),
          Effect.mapError(safeFactoryEnrollmentError),
        ),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.environmentsRetry]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.environmentsRetry,
        factoryRuntime.getConnections.pipe(
          Effect.flatMap((connections) =>
            connections.retry(input.registrationId).pipe(
              Effect.mapError(
                () =>
                  new FactoryError({
                    code: "operation-failed",
                    message: "Enable the source before retrying its connection.",
                  }),
              ),
            ),
          ),
          Effect.as({ requested: true }),
        ),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.groupsList]: (_input) =>
      observeRpcEffect(
        FactoryRpcMethods.groupsList,
        factoryRuntime.getMetadata.pipe(
          Effect.flatMap((metadata) => metadata.getSnapshot),
          Effect.map(({ groups, memberships }) => ({ groups, memberships })),
        ),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.groupsCreate]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.groupsCreate,
        factoryRuntime.getMetadata.pipe(Effect.flatMap((metadata) => metadata.createGroup(input))),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.groupsUpdate]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.groupsUpdate,
        factoryRuntime.getMetadata.pipe(Effect.flatMap((metadata) => metadata.renameGroup(input))),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.groupsDelete]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.groupsDelete,
        factoryRuntime.getMetadata.pipe(Effect.flatMap((metadata) => metadata.deleteGroup(input))),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.groupsAssign]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.groupsAssign,
        factoryRuntime.getMetadata.pipe(
          Effect.flatMap((metadata) => metadata.assignProject(input)),
        ),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.groupsUnassign]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.groupsUnassign,
        factoryRuntime.getMetadata.pipe(
          Effect.flatMap((metadata) => metadata.unassignProject(input)),
        ),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.favoritesSet]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.favoritesSet,
        factoryRuntime.getMetadata.pipe(Effect.flatMap((metadata) => metadata.setFavorite(input))),
        { "rpc.aggregate": "factory" },
      ),
    [FactoryRpcMethods.favoritesReorder]: (input) =>
      observeRpcEffect(
        FactoryRpcMethods.favoritesReorder,
        factoryRuntime.getMetadata.pipe(
          Effect.flatMap((metadata) => metadata.reorderFavorites(input)),
        ),
        { "rpc.aggregate": "factory" },
      ),
  });
};
