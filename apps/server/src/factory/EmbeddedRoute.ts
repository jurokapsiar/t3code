import {
  FactoryEmbeddedRoute as FactoryEmbeddedRouteSchema,
  FactoryError,
  FactoryRegistrationId,
  FactoryRemoteTarget,
  type FactoryRemoteTarget as FactoryRemoteTargetType,
  type AuthEnvironmentScope,
  type FactoryEmbeddedRoute as FactoryEmbeddedRouteType,
  type ThreadId,
} from "@t3tools/contracts";
import { factoryRelayPrefix } from "@t3tools/contracts/factoryRelayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Connections from "./Connections.ts";
import * as RelayPolicy from "./RelayPolicy.ts";
import * as SourceShell from "./SourceShell.ts";

const isRemoteTarget = Schema.is(FactoryRemoteTarget);
const isRegistrationId = Schema.is(FactoryRegistrationId);
const decodeEmbeddedRoute = Schema.decodeEffect(FactoryEmbeddedRouteSchema);

export function factoryEmbeddedRouteHref(target: FactoryRemoteTargetType, threadId: ThreadId) {
  const search = new URLSearchParams({
    factoryEmbedded: "1",
    factoryRegistrationId: target.registrationId,
  });
  return (
    "/" +
    encodeURIComponent(target.environmentId) +
    "/" +
    encodeURIComponent(threadId) +
    "?" +
    search
  );
}

const errorForPolicy = (error: RelayPolicy.RelayDenied): FactoryError => {
  const code =
    error.reason === "source-stale"
      ? "source-stale"
      : error.reason === "source-protocol"
        ? "source-protocol"
        : error.reason === "source-authentication"
          ? "source-authentication"
          : error.reason === "target-mismatch" || error.reason === "invalid-target"
            ? "target-mismatch"
            : error.reason === "capability-required"
              ? "capability-required"
              : error.reason === "feature-disabled"
                ? "feature-disabled"
                : "source-unavailable";
  return new FactoryError({
    code,
    message:
      "Factory could not prepare this embedded thread. Check the source connection and permissions.",
  });
};

const errorForSource = (error: Connections.SourceFailure): FactoryError =>
  new FactoryError({
    code:
      error.reason === "identity"
        ? "target-mismatch"
        : error.reason === "protocol"
          ? "source-protocol"
          : error.reason === "authentication"
            ? "source-authentication"
            : "source-unavailable",
    message:
      "Factory could not prepare this embedded thread. Check the source connection and permissions.",
  });

export class EmbeddedRoute extends Context.Service<
  EmbeddedRoute,
  {
    readonly get: (input: {
      readonly target: FactoryRemoteTargetType;
      readonly threadId: ThreadId;
      readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<FactoryEmbeddedRouteType, FactoryError>;
  }
>()("t3/factory/EmbeddedRoute") {}

export const layer = Layer.effect(
  EmbeddedRoute,
  Effect.gen(function* () {
    const policy = yield* RelayPolicy.RelayPolicy;
    const sourceShell = yield* SourceShell.SourceShell;
    const get = Effect.fn("FactoryEmbeddedRoute.get")(function* (input: {
      readonly target: FactoryRemoteTargetType;
      readonly threadId: ThreadId;
      readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
    }) {
      if (!isRemoteTarget(input.target) || !isRegistrationId(input.target.registrationId))
        return yield* new FactoryError({
          code: "target-mismatch",
          message: "Factory could not prepare this embedded thread. Check the source target.",
        });
      const prefix = factoryRelayPrefix(input.target.registrationId);
      if (prefix === null)
        return yield* new FactoryError({
          code: "target-mismatch",
          message: "Factory could not prepare this embedded thread. Check the source target.",
        });

      const access = yield* policy
        .authorize({
          target: input.target,
          callerScopes: input.callerScopes,
          method: "subscribeServerConfig",
          payload: {},
        })
        .pipe(Effect.mapError(errorForPolicy));
      yield* policy
        .authorize({
          target: input.target,
          callerScopes: input.callerScopes,
          method: "orchestration.subscribeShell",
          payload: {},
        })
        .pipe(Effect.mapError(errorForPolicy));
      yield* policy
        .authorize({
          target: input.target,
          callerScopes: input.callerScopes,
          method: "orchestration.subscribeThread",
          payload: { threadId: input.threadId, acceptBoundedSnapshot: true },
        })
        .pipe(Effect.mapError(errorForPolicy));

      const fresh = yield* sourceShell.isSynchronized(access).pipe(Effect.mapError(errorForSource));
      if (!fresh)
        return yield* new FactoryError({
          code: "source-stale",
          message: "The source is not up to date. Wait for it to sync, then try again.",
        });
      const states = yield* sourceShell.getStates;
      const source = states.find(
        (state) =>
          state.target.registrationId === input.target.registrationId &&
          state.target.environmentId === input.target.environmentId,
      );
      if (
        source === undefined ||
        source.freshness.state !== "fresh" ||
        !source.threads.some(
          (thread) =>
            thread.target.registrationId === input.target.registrationId &&
            thread.key.environmentId === input.target.environmentId &&
            thread.key.threadId === input.threadId,
        )
      )
        return yield* new FactoryError({
          code: "not-found",
          message: "The requested source thread is not available.",
        });

      yield* access.checkCurrent.pipe(Effect.mapError(errorForSource));
      const route = {
        target: input.target,
        threadId: input.threadId,
        href: factoryEmbeddedRouteHref(input.target, input.threadId),
        sourceAccess: {
          websocketRoute: prefix + "ws",
          httpPrefix: prefix,
          capabilities: { websocket: true, http: true },
        },
      } satisfies FactoryEmbeddedRouteType;
      return yield* decodeEmbeddedRoute(route).pipe(
        Effect.mapError(
          () =>
            new FactoryError({
              code: "operation-failed",
              message: "Factory could not prepare this embedded thread.",
            }),
        ),
      );
    });
    return EmbeddedRoute.of({ get });
  }),
);

export type EmbeddedRouteService = EmbeddedRoute["Service"];
