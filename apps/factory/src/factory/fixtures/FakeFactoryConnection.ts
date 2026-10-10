import {
  FactoryOverviewEvent as FactoryOverviewEventSchema,
  FactoryOverviewSnapshot as FactoryOverviewSnapshotSchema,
  type FactoryOverviewSnapshot,
} from "@t3tools/contracts/factory";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { FactoryConnectionApi, FactoryRpcClient } from "../FactoryConnection";
import { FactoryConnection } from "../FactoryConnection";

type OverviewEvent = typeof FactoryOverviewEventSchema.Type;
type EnvironmentListResult = Effect.Success<
  ReturnType<FactoryRpcClient["factory.environments.list"]>
>;
type GroupsListResult = Effect.Success<ReturnType<FactoryRpcClient["factory.groups.list"]>>;

const fixtureTime = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-10-03T12:00:00Z");

const snapshot: FactoryOverviewSnapshot = Schema.decodeUnknownSync(FactoryOverviewSnapshotSchema)({
  generation: "fixture-generation",
  revision: 1,
  environments: [
    {
      registrationId: "fixture-registration",
      environmentId: "fixture-environment",
      endpoint: "http://localhost:4000",
      label: "Simulated local source",
      platform: { os: "linux", arch: "x64" },
      enabled: true,
      state: "online",
      credentialStorage: null,
      credentialExpiresAt: null,
      renewal: "unsupported",
      lastSeenAt: fixtureTime,
      revision: 1,
      sourceAccess: {
        websocketRoute: "/factory/env/fixture-registration/ws",
        httpPrefix: "/factory/env/fixture-registration/",
        capabilities: { websocket: true, http: true },
      },
    },
  ],
  sourceFreshness: [
    {
      target: { registrationId: "fixture-registration", environmentId: "fixture-environment" },
      state: "fresh",
      reason: null,
      updatedAt: fixtureTime,
      retryAt: null,
    },
  ],
  threads: [
    {
      key: { environmentId: "fixture-environment", threadId: "fixture-thread" },
      target: { registrationId: "fixture-registration", environmentId: "fixture-environment" },
      project: { environmentId: "fixture-environment", projectId: "fixture-project" },
      title: "Simulated: Review the release plan",
      sourceStatus: "running",
      classification: "active",
      providerInstanceId: "fixture-provider",
      model: "simulated-model",
      branch: "feature/simulated",
      worktreePath: "/simulated/worktree",
      settled: false,
      settledAt: null,
      settledOverride: null,
      providerCompletedAt: null,
      finalizedAt: null,
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
    },
  ],
  projects: [
    {
      key: { environmentId: "fixture-environment", projectId: "fixture-project" },
      target: { registrationId: "fixture-registration", environmentId: "fixture-environment" },
      title: "Simulated project",
      workspaceRoot: "/simulated/project",
      createdAt: "2026-10-03T12:00:00Z",
      updatedAt: "2026-10-03T12:00:00Z",
    },
    {
      key: { environmentId: "fixture-environment", projectId: "fixture-empty-project" },
      target: { registrationId: "fixture-registration", environmentId: "fixture-environment" },
      title: "Simulated empty project",
      workspaceRoot: "/simulated/empty-project",
      createdAt: "2026-10-03T12:00:00Z",
      updatedAt: "2026-10-03T12:00:00Z",
    },
  ],
  groups: [
    {
      id: "fixture-group",
      name: "Simulated group",
      revision: 1,
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
    },
  ],
  memberships: [
    {
      groupId: "fixture-group",
      project: { environmentId: "fixture-environment", projectId: "fixture-project" },
    },
  ],
  favorites: [
    {
      target: { kind: "group", groupId: "fixture-group" },
      order: 0,
    },
  ],
});

const thread = snapshot.threads[0];
const freshness = snapshot.sourceFreshness[0];
const standaloneProject = snapshot.projects.find(
  (project) => project.key.projectId === "fixture-empty-project",
);
if (thread === undefined || freshness === undefined || standaloneProject === undefined) {
  throw new Error("Factory fixture data is incomplete");
}

const events: ReadonlyArray<OverviewEvent> = [
  Schema.decodeUnknownSync(FactoryOverviewEventSchema)({ type: "snapshot", snapshot }),
  Schema.decodeUnknownSync(FactoryOverviewEventSchema)({
    type: "patch",
    generation: snapshot.generation,
    revision: 2,
    patch: {
      kind: "threads",
      upserts: [{ ...thread, title: "Simulated: Check release readiness" }],
      removals: [],
    },
  }),
  Schema.decodeUnknownSync(FactoryOverviewEventSchema)({
    type: "patch",
    generation: snapshot.generation,
    revision: 3,
    patch: {
      kind: "sourceFreshness",
      upserts: [{ ...freshness, state: "stale", reason: "transport" }],
      removals: [],
    },
  }),
  Schema.decodeUnknownSync(FactoryOverviewEventSchema)({
    type: "patch",
    generation: snapshot.generation,
    revision: 4,
    patch: {
      kind: "metadata",
      groups: snapshot.groups,
      memberships: snapshot.memberships,
      favorites: snapshot.favorites,
    },
  }),
  Schema.decodeUnknownSync(FactoryOverviewEventSchema)({
    type: "patch",
    generation: snapshot.generation,
    revision: 5,
    patch: {
      kind: "projects",
      upserts: [{ ...standaloneProject, title: "Updated simulated empty project" }],
      removals: [],
    },
  }),
];

const environments: EnvironmentListResult = snapshot.environments;
const groups: GroupsListResult = { groups: snapshot.groups, memberships: snapshot.memberships };

const factory = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "factory.overview.subscribe") {
        return () => Stream.concat(Stream.fromIterable(events), Stream.never);
      }
      if (property === "factory.source.controlAuthorization")
        return () =>
          Effect.succeed({ allowed: false as const, reason: "source-unavailable" as const });
      if (property === "factory.environments.list") return () => Effect.succeed(environments);
      if (property === "factory.groups.list") return () => Effect.succeed(groups);
      return () =>
        Effect.fail(new Error(`No simulated response for factory RPC ${String(property)}`));
    },
  },
) as FactoryRpcClient;

export function createFakeFactoryConnection(): FactoryConnectionApi {
  return new FactoryConnection({
    simulated: true,
    openTransport: async () => ({ factory, factoryId: "fixture-factory" }),
  });
}
