import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PrimaryEnvironmentHttpClient } from "../src/environments/primary/httpClient";
import { runPrimaryHttp } from "../src/lib/runtime";
import { installEnvironmentHttpTest } from "./environmentHttpTest";

let disposeHttpTest: (() => Promise<void>) | undefined;

describe("environment HTTP test renewal endpoint", () => {
  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
  });

  it("returns the contract's 401 errors for missing and non-renewable credentials", async () => {
    const testApi = await installEnvironmentHttpTest({});
    disposeHttpTest = testApi.dispose;

    const renew = (authorization?: string) =>
      runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            Effect.flip(
              client.auth.renew({
                headers: authorization === undefined ? {} : { authorization },
                payload: {},
              }),
            ),
          ),
        ),
      );

    const missingCredentialError = await renew();
    expect(missingCredentialError).toBeInstanceOf(EnvironmentAuthInvalidError);
    expect(missingCredentialError).toMatchObject({ reason: "missing_credential" });
    expect(await renew("Bearer test-token")).toMatchObject({ reason: "invalid_credential" });
  });
  it("rejects actual typed release requests without a releasable bearer principal", async () => {
    const testApi = await installEnvironmentHttpTest({});
    disposeHttpTest = testApi.dispose;
    const release = (authorization?: string) =>
      runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            Effect.flip(
              client.auth.renewRelease({
                headers: authorization === undefined ? {} : { authorization },
              }),
            ),
          ),
        ),
      );
    for (const authorization of [
      undefined,
      "",
      "Basic fixture",
      "Bearer ",
      "Bearer cookie-principal",
    ]) {
      const error = await release(authorization);
      expect(error).toBeInstanceOf(EnvironmentAuthInvalidError);
      expect(error).toMatchObject({
        code: "auth_invalid",
        reason:
          authorization === "Bearer cookie-principal" ? "invalid_credential" : "missing_credential",
      });
    }
  });
});
