import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatform } from "./environment.ts";
import { OrchestrationV2ShellThreadStatus } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const FACTORY_PROTOCOL_VERSION = 1;
export const FACTORY_MAX_THREADS = 10_000;
export const FACTORY_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const FactoryEntityId = TrimmedNonEmptyString;
export const FactoryRegistrationId = FactoryEntityId.pipe(Schema.brand("FactoryRegistrationId"));
export type FactoryRegistrationId = typeof FactoryRegistrationId.Type;
export const FactoryGroupId = FactoryEntityId.pipe(Schema.brand("FactoryGroupId"));
export type FactoryGroupId = typeof FactoryGroupId.Type;
export const FactoryGenerationId = FactoryEntityId.pipe(Schema.brand("FactoryGenerationId"));
export type FactoryGenerationId = typeof FactoryGenerationId.Type;

export const FactoryEndpoint = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^https?:\/\/(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?(?:\/[^?#\s]*)?$/,
  ),
);
export type FactoryEndpoint = typeof FactoryEndpoint.Type;

export const FactoryRemoteTarget = Schema.Struct({
  registrationId: FactoryRegistrationId,
  environmentId: EnvironmentId,
});
export type FactoryRemoteTarget = typeof FactoryRemoteTarget.Type;

export const FactoryProjectKey = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type FactoryProjectKey = typeof FactoryProjectKey.Type;

export const FactoryProjectSummary = Schema.Struct({
  key: FactoryProjectKey,
  target: FactoryRemoteTarget,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryProjectSummary = typeof FactoryProjectSummary.Type;

export const FactoryProjectReference = Schema.Struct({
  key: FactoryProjectKey,
  target: FactoryRemoteTarget,
});
export type FactoryProjectReference = typeof FactoryProjectReference.Type;

export const FactoryThreadKey = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type FactoryThreadKey = typeof FactoryThreadKey.Type;

export const FactoryThreadClassification = Schema.Literals([
  "waiting",
  "active",
  "failed",
  "settled",
  "finished",
  "cancelled",
  "idle",
  "unknown",
]);
export type FactoryThreadClassification = typeof FactoryThreadClassification.Type;

export const FactorySourceStatus = Schema.Union([
  OrchestrationV2ShellThreadStatus,
  Schema.Literals(["missing", "incompatible"]),
]);
export type FactorySourceStatus = typeof FactorySourceStatus.Type;

export const FactoryThreadSummary = Schema.Struct({
  key: FactoryThreadKey,
  target: FactoryRemoteTarget,
  project: FactoryProjectKey,
  title: Schema.String,
  sourceStatus: FactorySourceStatus,
  classification: FactoryThreadClassification,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(Schema.DateTimeUtc),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  providerCompletedAt: Schema.NullOr(Schema.DateTimeUtc),
  finalizedAt: Schema.NullOr(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type FactoryThreadSummary = typeof FactoryThreadSummary.Type;

export const FactoryEnvironmentState = Schema.Literals([
  "pending",
  "online",
  "offline",
  "blocked",
  "removing",
]);
export type FactoryEnvironmentState = typeof FactoryEnvironmentState.Type;

export const FactoryCredentialStorage = Schema.Literals(["secure-vault", "protected-file"]);
export type FactoryCredentialStorage = typeof FactoryCredentialStorage.Type;

export const FactoryRenewalState = Schema.Literals([
  "ready",
  "unsupported",
  "due",
  "failed",
  "expired",
]);
export type FactoryRenewalState = typeof FactoryRenewalState.Type;

export const FactoryEnvironmentView = Schema.Struct({
  registrationId: FactoryRegistrationId,
  environmentId: EnvironmentId,
  endpoint: FactoryEndpoint,
  label: TrimmedNonEmptyString,
  platform: Schema.NullOr(ExecutionEnvironmentPlatform),
  enabled: Schema.Boolean,
  state: FactoryEnvironmentState,
  credentialStorage: Schema.NullOr(FactoryCredentialStorage),
  credentialExpiresAt: Schema.NullOr(Schema.DateTimeUtc),
  renewal: FactoryRenewalState,
  cleanupPending: Schema.Boolean,
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtc),
  revision: NonNegativeInt,
});
export type FactoryEnvironmentView = typeof FactoryEnvironmentView.Type;

export const FactoryGroup = Schema.Struct({
  id: FactoryGroupId,
  name: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type FactoryGroup = typeof FactoryGroup.Type;

export const FactoryMembership = Schema.Struct({
  groupId: FactoryGroupId,
  project: FactoryProjectKey,
});
export type FactoryMembership = typeof FactoryMembership.Type;

export const FactoryFavoriteTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), project: FactoryProjectKey }),
  Schema.Struct({ kind: Schema.Literal("group"), groupId: FactoryGroupId }),
]);
export type FactoryFavoriteTarget = typeof FactoryFavoriteTarget.Type;

export const FactoryFavorite = Schema.Struct({
  target: FactoryFavoriteTarget,
  order: NonNegativeInt,
});
export type FactoryFavorite = typeof FactoryFavorite.Type;

export const FactorySourceFreshness = Schema.Struct({
  target: FactoryRemoteTarget,
  state: Schema.Literals(["synchronizing", "fresh", "stale", "offline", "blocked"]),
  reason: Schema.NullOr(
    Schema.Literals([
      "auth-required",
      "transport",
      "protocol-mismatch",
      "permission",
      "identity-mismatch",
      "invalid-data",
    ]),
  ),
  updatedAt: Schema.NullOr(Schema.DateTimeUtc),
  retryAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type FactorySourceFreshness = typeof FactorySourceFreshness.Type;

export const FactoryOverviewSnapshot = Schema.Struct({
  generation: FactoryGenerationId,
  revision: NonNegativeInt,
  environments: Schema.Array(FactoryEnvironmentView),
  sourceFreshness: Schema.Array(FactorySourceFreshness),
  threads: Schema.Array(FactoryThreadSummary).check(Schema.isMaxLength(FACTORY_MAX_THREADS)),
  projects: Schema.Array(FactoryProjectSummary),
  groups: Schema.Array(FactoryGroup),
  memberships: Schema.Array(FactoryMembership),
  favorites: Schema.Array(FactoryFavorite),
});
export type FactoryOverviewSnapshot = typeof FactoryOverviewSnapshot.Type;

export const FactoryOverviewThreadPatch = Schema.Struct({
  kind: Schema.Literal("threads"),
  upserts: Schema.Array(FactoryThreadSummary),
  removals: Schema.Array(FactoryThreadKey),
});
export type FactoryOverviewThreadPatch = typeof FactoryOverviewThreadPatch.Type;

export const FactoryOverviewProjectPatch = Schema.Struct({
  kind: Schema.Literal("projects"),
  upserts: Schema.Array(FactoryProjectSummary),
  removals: Schema.Array(FactoryProjectReference),
});
export type FactoryOverviewProjectPatch = typeof FactoryOverviewProjectPatch.Type;

export const FactoryOverviewEnvironmentPatch = Schema.Struct({
  kind: Schema.Literal("environments"),
  upserts: Schema.Array(FactoryEnvironmentView),
  removals: Schema.Array(FactoryRegistrationId),
});
export type FactoryOverviewEnvironmentPatch = typeof FactoryOverviewEnvironmentPatch.Type;

export const FactoryOverviewFreshnessPatch = Schema.Struct({
  kind: Schema.Literal("sourceFreshness"),
  upserts: Schema.Array(FactorySourceFreshness),
  removals: Schema.Array(FactoryRemoteTarget),
});
export type FactoryOverviewFreshnessPatch = typeof FactoryOverviewFreshnessPatch.Type;

export const FactoryOverviewMetadataPatch = Schema.Struct({
  kind: Schema.Literal("metadata"),
  groups: Schema.Array(FactoryGroup),
  memberships: Schema.Array(FactoryMembership),
  favorites: Schema.Array(FactoryFavorite),
});
export type FactoryOverviewMetadataPatch = typeof FactoryOverviewMetadataPatch.Type;

export const FactoryOverviewPatch = Schema.Union([
  FactoryOverviewThreadPatch,
  FactoryOverviewProjectPatch,
  FactoryOverviewEnvironmentPatch,
  FactoryOverviewFreshnessPatch,
  FactoryOverviewMetadataPatch,
]);
export type FactoryOverviewPatch = typeof FactoryOverviewPatch.Type;

export const FactoryOverviewSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: FactoryOverviewSnapshot,
});
export type FactoryOverviewSnapshotEvent = typeof FactoryOverviewSnapshotEvent.Type;

export const FactoryOverviewPatchEvent = Schema.Struct({
  type: Schema.Literal("patch"),
  generation: FactoryGenerationId,
  revision: NonNegativeInt,
  patch: FactoryOverviewPatch,
});
export type FactoryOverviewPatchEvent = typeof FactoryOverviewPatchEvent.Type;

export const FactoryOverviewEvent = Schema.Union([
  FactoryOverviewSnapshotEvent,
  FactoryOverviewPatchEvent,
]);
export type FactoryOverviewEvent = typeof FactoryOverviewEvent.Type;

export const FactoryErrorCode = Schema.Literals([
  "feature-disabled",
  "not-found",
  "conflict",
  "invalid-request",
  "overview-too-large",
  "operation-failed",
]);
export type FactoryErrorCode = typeof FactoryErrorCode.Type;

export class FactoryError extends Schema.TaggedError<FactoryError>()("FactoryError", {
  code: FactoryErrorCode,
  message: Schema.String,
}) {}
