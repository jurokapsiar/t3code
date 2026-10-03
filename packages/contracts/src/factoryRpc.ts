import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AuthFactoryAdminScope,
  AuthFactoryControlScope,
  AuthFactoryReadScope,
  AuthSourceMethodScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  FactoryEndpoint,
  FactoryEnvironmentView,
  FactoryError,
  FactoryFavorite,
  FactoryFavoriteTarget,
  FactoryGroup,
  FactoryGroupId,
  FactoryMembership,
  FactoryOverviewEvent,
  FactoryProjectKey,
  FactoryRegistrationId,
} from "./factory.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FactoryRpcMethods = {
  environmentsList: "factory.environments.list",
  environmentsEnroll: "factory.environments.enroll",
  environmentsUpdate: "factory.environments.update",
  environmentsRemove: "factory.environments.remove",
  environmentsRetry: "factory.environments.retry",
  groupsList: "factory.groups.list",
  groupsCreate: "factory.groups.create",
  groupsUpdate: "factory.groups.update",
  groupsDelete: "factory.groups.delete",
  groupsAssign: "factory.groups.assign",
  groupsUnassign: "factory.groups.unassign",
  favoritesSet: "factory.favorites.set",
  favoritesReorder: "factory.favorites.reorder",
  overviewSubscribe: "factory.overview.subscribe",
} as const;
export type FactoryRpcMethod = (typeof FactoryRpcMethods)[keyof typeof FactoryRpcMethods];

export const FactoryRpcScope = Schema.Literals([
  AuthFactoryReadScope,
  AuthFactoryControlScope,
  AuthFactoryAdminScope,
]);
export type FactoryRpcScope = typeof FactoryRpcScope.Type;

export const FactoryRelayScope = Schema.Union([FactoryRpcScope, AuthSourceMethodScope]);
export type FactoryRelayScope = typeof FactoryRelayScope.Type;

export const FactoryRpcMethodScopes = {
  [FactoryRpcMethods.environmentsList]: AuthFactoryReadScope,
  [FactoryRpcMethods.environmentsEnroll]: AuthFactoryAdminScope,
  [FactoryRpcMethods.environmentsUpdate]: AuthFactoryAdminScope,
  [FactoryRpcMethods.environmentsRemove]: AuthFactoryAdminScope,
  [FactoryRpcMethods.environmentsRetry]: AuthFactoryAdminScope,
  [FactoryRpcMethods.groupsList]: AuthFactoryReadScope,
  [FactoryRpcMethods.groupsCreate]: AuthFactoryControlScope,
  [FactoryRpcMethods.groupsUpdate]: AuthFactoryControlScope,
  [FactoryRpcMethods.groupsDelete]: AuthFactoryControlScope,
  [FactoryRpcMethods.groupsAssign]: AuthFactoryControlScope,
  [FactoryRpcMethods.groupsUnassign]: AuthFactoryControlScope,
  [FactoryRpcMethods.favoritesSet]: AuthFactoryControlScope,
  [FactoryRpcMethods.favoritesReorder]: AuthFactoryControlScope,
  [FactoryRpcMethods.overviewSubscribe]: AuthFactoryReadScope,
} as const satisfies Record<FactoryRpcMethod, FactoryRpcScope>;

const FactoryRpcError = Schema.Union([FactoryError, EnvironmentAuthorizationError]);
const EmptyInput = Schema.Struct({});
const FactoryRevisionInput = Schema.Struct({ revision: NonNegativeInt });
const FactoryProjectMembershipInput = Schema.Struct({
  groupId: FactoryGroupId,
  project: FactoryProjectKey,
});

export const FactoryEnrollmentCredential = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "Sensitive, short-lived source credential. Use only for enrollment.",
});
export type FactoryEnrollmentCredential = typeof FactoryEnrollmentCredential.Type;

export const FactoryEnvironmentEnrollInput = Schema.Struct({
  endpoint: FactoryEndpoint,
  label: TrimmedNonEmptyString,
  sourceCredential: FactoryEnrollmentCredential,
});
export type FactoryEnvironmentEnrollInput = typeof FactoryEnvironmentEnrollInput.Type;

export const FactoryEnvironmentsListRpc = Rpc.make(FactoryRpcMethods.environmentsList, {
  payload: EmptyInput,
  success: Schema.Array(FactoryEnvironmentView),
  error: FactoryRpcError,
});

export const FactoryEnvironmentsEnrollRpc = Rpc.make(FactoryRpcMethods.environmentsEnroll, {
  payload: FactoryEnvironmentEnrollInput,
  success: FactoryEnvironmentView,
  error: FactoryRpcError,
});

export const FactoryEnvironmentsUpdateRpc = Rpc.make(FactoryRpcMethods.environmentsUpdate, {
  payload: Schema.Struct({
    registrationId: FactoryRegistrationId,
    endpoint: Schema.optional(FactoryEndpoint),
    label: Schema.optional(TrimmedNonEmptyString),
    enabled: Schema.optional(Schema.Boolean),
    ...FactoryRevisionInput.fields,
  }),
  success: FactoryEnvironmentView,
  error: FactoryRpcError,
});

export const FactoryEnvironmentsRemoveRpc = Rpc.make(FactoryRpcMethods.environmentsRemove, {
  payload: Schema.Struct({ registrationId: FactoryRegistrationId, ...FactoryRevisionInput.fields }),
  success: Schema.Struct({ removed: Schema.Boolean }),
  error: FactoryRpcError,
});

export const FactoryEnvironmentsRetryRpc = Rpc.make(FactoryRpcMethods.environmentsRetry, {
  payload: Schema.Struct({
    registrationId: FactoryRegistrationId,
  }),
  success: Schema.Struct({ requested: Schema.Boolean }),
  error: FactoryRpcError,
});

export const FactoryGroupsListRpc = Rpc.make(FactoryRpcMethods.groupsList, {
  payload: EmptyInput,
  success: Schema.Struct({
    groups: Schema.Array(FactoryGroup),
    memberships: Schema.Array(FactoryMembership),
  }),
  error: FactoryRpcError,
});

export const FactoryGroupsCreateRpc = Rpc.make(FactoryRpcMethods.groupsCreate, {
  payload: Schema.Struct({ name: TrimmedNonEmptyString }),
  success: FactoryGroup,
  error: FactoryRpcError,
});

export const FactoryGroupsUpdateRpc = Rpc.make(FactoryRpcMethods.groupsUpdate, {
  payload: Schema.Struct({
    groupId: FactoryGroupId,
    name: TrimmedNonEmptyString,
    ...FactoryRevisionInput.fields,
  }),
  success: FactoryGroup,
  error: FactoryRpcError,
});

export const FactoryGroupsDeleteRpc = Rpc.make(FactoryRpcMethods.groupsDelete, {
  payload: Schema.Struct({
    groupId: FactoryGroupId,
    ...FactoryRevisionInput.fields,
  }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
  error: FactoryRpcError,
});

export const FactoryGroupsAssignRpc = Rpc.make(FactoryRpcMethods.groupsAssign, {
  payload: FactoryProjectMembershipInput,
  success: FactoryMembership,
  error: FactoryRpcError,
});

export const FactoryGroupsUnassignRpc = Rpc.make(FactoryRpcMethods.groupsUnassign, {
  payload: FactoryProjectMembershipInput,
  success: Schema.Struct({ removed: Schema.Boolean }),
  error: FactoryRpcError,
});

export const FactoryFavoritesSetRpc = Rpc.make(FactoryRpcMethods.favoritesSet, {
  payload: Schema.Struct({
    target: FactoryFavoriteTarget,
    favorite: Schema.Boolean,
  }),
  success: Schema.NullOr(FactoryFavorite),
  error: FactoryRpcError,
});

export const FactoryFavoritesReorderRpc = Rpc.make(FactoryRpcMethods.favoritesReorder, {
  payload: Schema.Struct({ targets: Schema.Array(FactoryFavoriteTarget) }),
  success: Schema.Array(FactoryFavorite),
  error: FactoryRpcError,
});

export const FactoryOverviewSubscribeRpc = Rpc.make(FactoryRpcMethods.overviewSubscribe, {
  payload: EmptyInput,
  success: FactoryOverviewEvent,
  error: FactoryRpcError,
  stream: true,
});

export const FactoryRpcGroup = RpcGroup.make(
  FactoryEnvironmentsListRpc,
  FactoryEnvironmentsEnrollRpc,
  FactoryEnvironmentsUpdateRpc,
  FactoryEnvironmentsRemoveRpc,
  FactoryEnvironmentsRetryRpc,
  FactoryGroupsListRpc,
  FactoryGroupsCreateRpc,
  FactoryGroupsUpdateRpc,
  FactoryGroupsDeleteRpc,
  FactoryGroupsAssignRpc,
  FactoryGroupsUnassignRpc,
  FactoryFavoritesSetRpc,
  FactoryFavoritesReorderRpc,
  FactoryOverviewSubscribeRpc,
);

export type FactoryRpcGroup = typeof FactoryRpcGroup;
