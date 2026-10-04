import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { AuthEnvironmentScopes, AuthSessionId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as CredentialStore from "./CredentialStore.ts";

const credentialToken = "fixed-credential-token-for-store-tests";
const StoredCredentialTestSchema = Schema.Struct({
  token: Schema.String,
  sourceSessionId: AuthSessionId,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  scopes: AuthEnvironmentScopes,
  renewalSupported: Schema.optionalKey(Schema.Boolean),
  predecessorCleanupId: Schema.optionalKey(AuthSessionId),
  predecessorCleanupPending: Schema.optionalKey(Schema.Boolean),
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
    renewalSupported: true,
    predecessorCleanupId: AuthSessionId.make("predecessor-for-store-tests"),
    predecessorCleanupPending: true,
  } satisfies CredentialStore.StoredCredential;
});

const makeStore = (
  config: ServerConfig.ServerConfig["Service"],
  keyringLayer = CredentialStore.keyringLayer,
  fs?: FileSystem.FileSystem,
  platform?: NodeJS.Platform,
) =>
  Layer.build(
    CredentialStore.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layer(config),
          keyringLayer,
          platform === undefined ? Layer.empty : Layer.succeed(HostProcessPlatform, platform),
          fs === undefined
            ? NodeServices.layer
            : Layer.merge(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, fs)),
        ),
      ),
    ),
  );

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-credential-store-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("factory credential store", (it) => {
  it.effect(
    "protects directory and temporary file from creation before credential bytes are visible",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = path.join(config.secretsDir, "factory-credentials");
        let writes = 0;
        const observed = FileSystem.FileSystem.of({
          ...fs,
          makeDirectory: (name, options) => {
            assert.equal(options?.mode, 0o700);
            return fs.makeDirectory(name, options);
          },
          writeFileString: (name, value, options) =>
            Effect.gen(function* () {
              assert.equal(options?.mode, 0o600);
              assert.equal(options?.flag, "wx");
              assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o700);
              yield* fs.writeFileString(name, value, options);
              assert.equal((yield* fs.stat(name)).mode & 0o777, 0o600);
              writes += 1;
            }),
        });
        const services = yield* makeStore(
          { ...config, factoryCredentialStore: "protected-file" },
          CredentialStore.keyringLayer,
          observed,
        );
        yield* fs.chmod(directory, 0o755);
        yield* Context.get(services, CredentialStore.CredentialStore).set(
          "creation-boundary",
          yield* makeCredential,
        );
        assert.equal(writes, 1);
      }),
  );

  it.effect("rejects protected-file on Windows before any filesystem operation", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      let touched = false;
      const observed = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (...args) => {
          touched = true;
          return fs.makeDirectory(...args);
        },
      });
      const failure = yield* makeStore(
        { ...config, factoryCredentialStore: "protected-file" },
        CredentialStore.keyringLayer,
        observed,
        "win32",
      ).pipe(Effect.flip);
      assert.equal(failure._tag, "CredentialStoreError");
      assert.equal(failure.operation, "secure");
      assert.equal(failure.reason, "unsupported-platform");
      assert.isFalse(touched);
    }),
  );

  it.effect("keeps the default vault usable on Windows without creating protected files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      let stored: string | null = null;
      let filesystemWrites = 0;
      const keyring = Layer.succeed(
        CredentialStore.CredentialKeyring,
        CredentialStore.CredentialKeyring.of({
          get: () => Effect.sync(() => stored),
          set: (_reference, value) =>
            Effect.sync(() => {
              stored = value;
            }),
          remove: () =>
            Effect.sync(() => {
              stored = null;
            }),
        }),
      );
      const observed = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (...args) => {
          filesystemWrites += 1;
          return fs.makeDirectory(...args);
        },
        writeFileString: (...args) => {
          filesystemWrites += 1;
          return fs.writeFileString(...args);
        },
      });
      const defaultConfig = { ...config };
      delete defaultConfig.factoryCredentialStore;
      const services = yield* makeStore(defaultConfig, keyring, observed, "win32");
      const store = Context.get(services, CredentialStore.CredentialStore);
      const credential = yield* makeCredential;
      yield* store.set("windows-default", credential);
      assert.deepEqual(Option.getOrThrow(yield* store.get("windows-default")), credential);
      yield* store.remove("windows-default");
      assert.isTrue(Option.isNone(yield* store.get("windows-default")));
      assert.equal(filesystemWrites, 0);
    }),
  );

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

  it.effect(
    "fails closed when chmod cannot establish protection and never writes credential bytes",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        let writes = 0;
        const observed = FileSystem.FileSystem.of({
          ...fs,
          chmod: (name) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "chmod",
                pathOrDescriptor: name,
              }),
            ),
          writeFileString: (...args) => {
            writes += 1;
            return fs.writeFileString(...args);
          },
        });
        const failure = yield* makeStore(
          { ...config, factoryCredentialStore: "protected-file" },
          CredentialStore.keyringLayer,
          observed,
        ).pipe(Effect.flip);
        assert.equal(failure._tag, "CredentialStoreError");
        assert.equal(failure.operation, "secure");
        assert.equal(writes, 0);
      }),
  );

  it.effect(
    "verifies existing-directory protection before every write and preserves the previous credential on failure",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let denyProtection = false;
        let writes = 0;
        const observed = FileSystem.FileSystem.of({
          ...fs,
          chmod: (...args) => (denyProtection ? Effect.void : fs.chmod(...args)),
          writeFileString: (...args) => {
            writes += 1;
            return fs.writeFileString(...args);
          },
        });
        const services = yield* makeStore(
          { ...config, factoryCredentialStore: "protected-file" },
          CredentialStore.keyringLayer,
          observed,
        );
        const store = Context.get(services, CredentialStore.CredentialStore);
        const original = yield* makeCredential;
        yield* store.set("existing-protection", original);
        yield* fs.chmod(path.join(config.secretsDir, "factory-credentials"), 0o755);
        denyProtection = true;
        const failure = yield* store
          .set("existing-protection", { ...original, token: "private-replacement" })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "CredentialStoreError");
        assert.equal(writes, 1);
        assert.deepEqual(Option.getOrThrow(yield* store.get("existing-protection")), original);
        assert.notInclude(encodeJson(failure), "private-replacement");
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
