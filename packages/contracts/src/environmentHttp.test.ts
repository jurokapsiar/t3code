import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import {
  AuthTokenExchangeRequest,
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
} from "./index.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  AuthSessionRenewalRequest,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";

const traceId = "trace-1";

const decodeRenewalRequest = Schema.decodeUnknownSync(AuthSessionRenewalRequest);
const decodeTokenExchange = Schema.decodeUnknownSync(AuthTokenExchangeRequest);
const sharedPayloadEndpoint = HttpApiEndpoint.post("shared", "/shared", {
  payload: AuthTokenExchangeRequest,
});

describe("environment HTTP errors", () => {
  it("owns form encoding at the OAuth endpoint, not the shared auth schema", () => {
    expect(sharedPayloadEndpoint.payload.has("application/json")).toBe(true);
    expect(sharedPayloadEndpoint.payload.has("application/x-www-form-urlencoded")).toBe(false);
    const payload = EnvironmentHttpApi.groups.auth.endpoints.token.payload.get(
      "application/x-www-form-urlencoded",
    );
    if (!payload) throw new Error("OAuth token exchange must accept form posts");
    const input = {
      grant_type: AuthTokenExchangeGrantType,
      subject_token: "pairing-token",
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      client_label: "POSIX desktop",
      client_device_type: "desktop",
      client_os: "macOS",
    };
    expect(decodeTokenExchange(input)).toEqual(input);
    expect(payload.encoding._tag).toBe("FormUrlEncoded");
    expect(() => decodeTokenExchange({ ...input, grant_type: "invalid" })).toThrow();
  });

  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });

  it("decodes optional renewal scopes for older clients", () => {
    expect(decodeRenewalRequest({})).toEqual({});
    expect(decodeRenewalRequest({ scopes: ["orchestration:read"] })).toEqual({
      scopes: ["orchestration:read"],
    });
  });
});
