import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  AuthAdministrativeScopes,
  AuthFactoryAdminScope,
  AuthFactoryControlScope,
  AuthFactoryReadScope,
  AuthStandardClientScopes,
} from "./auth.ts";
import { ExecutionEnvironmentCapabilities, ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  FactoryEnvironmentView,
  FactoryOverviewEvent,
  FactoryOverviewPatch,
  FactoryOverviewSnapshot,
  FACTORY_MAX_SNAPSHOT_BYTES,
  FACTORY_MAX_THREADS,
  FactoryEndpoint,
  FactoryThreadClassification,
  FactoryThreadSummary,
} from "./factory.ts";

const decodeThreadSummary = Schema.decodeSync(FactoryThreadSummary);
const decodeFactoryEnvironment = Schema.decodeUnknownSync(FactoryEnvironmentView);
const decodeOverviewPatch = Schema.decodeUnknownSync(FactoryOverviewPatch);
const decodeOverviewSnapshot = Schema.decodeSync(FactoryOverviewSnapshot);
const decodeOverviewEvent = Schema.decodeUnknownSync(FactoryOverviewEvent);
const decodeFactoryEndpoint = Schema.decodeUnknownSync(FactoryEndpoint);
const decodeEnvironmentCapabilities = Schema.decodeSync(ExecutionEnvironmentCapabilities);
const decodeEnvironmentDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);

const threadSummary = {
  key: { environmentId: "source-a", threadId: "thread-1" },
  target: { registrationId: "registration-a", environmentId: "source-a" },
  project: { environmentId: "source-a", projectId: "project-1" },
  title: "Fix the test",
  sourceStatus: "completed",
  classification: "finished",
  providerInstanceId: "codex",
  model: "gpt-5",
  branch: "feature/fix",
  worktreePath: "/work/fix",
  settled: false,
  settledAt: null,
  settledOverride: null,
  providerCompletedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
  finalizedAt: null,
  createdAt: DateTime.makeUnsafe("2026-10-03T09:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
} as const;

const projectSummary = {
  key: { environmentId: "source-a", projectId: "project-empty" },
  target: { registrationId: "registration-a", environmentId: "source-a" },
  title: "Empty workspace",
  workspaceRoot: "/work/empty",
  createdAt: "2026-10-03T09:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
} as const;

describe("factory contracts", () => {
  it("decodes compact thread summaries with distinct source and factory status", () => {
    expect(decodeThreadSummary(threadSummary)).toEqual(threadSummary);
    expect(FactoryThreadClassification.literals).toEqual([
      "waiting",
      "active",
      "failed",
      "settled",
      "finished",
      "cancelled",
      "idle",
      "unknown",
    ]);
  });

  it("keeps archive state and credential material out of overview summaries", () => {
    expect("archivedAt" in FactoryThreadSummary.fields).toBe(false);
    expect("credential" in FactoryEnvironmentView.fields).toBe(false);
    expect("sourceCredential" in FactoryEnvironmentView.fields).toBe(false);
  });

  it("reports cleanup pending without changing the replacement credential status", () => {
    const environment = decodeFactoryEnvironment({
      registrationId: "registration-a",
      environmentId: "source-a",
      endpoint: "https://source.example",
      label: "Source",
      platform: null,
      enabled: true,
      state: "offline",
      credentialStorage: "secure-vault",
      credentialExpiresAt: null,
      renewal: "ready",
      cleanupPending: true,
      lastSeenAt: null,
      revision: 0,
    });

    expect(environment.renewal).toBe("ready");
    expect(environment.cleanupPending).toBe(true);
  });

  it("requires metadata patches to replace memberships and favorites together", () => {
    const metadataPatch = decodeOverviewPatch({
      kind: "metadata",
      groups: [],
      memberships: [],
      favorites: [],
    });
    expect(metadataPatch).toEqual({
      kind: "metadata",
      groups: [],
      memberships: [],
      favorites: [],
    });
    expect(() =>
      decodeOverviewPatch({
        kind: "metadata",
        groups: [],
        memberships: [],
      }),
    ).toThrow();
  });

  it("rejects overview snapshots above the declared thread limit", () => {
    expect(() =>
      decodeOverviewSnapshot({
        generation: "generation-a",
        revision: 0,
        environments: [],
        sourceFreshness: [],
        threads: Array.from({ length: FACTORY_MAX_THREADS + 1 }, () => threadSummary),
        projects: [],
        groups: [],
        memberships: [],
        favorites: [],
      }),
    ).toThrow();
  });

  it("decodes generation-scoped snapshots and keyed upsert/removal patches", () => {
    const snapshot = decodeOverviewSnapshot({
      generation: "generation-a",
      revision: 0,
      environments: [],
      sourceFreshness: [],
      threads: [threadSummary],
      projects: [projectSummary],
      groups: [],
      memberships: [],
      favorites: [],
    });
    expect(snapshot.revision).toBe(0);
    expect(snapshot.projects).toEqual([projectSummary]);

    const upsert = decodeOverviewEvent({
      generation: "generation-a",
      revision: 1,
      type: "patch",
      patch: {
        kind: "threads",
        upserts: [threadSummary],
        removals: [],
      },
    });
    expect(upsert.type).toBe("patch");
    expect(() =>
      decodeOverviewEvent({
        generation: "generation-a",
        revision: 2,
        type: "patch",
        patch: {
          kind: "threads",
          upserts: [],
          removals: [{ environmentId: "source-a" }],
        },
      }),
    ).toThrow();
  });

  it("decodes standalone project summaries and keyed upsert/removal patches", () => {
    const snapshot = decodeOverviewSnapshot({
      generation: "generation-a",
      revision: 0,
      environments: [],
      sourceFreshness: [],
      threads: [],
      projects: [projectSummary],
      groups: [],
      memberships: [],
      favorites: [],
    });
    expect(snapshot.threads).toEqual([]);
    expect(snapshot.projects).toEqual([projectSummary]);

    expect(
      decodeOverviewEvent({
        type: "patch",
        generation: "generation-a",
        revision: 1,
        patch: { kind: "projects", upserts: [projectSummary], removals: [] },
      }),
    ).toMatchObject({ type: "patch", patch: { kind: "projects", upserts: [projectSummary] } });
    expect(
      decodeOverviewEvent({
        type: "patch",
        generation: "generation-a",
        revision: 2,
        patch: {
          kind: "projects",
          upserts: [],
          removals: [{ key: projectSummary.key, target: projectSummary.target }],
        },
      }),
    ).toMatchObject({
      type: "patch",
      patch: {
        kind: "projects",
        removals: [
          {
            key: projectSummary.key,
            target: projectSummary.target,
          },
        ],
      },
    });
  });

  it("keeps factory grants opt-in and legacy server descriptors feature-disabled", () => {
    expect(AuthFactoryReadScope).toBe("factory:read");
    expect(AuthFactoryControlScope).toBe("factory:control");
    expect(AuthFactoryAdminScope).toBe("factory:admin");
    expect(AuthStandardClientScopes).not.toContain(AuthFactoryReadScope);
    expect(AuthStandardClientScopes).not.toContain(AuthFactoryControlScope);
    expect(AuthStandardClientScopes).not.toContain(AuthFactoryAdminScope);
    expect(AuthAdministrativeScopes).not.toContain(AuthFactoryReadScope);
    expect(AuthAdministrativeScopes).not.toContain(AuthFactoryControlScope);
    expect(AuthAdministrativeScopes).not.toContain(AuthFactoryAdminScope);
    expect(AuthStandardClientScopes).toEqual([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "relay:read",
    ]);
    expect(AuthAdministrativeScopes).toEqual([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "relay:read",
      "access:read",
      "access:write",
      "relay:write",
    ]);

    expect(FACTORY_MAX_THREADS).toBe(10_000);
    expect(FACTORY_MAX_SNAPSHOT_BYTES).toBe(8 * 1024 * 1024);
    expect(() => decodeFactoryEndpoint("https://@source.example")).toThrow();
    expect(() => decodeFactoryEndpoint("https://source.example/?query=value")).toThrow();

    const oldCapabilities = decodeEnvironmentCapabilities({
      repositoryIdentity: true,
    });
    expect(oldCapabilities.factory).toBeUndefined();
    expect(oldCapabilities.factoryRenewal).toBeUndefined();
    expect(oldCapabilities.batchedReplay).toBeUndefined();

    const oldDescriptor = decodeEnvironmentDescriptor({
      environmentId: "source-a",
      label: "Source",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    });
    expect(oldDescriptor.capabilities.factory).toBeUndefined();
    expect(oldDescriptor.factoryProtocolVersion).toBeUndefined();
  });
});
