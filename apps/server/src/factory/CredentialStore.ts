import * as NodeModule from "node:module";

import { AuthEnvironmentScopes, AuthSessionId, FactoryCredentialStorage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const StoredCredentialSchema = Schema.Struct({
  token: Schema.String,
  sourceSessionId: AuthSessionId,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  scopes: AuthEnvironmentScopes,
  predecessorCleanupId: Schema.optionalKey(AuthSessionId),
});
export type StoredCredential = typeof StoredCredentialSchema.Type;

export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()(
  "CredentialStoreError",
  {
    operation: Schema.Literals(["secure", "read", "write", "remove", "encode", "decode"]),
    backend: FactoryCredentialStorage,
  },
) {
  override get message(): string {
    return `The factory credential ${this.operation} operation failed for the selected ${this.backend} store.`;
  }
}

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly get: (
      reference: string,
    ) => Effect.Effect<Option.Option<StoredCredential>, CredentialStoreError>;
    readonly set: (
      reference: string,
      credential: StoredCredential,
    ) => Effect.Effect<void, CredentialStoreError>;
    readonly remove: (reference: string) => Effect.Effect<void, CredentialStoreError>;
  }
>()("t3/factory/CredentialStore") {}

export class CredentialKeyringError extends Schema.TaggedError<CredentialKeyringError>()(
  "CredentialKeyringError",
  { operation: Schema.Literals(["read", "write", "remove"]) },
) {
  override get message(): string {
    return `The operating system credential vault ${this.operation} operation failed.`;
  }
}

export class CredentialKeyring extends Context.Service<
  CredentialKeyring,
  {
    readonly get: (reference: string) => Effect.Effect<string | null, CredentialKeyringError>;
    readonly set: (reference: string, value: string) => Effect.Effect<void, CredentialKeyringError>;
    readonly remove: (reference: string) => Effect.Effect<void, CredentialKeyringError>;
  }
>()("t3/factory/CredentialStore/CredentialKeyring") {}

const requireForKeyring = NodeModule.createRequire(import.meta.url);
const KEYRING_SERVICE = "t3-factory-credential";
const protectedFileDirectory = "factory-credentials";
const fileKey = (reference: string) => encodeURIComponent(reference);
export { fileKey };

const StoredCredentialJsonSchema = Schema.Struct({
  ...StoredCredentialSchema.fields,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
const jsonCredential = Schema.fromJsonString(StoredCredentialJsonSchema);
const encodeCredential = Schema.encodeSync(jsonCredential);
const decodeCredential = Schema.decodeSync(jsonCredential);

/** Native keyring code is loaded only when the selected store performs an operation. */
export const keyringLayer = Layer.succeed(
  CredentialKeyring,
  CredentialKeyring.of({
    get: (reference) =>
      Effect.tryPromise({
        try: async () => {
          const { AsyncEntry } = requireForKeyring(
            "@napi-rs/keyring",
          ) as typeof import("@napi-rs/keyring");
          return (await new AsyncEntry(KEYRING_SERVICE, reference).getPassword()) ?? null;
        },
        catch: () => new CredentialKeyringError({ operation: "read" }),
      }),
    set: (reference, value) =>
      Effect.tryPromise({
        try: async () => {
          const { AsyncEntry } = requireForKeyring(
            "@napi-rs/keyring",
          ) as typeof import("@napi-rs/keyring");
          await new AsyncEntry(KEYRING_SERVICE, reference).setPassword(value);
        },
        catch: () => new CredentialKeyringError({ operation: "write" }),
      }),
    remove: (reference) =>
      Effect.tryPromise({
        try: async () => {
          const { AsyncEntry } = requireForKeyring(
            "@napi-rs/keyring",
          ) as typeof import("@napi-rs/keyring");
          const entry = new AsyncEntry(KEYRING_SERVICE, reference);
          if ((await entry.getPassword()) !== null) await entry.deletePassword();
        },
        catch: () => new CredentialKeyringError({ operation: "remove" }),
      }),
  }),
);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const selectedBackend = config.factoryCredentialStore ?? "secure-vault";
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const keyring = selectedBackend === "secure-vault" ? yield* CredentialKeyring : undefined;
  const directory = path.join(config.secretsDir, protectedFileDirectory);

  if (selectedBackend === "protected-file") {
    yield* fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.mapError(
          () => new CredentialStoreError({ operation: "secure", backend: selectedBackend }),
        ),
      );
    yield* fileSystem
      .chmod(directory, 0o700)
      .pipe(
        Effect.mapError(
          () => new CredentialStoreError({ operation: "secure", backend: selectedBackend }),
        ),
      );
  }

  const resolveFilePath = (reference: string) => path.join(directory, `${fileKey(reference)}.json`);

  const get: CredentialStore["Service"]["get"] = (reference) => {
    const read =
      selectedBackend === "secure-vault"
        ? keyring!.get(reference).pipe(
            Effect.map(Option.fromNullishOr),
            Effect.mapError(
              () => new CredentialStoreError({ operation: "read", backend: selectedBackend }),
            ),
          )
        : fileSystem.readFileString(resolveFilePath(reference)).pipe(
            Effect.asSome,
            Effect.catch((cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeedNone
                : Effect.fail(
                    new CredentialStoreError({ operation: "read", backend: selectedBackend }),
                  ),
            ),
          );

    return read.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (value) =>
            Effect.try({
              try: () => decodeCredential(value),
              catch: () =>
                new CredentialStoreError({ operation: "decode", backend: selectedBackend }),
            }).pipe(Effect.asSome),
        }),
      ),
    );
  };

  const set: CredentialStore["Service"]["set"] = (reference, credential) =>
    Effect.try({
      try: () => encodeCredential(credential),
      catch: () => new CredentialStoreError({ operation: "encode", backend: selectedBackend }),
    }).pipe(
      Effect.flatMap((encoded) =>
        selectedBackend === "secure-vault"
          ? keyring!
              .set(reference, encoded)
              .pipe(
                Effect.mapError(
                  () => new CredentialStoreError({ operation: "write", backend: selectedBackend }),
                ),
              )
          : crypto.randomUUIDv4.pipe(
              Effect.mapError(
                () => new CredentialStoreError({ operation: "write", backend: selectedBackend }),
              ),
              Effect.flatMap((nonce) => {
                const target = resolveFilePath(reference);
                const temporary = `${target}.${nonce}.tmp`;
                return Effect.gen(function* () {
                  yield* fileSystem.writeFileString(temporary, encoded);
                  yield* fileSystem.chmod(temporary, 0o600);
                  yield* fileSystem.rename(temporary, target);
                }).pipe(
                  Effect.catch((_cause) =>
                    fileSystem.remove(temporary).pipe(
                      Effect.ignore,
                      Effect.flatMap(() =>
                        Effect.fail(
                          new CredentialStoreError({
                            operation: "write",
                            backend: selectedBackend,
                          }),
                        ),
                      ),
                    ),
                  ),
                );
              }),
            ),
      ),
    );

  const remove: CredentialStore["Service"]["remove"] = (reference) =>
    selectedBackend === "secure-vault"
      ? keyring!
          .remove(reference)
          .pipe(
            Effect.mapError(
              () => new CredentialStoreError({ operation: "remove", backend: selectedBackend }),
            ),
          )
      : fileSystem
          .remove(resolveFilePath(reference))
          .pipe(
            Effect.catch((cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.void
                : Effect.fail(
                    new CredentialStoreError({ operation: "remove", backend: selectedBackend }),
                  ),
            ),
          );

  return CredentialStore.of({ get, set, remove });
});

export const layer = Layer.effect(CredentialStore, make);
