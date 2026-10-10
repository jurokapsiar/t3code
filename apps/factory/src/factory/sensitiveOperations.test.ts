import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { FactoryEnvironmentView } from "@t3tools/contracts/factory";
import { FactoryConnection, type FactoryRpcClient } from "./FactoryConnection";
import {
  enrollSensitiveCredential,
  SensitiveOperationError,
  serializeSensitiveOperationError,
} from "./sensitiveOperations";

const sourceStatus = Schema.decodeUnknownSync(FactoryEnvironmentView)({
  registrationId: "registration-1",
  environmentId: "environment-1",
  endpoint: "https://source.example",
  label: "Source",
  platform: { os: "linux", arch: "x64" },
  enabled: true,
  state: "offline",
  credentialStorage: "secure-vault",
  credentialExpiresAt: null,
  renewal: "ready",
  lastSeenAt: null,
  revision: 1,
});

describe("sensitive factory operations", () => {
  it.live("sends one enrollment request and returns only factory-observed status", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const client = new Proxy(
        {},
        {
          get: () => () =>
            Effect.sync(() => {
              requestCount += 1;
              return sourceStatus;
            }),
        },
      ) as FactoryRpcClient;
      const connection = new FactoryConnection({
        openTransport: async () => ({ factory: client, factoryId: "factory-1" }),
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => connection.stop()));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const unsubscribe = connection.subscribeStatus((status) => {
              if (status.phase !== "synchronizing") return;
              unsubscribe();
              resolve();
            });
            connection.start();
          }),
      );

      const result = yield* Effect.promise(() =>
        enrollSensitiveCredential(connection, {
          endpoint: "https://source.example",
          label: "Source",
          sourceCredential: "fake-enrollment-secret",
        }),
      );

      expect(requestCount).toBe(1);
      expect(result).toEqual(sourceStatus);
      expect(JSON.stringify(result)).not.toContain("fake-enrollment-secret");
    }),
  );

  it.live("does not expose enrollment credentials in RPC errors or serialized errors", () =>
    Effect.gen(function* () {
      const secret = "fake-enrollment-secret";
      let requestCount = 0;
      const client = new Proxy(
        {},
        {
          get: () => () =>
            Effect.sync(() => {
              requestCount += 1;
            }).pipe(Effect.andThen(Effect.fail(new Error(secret)))),
        },
      ) as FactoryRpcClient;
      const connection = new FactoryConnection({
        openTransport: async () => ({ factory: client, factoryId: "factory-1" }),
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => connection.stop()));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const unsubscribe = connection.subscribeStatus((status) => {
              if (status.phase !== "synchronizing") return;
              unsubscribe();
              resolve();
            });
            connection.start();
          }),
      );

      const operationError = yield* Effect.promise(() =>
        enrollSensitiveCredential(connection, {
          endpoint: "https://source.example",
          label: "Source",
          sourceCredential: secret,
        }).catch((error: unknown) => error),
      );
      const serialized = serializeSensitiveOperationError(operationError);

      expect(requestCount).toBe(1);
      expect(operationError).toBeInstanceOf(SensitiveOperationError);
      expect(JSON.stringify(operationError)).not.toContain(secret);
      expect(JSON.stringify(serialized)).not.toContain(secret);
    }),
  );
});
