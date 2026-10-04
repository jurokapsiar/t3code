import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  EnvironmentId,
  ExecutionEnvironmentPlatform,
  FactoryCredentialStorage,
  FactoryEnvironmentView,
  FactoryRenewalState,
  FactoryError,
  FactoryErrorCode,
  NonNegativeInt,
  FactoryFavorite,
  FactoryFavoriteTarget,
  FactoryGroup,
  FactoryGroupId,
  FactoryMembership,
  ProjectId,
  FactoryRegistrationId,
  FactoryEnvironmentsUpdateRpc,
  FactoryGroupsCreateRpc,
  FactoryGroupsUpdateRpc,
  FactoryGroupsDeleteRpc,
  FactoryGroupsAssignRpc,
  FactoryGroupsUnassignRpc,
  FactoryFavoritesSetRpc,
  FactoryFavoritesReorderRpc,
  FactoryEnvironmentsRemoveRpc,
} from "@t3tools/contracts";

const encodePlatform = Schema.encodeEffect(Schema.fromJsonString(ExecutionEnvironmentPlatform));

const EnvironmentDbRow = Schema.Struct({
  ...FactoryEnvironmentView.fields,
  platform: Schema.NullOr(Schema.fromJsonString(ExecutionEnvironmentPlatform)),
  enabled: Schema.BooleanFromBit,
  cleanupPending: Schema.BooleanFromBit,
  credentialExpiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const GroupDbRow = Schema.Struct({
  ...FactoryGroup.fields,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

const FavoriteDbRow = Schema.Union([
  Schema.Struct({
    targetKind: Schema.Literal("project"),
    groupId: Schema.Null,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    order: NonNegativeInt,
  }),
  Schema.Struct({
    targetKind: Schema.Literal("group"),
    groupId: FactoryGroupId,
    environmentId: Schema.Null,
    projectId: Schema.Null,
    order: NonNegativeInt,
  }),
]);

const MembershipDbRow = Schema.Struct({
  groupId: FactoryGroupId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
});

const EmptyInput = Schema.Struct({});
const decodeFactoryMembership = Schema.decodeSync(FactoryMembership);
const decodeFactoryFavorite = Schema.decodeSync(FactoryFavorite);

export interface FactoryMetadataSnapshot {
  readonly environments: ReadonlyArray<FactoryEnvironmentView>;
  readonly groups: ReadonlyArray<FactoryGroup>;
  readonly memberships: ReadonlyArray<FactoryMembership>;
  readonly favorites: ReadonlyArray<FactoryFavorite>;
}

export interface FactoryMetadataCommit {
  readonly revision: number;
  readonly snapshot: FactoryMetadataSnapshot;
}

export interface FactoryMetadataWatch {
  readonly initial: FactoryMetadataCommit;
  readonly changes: Stream.Stream<FactoryMetadataCommit>;
}

export interface MarkEnrollmentInput {
  readonly registrationId: FactoryRegistrationId;
  readonly credentialStorage: FactoryCredentialStorage;
  readonly credentialItemKey: string;
  readonly credentialExpiresAt: DateTime.DateTime | null;
}

export interface MarkPendingEnrollmentInput {
  readonly registrationId: FactoryRegistrationId;
  readonly credentialStorage: FactoryCredentialStorage;
  readonly credentialItemKey: string;
}

export interface EnrollmentReference {
  readonly environment: FactoryEnvironmentView;
  readonly credentialStorage: FactoryCredentialStorage | null;
  readonly credentialItemKey: string | null;
}

const CredentialReferenceDbRow = Schema.Struct({
  registrationId: FactoryRegistrationId,
  credentialStorage: Schema.NullOr(FactoryCredentialStorage),
  credentialItemKey: Schema.NullOr(Schema.String),
});

type EnvironmentUpdateInput = typeof FactoryEnvironmentsUpdateRpc.payloadSchema.Type;
type GroupCreateInput = typeof FactoryGroupsCreateRpc.payloadSchema.Type;
type GroupUpdateInput = typeof FactoryGroupsUpdateRpc.payloadSchema.Type;
type GroupDeleteInput = typeof FactoryGroupsDeleteRpc.payloadSchema.Type;
type AssignInput = typeof FactoryGroupsAssignRpc.payloadSchema.Type;
type UnassignInput = typeof FactoryGroupsUnassignRpc.payloadSchema.Type;
type FavoriteSetInput = typeof FactoryFavoritesSetRpc.payloadSchema.Type;
type FavoriteReorderInput = typeof FactoryFavoritesReorderRpc.payloadSchema.Type;
type EnvironmentRemoveInput = typeof FactoryEnvironmentsRemoveRpc.payloadSchema.Type;

export class Metadata extends Context.Service<
  Metadata,
  {
    readonly listEnvironments: Effect.Effect<ReadonlyArray<FactoryEnvironmentView>>;
    readonly getSnapshot: Effect.Effect<FactoryMetadataSnapshot>;
    readonly subscribeChanges: Stream.Stream<FactoryMetadataCommit>;
    readonly subscribeWithSnapshot: Effect.Effect<FactoryMetadataWatch, never, Scope.Scope>;
    readonly createEnvironment: (
      input: FactoryEnvironmentView,
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly updateEnvironment: (
      input: EnvironmentUpdateInput,
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly setConnectionState: (
      registrationId: FactoryRegistrationId,
      state: "online" | "offline" | "blocked",
    ) => Effect.Effect<void, FactoryError>;
    readonly setRenewalStatus: (
      registrationId: FactoryRegistrationId,
      status: FactoryRenewalState,
      expiresAt?: DateTime.DateTime,
      cleanupPending?: boolean,
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly markEnrollment: (
      input: MarkEnrollmentInput,
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly replaceEnrollment: (
      input: MarkEnrollmentInput & { readonly revision: number },
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly markPendingEnrollment: (
      input: MarkPendingEnrollmentInput,
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly markRemoving: (
      input: EnvironmentRemoveInput,
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly clearCredentialReference: (
      registrationId: FactoryRegistrationId,
    ) => Effect.Effect<FactoryEnvironmentView, FactoryError>;
    readonly getCredentialReference: (registrationId: FactoryRegistrationId) => Effect.Effect<{
      readonly storage: FactoryCredentialStorage;
      readonly itemKey: string;
    } | null>;
    readonly listEnrollmentReferences: Effect.Effect<ReadonlyArray<EnrollmentReference>>;
    readonly getEnrollmentReference: (
      registrationId: FactoryRegistrationId,
    ) => Effect.Effect<EnrollmentReference | undefined>;
    readonly createGroup: (input: GroupCreateInput) => Effect.Effect<FactoryGroup, FactoryError>;
    readonly renameGroup: (input: GroupUpdateInput) => Effect.Effect<FactoryGroup, FactoryError>;
    readonly deleteGroup: (
      input: GroupDeleteInput,
    ) => Effect.Effect<{ readonly deleted: boolean }, FactoryError>;
    readonly assignProject: (input: AssignInput) => Effect.Effect<FactoryMembership, FactoryError>;
    readonly unassignProject: (
      input: UnassignInput,
    ) => Effect.Effect<{ readonly removed: boolean }, FactoryError>;
    readonly setFavorite: (
      input: FavoriteSetInput,
    ) => Effect.Effect<FactoryFavorite | null, FactoryError>;
    readonly reorderFavorites: (
      input: FavoriteReorderInput,
    ) => Effect.Effect<ReadonlyArray<FactoryFavorite>, FactoryError>;
    readonly removeEnvironment: (
      input: EnvironmentRemoveInput,
    ) => Effect.Effect<{ readonly removed: boolean }, FactoryError>;
  }
>()("t3/factory/Metadata") {}

const factoryError = (code: FactoryErrorCode, message: string) =>
  new FactoryError({ code, message });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const revision = yield* Ref.make(0);
  const changes = yield* PubSub.unbounded<FactoryMetadataCommit>();
  const commitLock = yield* Semaphore.make(1);

  const selectEnvironmentRows = SqlSchema.findAll({
    Request: Schema.Struct({ registrationId: Schema.optional(FactoryRegistrationId) }),
    Result: EnvironmentDbRow,
    execute: ({ registrationId }) => sql`
      SELECT
        registration_id AS "registrationId",
        environment_id AS "environmentId",
        endpoint,
        label,
        platform,
        enabled,
        state,
        credential_storage AS "credentialStorage",
        credential_expires_at AS "credentialExpiresAt",
        cleanup_pending AS "cleanupPending",
        last_seen_at AS "lastSeenAt",
        revision,
        renewal
      FROM factory_environments
      WHERE ${registrationId === undefined ? sql`1 = 1` : sql`registration_id = ${registrationId}`}
      ORDER BY label COLLATE NOCASE, registration_id
    `,
  });

  const selectEnvironments = (input: Parameters<typeof selectEnvironmentRows>[0]) =>
    selectEnvironmentRows(input).pipe(
      Effect.map((rows) =>
        rows.map((environment) => ({
          ...environment,
          sourceAccess: {
            websocketRoute: `/factory/env/${encodeURIComponent(environment.registrationId)}/ws`,
            capabilities: { websocket: true },
          },
        })),
      ),
    );

  const selectGroups = SqlSchema.findAll({
    Request: Schema.Struct({ groupId: Schema.optional(FactoryGroupId) }),
    Result: GroupDbRow,
    execute: ({ groupId }) => sql`
      SELECT id, name, revision, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM factory_project_groups
      WHERE ${groupId === undefined ? sql`1 = 1` : sql`id = ${groupId}`}
      ORDER BY name COLLATE NOCASE, id
    `,
  });

  const selectMemberships = SqlSchema.findAll({
    Request: EmptyInput,
    Result: MembershipDbRow,
    execute: () => sql`
      SELECT group_id AS "groupId", environment_id AS "environmentId", project_id AS "projectId"
      FROM factory_project_memberships
      ORDER BY environment_id, project_id
    `,
  });

  const selectFavoriteRows = SqlSchema.findAll({
    Request: EmptyInput,
    Result: FavoriteDbRow,
    execute: () => sql`
      SELECT target_kind AS "targetKind", group_id AS "groupId",
        environment_id AS "environmentId", project_id AS "projectId", order_index AS "order"
      FROM factory_favorites
      ORDER BY order_index, id
    `,
  });

  const selectCredentialReferences = SqlSchema.findAll({
    Request: Schema.Struct({ registrationId: Schema.optional(FactoryRegistrationId) }),
    Result: CredentialReferenceDbRow,
    execute: ({ registrationId }) => sql`
      SELECT registration_id AS "registrationId", credential_storage AS "credentialStorage",
        credential_item_key AS "credentialItemKey"
      FROM factory_environments
      WHERE ${registrationId === undefined ? sql`1 = 1` : sql`registration_id = ${registrationId}`}
      ORDER BY registration_id
    `,
  });

  const readEnvironments = () => selectEnvironments({}).pipe(Effect.orDie);
  const readGroups = () => selectGroups({}).pipe(Effect.orDie);
  const readMemberships = () =>
    selectMemberships({}).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          decodeFactoryMembership({
            groupId: row.groupId,
            project: { environmentId: row.environmentId, projectId: row.projectId },
          }),
        ),
      ),
      Effect.orDie,
    );
  const readFavorites = () =>
    selectFavoriteRows({}).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          decodeFactoryFavorite({
            target:
              row.targetKind === "group"
                ? { kind: "group", groupId: row.groupId }
                : {
                    kind: "project",
                    project: { environmentId: row.environmentId, projectId: row.projectId },
                  },
            order: row.order,
          }),
        ),
      ),
      Effect.orDie,
    );

  const readSnapshot = Effect.gen(function* () {
    const environments = yield* readEnvironments();
    const groups = yield* readGroups();
    const memberships = yield* readMemberships();
    const favorites = yield* readFavorites();
    return { environments, groups, memberships, favorites } satisfies FactoryMetadataSnapshot;
  });

  const findEnvironment = (registrationId: FactoryRegistrationId) =>
    selectEnvironments({ registrationId }).pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );

  const findGroup = (groupId: FactoryGroupId) =>
    selectGroups({ groupId }).pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );

  const withCommit = <A>(body: Effect.Effect<A, FactoryError>): Effect.Effect<A, FactoryError> =>
    commitLock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const value = yield* body;
            return { value, snapshot: yield* readSnapshot };
          }),
        )
        .pipe(
          Effect.catchIf(SqlError.isSqlError, Effect.die),
          Effect.flatMap(({ value, snapshot }) =>
            Ref.updateAndGet(revision, (current) => current + 1).pipe(
              Effect.flatMap((nextRevision) =>
                PubSub.publish(changes, { revision: nextRevision, snapshot }).pipe(
                  Effect.as(value),
                ),
              ),
            ),
          ),
        ),
    );

  const requireGroupRevision = (groupId: FactoryGroupId, expectedRevision: number) =>
    Effect.gen(function* () {
      const group = yield* findGroup(groupId);
      if (group === undefined) {
        return yield* factoryError("not-found", "The project group does not exist.");
      }
      if (group.revision !== expectedRevision) {
        return yield* factoryError("conflict", "The project group changed. Reload it and retry.");
      }
      return group;
    });

  const requireEnvironmentRevision = (
    registrationId: FactoryRegistrationId,
    expectedRevision: number,
  ) =>
    Effect.gen(function* () {
      const environment = yield* findEnvironment(registrationId);
      if (environment === undefined) {
        return yield* factoryError("not-found", "The source environment does not exist.");
      }
      if (environment.revision !== expectedRevision) {
        return yield* factoryError(
          "conflict",
          "The source environment changed. Reload it and retry.",
        );
      }
      return environment;
    });

  const snapshotWithRevision = commitLock.withPermit(
    Effect.gen(function* () {
      const snapshot = yield* readSnapshot;
      const currentRevision = yield* Ref.get(revision);
      return { ...snapshot, revision: currentRevision };
    }),
  );
  const subscribeWithSnapshot = commitLock.withPermit(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = yield* readSnapshot;
      const currentRevision = yield* Ref.get(revision);
      return {
        initial: { revision: currentRevision, snapshot },
        changes: Stream.fromSubscription(subscription).pipe(
          Stream.filter((commit) => commit.revision > currentRevision),
        ),
      } satisfies FactoryMetadataWatch;
    }),
  );

  const getCredentialReference = (registrationId: FactoryRegistrationId) =>
    selectCredentialReferences({ registrationId }).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row?.credentialStorage !== null &&
          row?.credentialStorage !== undefined &&
          row.credentialItemKey !== null &&
          row.credentialItemKey !== undefined
          ? { storage: row.credentialStorage, itemKey: row.credentialItemKey }
          : null;
      }),
      Effect.orDie,
    );

  const listEnrollmentReferences: Metadata["Service"]["listEnrollmentReferences"] = Effect.gen(
    function* () {
      const environments = yield* readEnvironments();
      const references = yield* selectCredentialReferences({}).pipe(Effect.orDie);
      return environments.map((environment) => {
        const reference = references.find(
          (row) => row.registrationId === environment.registrationId,
        );
        return {
          environment,
          credentialStorage: reference?.credentialStorage ?? null,
          credentialItemKey: reference?.credentialItemKey ?? null,
        } satisfies EnrollmentReference;
      });
    },
  );

  return Metadata.of({
    listEnvironments: readEnvironments(),
    getSnapshot: snapshotWithRevision,
    subscribeChanges: Stream.fromPubSub(changes),
    subscribeWithSnapshot,
    getCredentialReference,
    listEnrollmentReferences,
    getEnrollmentReference: (registrationId) =>
      Effect.gen(function* () {
        const environment = yield* findEnvironment(registrationId);
        if (environment === undefined) return undefined;
        const reference = yield* getCredentialReference(registrationId);
        return {
          environment,
          credentialStorage: reference?.storage ?? null,
          credentialItemKey: reference?.itemKey ?? null,
        };
      }),

    createEnvironment: (input) =>
      withCommit(
        Effect.gen(function* () {
          if (input.enabled || input.state !== "pending" || input.credentialStorage !== null) {
            return yield* factoryError(
              "invalid-request",
              "A source must be pending and have no credential before enrollment.",
            );
          }
          if (
            (yield* selectEnvironments({}).pipe(Effect.orDie)).some(
              (row) => row.environmentId === input.environmentId,
            )
          ) {
            return yield* factoryError(
              "conflict",
              "This source environment is already registered.",
            );
          }
          const platform =
            input.platform === null
              ? null
              : yield* encodePlatform(input.platform).pipe(Effect.orDie);
          yield* sql`
            INSERT INTO factory_environments (
              registration_id, environment_id, endpoint, label, platform, enabled, state,
              credential_storage, credential_item_key, credential_expires_at, last_seen_at, revision,
              renewal, cleanup_pending
            ) VALUES (
              ${input.registrationId}, ${input.environmentId}, ${input.endpoint}, ${input.label},
              ${platform}, 0, 'pending',
              NULL, NULL, NULL, NULL, 0, 'unsupported', 0
            )
          `.pipe(Effect.orDie);
          return yield* findEnvironment(input.registrationId).pipe(
            Effect.flatMap((row) =>
              row === undefined
                ? factoryError("not-found", "The source environment was not stored.")
                : Effect.succeed(row),
            ),
          );
        }),
      ),

    updateEnvironment: (input) =>
      withCommit(
        Effect.gen(function* () {
          const current = yield* requireEnvironmentRevision(input.registrationId, input.revision);
          if (
            input.enabled === true &&
            (current.state === "pending" ||
              current.state === "removing" ||
              current.credentialStorage === null)
          ) {
            return yield* factoryError("conflict", "Enroll the source before enabling it.");
          }
          yield* sql`
            UPDATE factory_environments
            SET endpoint = ${input.endpoint ?? current.endpoint},
                label = ${input.label ?? current.label},
                enabled = ${(input.enabled ?? current.enabled) ? 1 : 0},
                state = ${input.enabled === false && current.state !== "pending" && current.state !== "removing" ? "offline" : current.state},
                revision = revision + 1
            WHERE registration_id = ${input.registrationId}
          `.pipe(Effect.orDie);
          return yield* findEnvironment(input.registrationId).pipe(
            Effect.flatMap((row) =>
              row === undefined
                ? factoryError("not-found", "The source environment does not exist.")
                : Effect.succeed(row),
            ),
          );
        }),
      ),

    setConnectionState: (registrationId, state) =>
      withCommit(
        Effect.gen(function* () {
          const current = yield* findEnvironment(registrationId);
          if (current === undefined)
            return yield* factoryError("not-found", "The source environment does not exist.");
          if (
            !current.enabled ||
            current.state === "pending" ||
            current.state === "removing" ||
            current.state === state
          )
            return;
          const now = yield* DateTime.now;
          yield* sql`
        UPDATE factory_environments SET state = ${state},
          last_seen_at = ${state === "online" ? DateTime.formatIso(now) : current.lastSeenAt === null ? null : DateTime.formatIso(current.lastSeenAt)}
        WHERE registration_id = ${registrationId}
      `.pipe(Effect.orDie);
        }),
      ),

    setRenewalStatus: (registrationId, status, expiresAt, cleanupPending) =>
      withCommit(
        Effect.gen(function* () {
          const current = yield* findEnvironment(registrationId);
          if (current === undefined) {
            return yield* factoryError("not-found", "The source environment does not exist.");
          }
          if (
            current.renewal !== status ||
            expiresAt !== undefined ||
            (cleanupPending !== undefined && current.cleanupPending !== cleanupPending)
          ) {
            const cleanupPendingBit = (cleanupPending ?? current.cleanupPending) ? 1 : 0;
            if (expiresAt === undefined) {
              yield* sql`
                UPDATE factory_environments
                SET renewal = ${status}, cleanup_pending = ${cleanupPendingBit}
                WHERE registration_id = ${registrationId}
              `.pipe(Effect.orDie);
            } else {
              yield* sql`
                UPDATE factory_environments
                SET renewal = ${status}, credential_expires_at = ${DateTime.formatIso(expiresAt)},
                    cleanup_pending = ${cleanupPendingBit}
                WHERE registration_id = ${registrationId}
              `.pipe(Effect.orDie);
            }
          }
          return yield* findEnvironment(registrationId).pipe(
            Effect.flatMap((row) =>
              row === undefined
                ? factoryError("not-found", "The source environment does not exist.")
                : Effect.succeed(row),
            ),
          );
        }),
      ),

    markEnrollment: (input) =>
      withCommit(
        Effect.gen(function* () {
          const current = yield* findEnvironment(input.registrationId);
          if (current === undefined) {
            return yield* factoryError("not-found", "The source environment does not exist.");
          }
          if (current.state !== "pending" || current.enabled) {
            return yield* factoryError("conflict", "Only a pending source can be enrolled.");
          }
          if (current.credentialStorage !== null) {
            const reference = yield* getCredentialReference(input.registrationId);
            if (
              reference === null ||
              reference.storage !== input.credentialStorage ||
              reference.itemKey !== input.credentialItemKey
            ) {
              return yield* factoryError(
                "conflict",
                "The pending source credential reference changed.",
              );
            }
          }
          yield* sql`
            UPDATE factory_environments
            SET enabled = 1, state = 'offline', credential_storage = ${input.credentialStorage},
                credential_item_key = ${input.credentialItemKey},
                credential_expires_at = ${input.credentialExpiresAt === null ? null : DateTime.formatIso(input.credentialExpiresAt)},
                revision = revision + 1
            WHERE registration_id = ${input.registrationId}
          `.pipe(Effect.orDie);
          return yield* findEnvironment(input.registrationId).pipe(
            Effect.flatMap((row) =>
              row === undefined
                ? factoryError("not-found", "The source environment does not exist.")
                : Effect.succeed(row),
            ),
          );
        }),
      ),

    replaceEnrollment: (input) =>
      withCommit(
        Effect.gen(function* () {
          const current = yield* findEnvironment(input.registrationId);
          if (current === undefined) {
            return yield* factoryError("not-found", "The source environment does not exist.");
          }
          if (
            current.revision !== input.revision ||
            current.state === "pending" ||
            current.state === "removing"
          ) {
            return yield* factoryError(
              "conflict",
              "The source changed before its credential could be replaced.",
            );
          }
          yield* sql`
            UPDATE factory_environments
            SET state = 'offline', credential_storage = ${input.credentialStorage},
                credential_item_key = ${input.credentialItemKey},
                credential_expires_at = ${input.credentialExpiresAt === null ? null : DateTime.formatIso(input.credentialExpiresAt)},
                revision = revision + 1
            WHERE registration_id = ${input.registrationId} AND revision = ${input.revision}
          `.pipe(Effect.orDie);
          return yield* findEnvironment(input.registrationId).pipe(
            Effect.flatMap((row) =>
              row === undefined
                ? factoryError("not-found", "The source environment does not exist.")
                : Effect.succeed(row),
            ),
          );
        }),
      ),

    markPendingEnrollment: (input) =>
      withCommit(
        Effect.gen(function* () {
          const current = yield* findEnvironment(input.registrationId);
          if (current === undefined) {
            return yield* factoryError("not-found", "The source environment does not exist.");
          }
          if (current.enabled || current.state !== "pending") {
            return yield* factoryError(
              "conflict",
              "Only a pending source can store enrollment credentials.",
            );
          }
          if (current.credentialStorage !== null) {
            const reference = yield* getCredentialReference(input.registrationId);
            if (
              reference === null ||
              reference.storage !== input.credentialStorage ||
              reference.itemKey !== input.credentialItemKey
            ) {
              return yield* factoryError(
                "conflict",
                "The pending source credential reference changed.",
              );
            }
          }
          yield* sql`
            UPDATE factory_environments
            SET credential_storage = ${input.credentialStorage},
                credential_item_key = ${input.credentialItemKey}, revision = revision + 1
            WHERE registration_id = ${input.registrationId}
          `.pipe(Effect.orDie);
          const environment = yield* findEnvironment(input.registrationId);
          return (
            environment ??
            (yield* factoryError("not-found", "The source environment does not exist."))
          );
        }),
      ),

    markRemoving: (input) =>
      withCommit(
        Effect.gen(function* () {
          const existing = yield* findEnvironment(input.registrationId);
          if (existing === undefined) {
            return yield* factoryError("not-found", "The source environment does not exist.");
          }
          if (existing.state === "removing" && !existing.enabled) return existing;
          yield* requireEnvironmentRevision(input.registrationId, input.revision);
          yield* sql`
            UPDATE factory_environments
            SET enabled = 0, state = 'removing', revision = revision + 1
            WHERE registration_id = ${input.registrationId}
          `.pipe(Effect.orDie);
          const environment = yield* findEnvironment(input.registrationId);
          return (
            environment ??
            (yield* factoryError("not-found", "The source environment does not exist."))
          );
        }),
      ),

    clearCredentialReference: (registrationId) =>
      withCommit(
        Effect.gen(function* () {
          const current = yield* findEnvironment(registrationId);
          if (current === undefined) {
            return yield* factoryError("not-found", "The source environment does not exist.");
          }
          if (current.state !== "removing") {
            return yield* factoryError(
              "conflict",
              "Only a removing source can clear its credential reference.",
            );
          }
          if (current.credentialStorage === null) return current;
          yield* sql`
            UPDATE factory_environments
            SET credential_storage = NULL, credential_item_key = NULL,
                credential_expires_at = NULL, revision = revision + 1
            WHERE registration_id = ${registrationId}
          `.pipe(Effect.orDie);
          const environment = yield* findEnvironment(registrationId);
          return (
            environment ??
            (yield* factoryError("not-found", "The source environment does not exist."))
          );
        }),
      ),

    createGroup: (input) =>
      withCommit(
        Effect.gen(function* () {
          const groupId = yield* crypto.randomUUIDv4.pipe(
            Effect.orDie,
            Effect.flatMap(Schema.decodeEffect(FactoryGroupId)),
            Effect.orDie,
          );
          const now = DateTime.formatIso(yield* DateTime.now.pipe(Effect.orDie));
          yield* sql`
            INSERT INTO factory_project_groups (id, name, revision, created_at, updated_at)
            VALUES (${groupId}, ${input.name}, 0, ${now}, ${now})
          `.pipe(Effect.orDie);
          const group = yield* findGroup(groupId);
          return group ?? (yield* factoryError("not-found", "The project group was not stored."));
        }),
      ),

    renameGroup: (input) =>
      withCommit(
        Effect.gen(function* () {
          yield* requireGroupRevision(input.groupId, input.revision);
          yield* sql`
            UPDATE factory_project_groups
            SET name = ${input.name}, revision = revision + 1, updated_at = ${DateTime.formatIso(yield* DateTime.now.pipe(Effect.orDie))}
            WHERE id = ${input.groupId}
          `.pipe(Effect.orDie);
          const group = yield* findGroup(input.groupId);
          return group ?? (yield* factoryError("not-found", "The project group does not exist."));
        }),
      ),

    deleteGroup: (input) =>
      withCommit(
        Effect.gen(function* () {
          yield* requireGroupRevision(input.groupId, input.revision);
          yield* sql`DELETE FROM factory_project_groups WHERE id = ${input.groupId}`.pipe(
            Effect.orDie,
          );
          return { deleted: true };
        }),
      ),

    assignProject: (input) =>
      withCommit(
        Effect.gen(function* () {
          if (!(yield* findGroup(input.groupId))) {
            return yield* factoryError("not-found", "The project group does not exist.");
          }
          const environments = yield* selectEnvironments({}).pipe(Effect.orDie);
          if (!environments.some((row) => row.environmentId === input.project.environmentId)) {
            return yield* factoryError("not-found", "The source environment does not exist.");
          }
          yield* sql`
            INSERT INTO factory_project_memberships (environment_id, project_id, group_id)
            VALUES (${input.project.environmentId}, ${input.project.projectId}, ${input.groupId})
            ON CONFLICT (environment_id, project_id)
            DO UPDATE SET group_id = excluded.group_id
          `.pipe(Effect.orDie);
          yield* sql`
            DELETE FROM factory_favorites
            WHERE target_kind = 'project' AND environment_id = ${input.project.environmentId}
              AND project_id = ${input.project.projectId}
          `.pipe(Effect.orDie);
          return { groupId: input.groupId, project: input.project } satisfies FactoryMembership;
        }),
      ),

    unassignProject: (input) =>
      withCommit(
        sql`
          DELETE FROM factory_project_memberships
          WHERE group_id = ${input.groupId} AND environment_id = ${input.project.environmentId}
            AND project_id = ${input.project.projectId}
          RETURNING 1 AS removed
        `.pipe(
          Effect.map((rows) => ({ removed: rows.length > 0 })),
          Effect.orDie,
        ),
      ),

    setFavorite: (input) =>
      withCommit(
        Effect.gen(function* () {
          const target = input.target;
          if (!input.favorite) {
            yield* deleteFavoriteTarget(target);
            return null;
          }
          if (target.kind === "group") {
            if (!(yield* findGroup(target.groupId))) {
              return yield* factoryError("not-found", "The project group does not exist.");
            }
          } else {
            const environments = yield* selectEnvironments({}).pipe(Effect.orDie);
            if (!environments.some((row) => row.environmentId === target.project.environmentId)) {
              return yield* factoryError("not-found", "The source environment does not exist.");
            }
            const memberships = yield* readMemberships();
            if (
              memberships.some(
                (membership) =>
                  membership.project.environmentId === target.project.environmentId &&
                  membership.project.projectId === target.project.projectId,
              )
            ) {
              return yield* factoryError(
                "invalid-request",
                "A grouped project cannot be a favorite.",
              );
            }
          }
          const favorites = yield* readFavorites();
          const existing = favorites.find((favorite) => sameTarget(favorite.target, target));
          if (existing) return existing;
          const order =
            favorites.reduce((maximum, favorite) => Math.max(maximum, favorite.order), -1) + 1;
          yield* insertFavorite(target, order);
          return { target, order } satisfies FactoryFavorite;
        }),
      ),

    reorderFavorites: (input) =>
      withCommit(
        Effect.gen(function* () {
          const favorites = yield* readFavorites();
          const currentKeys = favorites.map((favorite) => targetKey(favorite.target)).sort();
          const nextKeys = input.targets.map(targetKey);
          const sortedNextKeys = [...nextKeys].sort();
          if (
            new Set(nextKeys).size !== nextKeys.length ||
            currentKeys.length !== sortedNextKeys.length ||
            currentKeys.some((key, index) => key !== sortedNextKeys[index])
          ) {
            return yield* factoryError(
              "invalid-request",
              "Reorder must include each favorite once.",
            );
          }
          for (const [order, target] of input.targets.entries()) {
            yield* updateFavoriteOrder(target, order);
          }
          return yield* readFavorites();
        }),
      ),

    removeEnvironment: (input) =>
      withCommit(
        Effect.gen(function* () {
          const environment = yield* requireEnvironmentRevision(
            input.registrationId,
            input.revision,
          );
          if (environment.state !== "removing" || environment.credentialStorage !== null) {
            return yield* factoryError(
              "invalid-request",
              "Remove the source credential before finalizing environment removal.",
            );
          }
          yield* sql`DELETE FROM factory_environments WHERE registration_id = ${input.registrationId}`.pipe(
            Effect.orDie,
          );
          return { removed: true };
        }),
      ),
  });

  function deleteFavoriteTarget(target: FactoryFavoriteTarget) {
    return target.kind === "group"
      ? sql`DELETE FROM factory_favorites WHERE target_kind = 'group' AND group_id = ${target.groupId}`.pipe(
          Effect.orDie,
        )
      : sql`
          DELETE FROM factory_favorites
          WHERE target_kind = 'project' AND environment_id = ${target.project.environmentId}
            AND project_id = ${target.project.projectId}
        `.pipe(Effect.orDie);
  }

  function insertFavorite(target: FactoryFavoriteTarget, order: number) {
    return target.kind === "group"
      ? sql`
          INSERT INTO factory_favorites (target_kind, group_id, environment_id, project_id, order_index)
          VALUES ('group', ${target.groupId}, NULL, NULL, ${order})
        `.pipe(Effect.orDie)
      : sql`
          INSERT INTO factory_favorites (target_kind, group_id, environment_id, project_id, order_index)
          VALUES ('project', NULL, ${target.project.environmentId}, ${target.project.projectId}, ${order})
        `.pipe(Effect.orDie);
  }

  function updateFavoriteOrder(target: FactoryFavoriteTarget, order: number) {
    return target.kind === "group"
      ? sql`
          UPDATE factory_favorites SET order_index = ${order}
          WHERE target_kind = 'group' AND group_id = ${target.groupId}
        `.pipe(Effect.orDie)
      : sql`
          UPDATE factory_favorites SET order_index = ${order}
          WHERE target_kind = 'project' AND environment_id = ${target.project.environmentId}
            AND project_id = ${target.project.projectId}
        `.pipe(Effect.orDie);
  }

  function sameTarget(left: FactoryFavoriteTarget, right: FactoryFavoriteTarget) {
    return targetKey(left) === targetKey(right);
  }

  function targetKey(target: FactoryFavoriteTarget) {
    return target.kind === "group"
      ? `group:${target.groupId}`
      : `project:${target.project.environmentId}:${target.project.projectId}`;
  }
});

export const layer = Layer.effect(Metadata, make);
