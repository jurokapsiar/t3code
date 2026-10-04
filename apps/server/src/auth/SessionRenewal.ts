import {
  AuthSessionId,
  type AuthEnvironmentScope,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as SessionStore from "./SessionStore.ts";

export type Issuer = Pick<SessionStore.SessionStore["Service"], "verify" | "issueRenewal">;

export interface AuthenticatedSessionPrincipal {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export type RenewalScopeSelection =
  | { readonly ok: true; readonly scopes: ReadonlyArray<AuthEnvironmentScope> }
  | { readonly ok: false; readonly reason: "scope-widening" | "empty-scope-set" };

export function selectRenewalScopes(input: {
  readonly current: ReadonlyArray<AuthEnvironmentScope>;
  readonly requested?: ReadonlyArray<AuthEnvironmentScope>;
}): RenewalScopeSelection {
  const requested = input.requested ?? input.current;
  if (requested.length === 0) {
    return { ok: false, reason: "empty-scope-set" };
  }
  const currentScopes = new Set(input.current);
  if (requested.some((scope) => !currentScopes.has(scope))) {
    return { ok: false, reason: "scope-widening" };
  }
  const requestedScopes = new Set(requested);
  return {
    ok: true,
    scopes: input.current.filter((scope) => requestedScopes.has(scope)),
  };
}

export class SessionRenewalScopeError extends Schema.TaggedError<SessionRenewalScopeError>()(
  "SessionRenewalScopeError",
  { reason: Schema.Union([Schema.Literal("scope-widening"), Schema.Literal("empty-scope-set")]) },
) {
  override get message(): string {
    return this.reason === "scope-widening"
      ? "Renewal cannot add scopes to the current session."
      : "Renewal must retain at least one scope.";
  }
}

export class SessionRenewalCredentialError extends Schema.TaggedError<SessionRenewalCredentialError>()(
  "SessionRenewalCredentialError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The credential is not a valid bearer session for renewal.";
  }
}

export class SessionRenewalInternalError extends Schema.TaggedError<SessionRenewalInternalError>()(
  "SessionRenewalInternalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to renew the bearer session.";
  }
}

export type SessionRenewalError =
  | SessionRenewalScopeError
  | SessionRenewalCredentialError
  | SessionRenewalInternalError;

export interface SessionRenewalService {
  readonly renew: (input: {
    readonly credential: string;
    readonly principal: AuthenticatedSessionPrincipal;
    readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  }) => Effect.Effect<SessionStore.IssuedSession, SessionRenewalError>;
}

const mapVerificationError = (cause: SessionStore.SessionCredentialError) =>
  SessionStore.isSessionCredentialInvalidError(cause)
    ? new SessionRenewalCredentialError({ cause })
    : new SessionRenewalInternalError({ cause });

export const make = (issuer: Issuer): SessionRenewalService => ({
  renew: (input): Effect.Effect<SessionStore.IssuedSession, SessionRenewalError> => {
    const selection = selectRenewalScopes({
      current: input.principal.scopes,
      ...(input.requestedScopes === undefined ? {} : { requested: input.requestedScopes }),
    });
    if (!selection.ok) {
      return Effect.fail(new SessionRenewalScopeError({ reason: selection.reason }));
    }
    if (input.principal.method !== "bearer-access-token") {
      return Effect.fail(
        new SessionRenewalCredentialError({ cause: new Error("Unsupported session method.") }),
      );
    }
    return issuer.verify(input.credential).pipe(
      Effect.mapError(mapVerificationError),
      Effect.flatMap(
        (
          current,
        ): Effect.Effect<
          SessionStore.IssuedSession,
          SessionRenewalCredentialError | SessionRenewalInternalError
        > => {
          if (
            current.sessionId !== input.principal.sessionId ||
            current.subject !== input.principal.subject ||
            current.method !== "bearer-access-token" ||
            current.scopes.length !== input.principal.scopes.length ||
            current.scopes.some((scope, index) => scope !== input.principal.scopes[index])
          ) {
            return Effect.fail(
              new SessionRenewalCredentialError({ cause: new Error("Session identity changed.") }),
            );
          }
          return issuer
            .issueRenewal({
              parentSessionId: current.sessionId,
              subject: current.subject,
              scopes: selection.scopes,
              client: current.client,
              rootIssuedAt: current.rootIssuedAt,
            })
            .pipe(Effect.mapError(mapVerificationError));
        },
      ),
    );
  },
});
