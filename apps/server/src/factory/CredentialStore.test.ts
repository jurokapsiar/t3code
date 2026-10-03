import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { AuthEnvironmentScopes, AuthSessionId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as CredentialStore from "./CredentialStore.ts";

const credentialToken = "fixed-credential-token-for-store-tests";
const StoredCredentialTestSchema = Schema.Struct({
  token: Schema.String,
  sourceSessionId: AuthSessionId,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  scopes: AuthEnvironmentScopes,
  predecessorCleanupId: Schema.optionalKey(AuthSessionId),
});
const decodeStoredCredentialJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredCredentialTestSchema),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeCredential = Effect.gen(function* () {
  const issuedAt = yield* DateTime.now;
  return {
    token: credentialToken,
    sourceSessionId: AuthSessionId.make("source-session-for-store-tests"),
    issuedAt,
    expiresAt: DateTime.add(issuedAt, { days: 1 }),
    scopes: ["orchestration:read"],
  } satisfies CredentialStore.StoredCredential;
});

const makeStore = (
  config: ServerConfig.ServerConfig["Service"],
  keyringLayer = CredentialStore.keyringLayer,
) =>
  Layer.build(
    CredentialStore.layer.pipe(
      Layer.provide(Layer.mergeAll(ServerConfig.layer(config), keyringLayer, NodeServices.layer)),
    ),
  );

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-credential-store-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("factory credential store", (it) => {
  it.effect("stores protected files with user-only directory and file permissions", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const services = yield* makeStore({ ...config, factoryCredentialStore: "protected-file" });
      const store = Context.get(services, CredentialStore.CredentialStore);
      const directory = path.join(config.secretsDir, "factory-credentials");
      const reference = "factory-installation:registration-1";
      const credential = yield* makeCredential;

      yield* store.set(reference, credential);
      const storedFile = path.join(directory, `${CredentialStore.fileKey(reference)}.json`);
      const encodedCredential = yield* fs.readFileString(storedFile);
      const decodedCredential = yield* decodeStoredCredentialJson(encodedCredential);
      const restored = yield* store.get(reference);
      const directoryInfo = yield* fs.stat(directory);
      const fileInfo = yield* fs.stat(storedFile);

      assert.deepEqual(decodedCredential, credential);
      assert.deepEqual(Option.getOrThrow(restored), credential);
      assert.equal(directoryInfo.mode & 0o777, 0o700);
      assert.equal(fileInfo.mode & 0o777, 0o600);
    }),
  );

  it.effect("fails rather than falling back when a protected directory cannot be secured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseConfig = yield* ServerConfig.ServerConfig;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-secret-permission-" });
      const blocked = path.join(root, "not-a-directory");
      yield* fs.writeFileString(blocked, "occupied");
      let keyringCalls = 0;
      const keyring = Layer.succeed(
        CredentialStore.CredentialKeyring,
        CredentialStore.CredentialKeyring.of({
          get: () => Effect.sync(() => (keyringCalls++, null)),
          set: () => Effect.sync(() => void (keyringCalls += 1)),
          remove: () => Effect.sync(() => void (keyringCalls += 1)),
        }),
      );
      const services = yield* makeStore(
        { ...baseConfig, factoryCredentialStore: "protected-file", secretsDir: blocked },
        keyring,
      ).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(services));
      assert.equal(keyringCalls, 0);
    }),
  );

  it.effect("treats a missing item as absent and removes it idempotently", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const services = yield* makeStore({ ...config, factoryCredentialStore: "protected-file" });
      const store = Context.get(services, CredentialStore.CredentialStore);

      assert.isTrue(Option.isNone(yield* store.get("missing-reference")));
      yield* store.remove("missing-reference");
    }),
  );

  it.effect("reports replacement failures without changing the previous keyring value", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const reference = "factory-installation:registration-replacement";
      const previous = yield* makeCredential;
      const existing = encodeJson({
        ...previous,
        token: "previous-private-value",
        issuedAt: DateTime.formatIso(previous.issuedAt),
        expiresAt: DateTime.formatIso(previous.expiresAt),
      });
      const keyring = Layer.succeed(
        CredentialStore.CredentialKeyring,
        CredentialStore.CredentialKeyring.of({
          get: () => Effect.succeed(existing),
          set: () =>
            Effect.fail(new CredentialStore.CredentialKeyringError({ operation: "write" })),
          remove: () => Effect.void,
        }),
      );
      const services = yield* makeStore(
        { ...config, factoryCredentialStore: "secure-vault" },
        keyring,
      );
      const store = Context.get(services, CredentialStore.CredentialStore);
      const failure = yield* store.set(reference, yield* makeCredential).pipe(Effect.flip);

      assert.equal(failure._tag, "CredentialStoreError");
      assert.equal(failure.operation, "write");
      assert.equal(Option.getOrThrow(yield* store.get(reference)).token, "previous-private-value");
      assert.notInclude(encodeJson(failure), credentialToken);
    }),
  );

  it.effect("does not reveal a locked keyring failure or secret in a serialized error", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const keyring = Layer.succeed(
        CredentialStore.CredentialKeyring,
        CredentialStore.CredentialKeyring.of({
          get: () => Effect.fail(new CredentialStore.CredentialKeyringError({ operation: "read" })),
          set: () =>
            Effect.fail(new CredentialStore.CredentialKeyringError({ operation: "write" })),
          remove: () =>
            Effect.fail(new CredentialStore.CredentialKeyringError({ operation: "remove" })),
        }),
      );
      const services = yield* makeStore(
        { ...config, factoryCredentialStore: "secure-vault" },
        keyring,
      );
      const store = Context.get(services, CredentialStore.CredentialStore);
      const failure = yield* store.set("locked-reference", yield* makeCredential).pipe(Effect.flip);

      assert.equal(failure._tag, "CredentialStoreError");
      assert.notInclude(encodeJson(failure), credentialToken);
      assert.notInclude(String(failure), credentialToken);
    }),
  );

  it.effect("leaves the old protected-file item intact when atomic replacement fails", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const services = yield* makeStore({ ...config, factoryCredentialStore: "protected-file" });
      const store = Context.get(services, CredentialStore.CredentialStore);
      const reference = "replacement-failure";
      const target = path.join(
        config.secretsDir,
        "factory-credentials",
        `${CredentialStore.fileKey(reference)}.json`,
      );
      yield* fs.makeDirectory(target, { recursive: true });
      const result = yield* store.set(reference, yield* makeCredential).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(result));
      assert.isTrue(yield* fs.exists(target));
      assert.notInclude(encodeJson(result), credentialToken);
    }),
  );
});
