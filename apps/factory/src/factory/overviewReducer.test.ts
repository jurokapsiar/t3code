import {
  FACTORY_MAX_SNAPSHOT_BYTES,
  FACTORY_MAX_THREADS,
  FactoryOverviewEvent,
  FactoryOverviewSnapshot,
} from "@t3tools/contracts/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { applyOverviewEvent } from "./overviewReducer";

const decodeSnapshot = Schema.decodeUnknownSync(FactoryOverviewSnapshot);
const encodeSnapshotJson = Schema.encodeSync(Schema.fromJsonString(FactoryOverviewSnapshot));
const encodedSnapshotBytes = (snapshot: typeof FactoryOverviewSnapshot.Type) =>
  new TextEncoder().encode(encodeSnapshotJson(snapshot)).byteLength;
const utcNow = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-10-03T12:00:00Z");
const decodeEvent = Schema.decodeUnknownSync(FactoryOverviewEvent);

function makeEnvironment(environmentId = "environment-1", registrationId = "registration-1") {
  return {
    environmentId,
    registrationId,
    endpoint: "http://localhost:4000",
    label: "Development source",
    platform: { os: "linux", arch: "x64" },
    enabled: true,
    state: "online",
    credentialStorage: null,
    credentialExpiresAt: null,
    renewal: "unsupported",
    lastSeenAt: utcNow,
    revision: 1,
  };
}

function makeThread(title = "Initial title", threadId = "thread-1") {
  return {
    key: { environmentId: "environment-1", threadId },
    target: { registrationId: "registration-1", environmentId: "environment-1" },
    project: { environmentId: "environment-1", projectId: "project-1" },
    title,
    sourceStatus: "running",
    classification: "active",
    providerInstanceId: "provider-1",
    model: "test-model",
    branch: null,
    worktreePath: null,
    settled: false,
    settledAt: null,
    settledOverride: null,
    providerCompletedAt: null,
    finalizedAt: null,
    createdAt: utcNow,
    updatedAt: utcNow,
  };
}

function makeProject(
  projectId = "project-1",
  registrationId = "registration-1",
  title = "Source project",
  environmentId = "environment-1",
) {
  return {
    key: { environmentId, projectId },
    target: { registrationId, environmentId },
    title,
    workspaceRoot: `/work/${projectId}`,
    createdAt: "2026-10-03T12:00:00Z",
    updatedAt: "2026-10-03T12:00:00Z",
  };
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return decodeSnapshot({
    generation: "generation-1",
    revision: 1,
    environments: [makeEnvironment()],
    sourceFreshness: [
      {
        target: { registrationId: "registration-1", environmentId: "environment-1" },
        state: "fresh",
        reason: null,
        updatedAt: utcNow,
        retryAt: null,
      },
    ],
    threads: [makeThread()],
    projects: [makeProject()],
    groups: [],
    memberships: [],
    favorites: [],
    ...overrides,
  });
}

function makePatch(revision: number, patch: unknown, generation = "generation-1") {
  return decodeEvent({ type: "patch", generation, revision, patch });
}

describe("applyOverviewEvent", () => {
  it("replaces the complete cache when a snapshot arrives", () => {
    const next = makeSnapshot({ generation: "generation-2", revision: 7, threads: [] });
    expect(
      applyOverviewEvent(undefined, decodeEvent({ type: "snapshot", snapshot: next })),
    ).toEqual({ kind: "applied", value: next });
  });

  it("applies a consecutive thread patch without changing other collections", () => {
    const current = makeSnapshot();
    const result = applyOverviewEvent(
      current,
      makePatch(2, {
        kind: "threads",
        upserts: [makeThread("Updated title")],
        removals: [],
      }),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.value.revision).toBe(2);
    expect(result.value.threads[0].title).toBe("Updated title");
    expect(result.value.environments).toEqual(current.environments);
  });

  it("requires a snapshot before accepting a patch", () => {
    expect(
      applyOverviewEvent(
        undefined,
        makePatch(1, {
          kind: "threads",
          upserts: [],
          removals: [],
        }),
      ),
    ).toEqual({ kind: "reset-required", reason: "missing-snapshot" });
  });

  it("requires a new snapshot when a patch changes generation", () => {
    expect(
      applyOverviewEvent(
        makeSnapshot(),
        makePatch(
          2,
          {
            kind: "threads",
            upserts: [],
            removals: [],
          },
          "generation-2",
        ),
      ),
    ).toEqual({ kind: "reset-required", reason: "generation-changed" });
  });

  it("replaces metadata collections together from a metadata patch", () => {
    const current = makeSnapshot();
    const group = {
      id: "group-1",
      name: "New group",
      revision: 1,
      createdAt: utcNow,
      updatedAt: utcNow,
    };
    const result = applyOverviewEvent(
      current,
      makePatch(2, {
        kind: "metadata",
        groups: [group],
        memberships: [],
        favorites: [],
      }),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.value.groups).toEqual([group]);
    expect(result.value.memberships).toEqual([]);
    expect(result.value.favorites).toEqual([]);
    expect(result.value.threads).toEqual(current.threads);
  });

  it("ignores an already-applied patch revision", () => {
    const current = makeSnapshot({ revision: 2 });
    expect(
      applyOverviewEvent(
        current,
        makePatch(2, {
          kind: "threads",
          upserts: [makeThread("Duplicate")],
          removals: [],
        }),
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("requires a snapshot instead of applying a removal for an unknown thread", () => {
    expect(
      applyOverviewEvent(
        makeSnapshot(),
        makePatch(2, {
          kind: "threads",
          upserts: [],
          removals: [{ environmentId: "environment-1", threadId: "missing" }],
        }),
      ),
    ).toEqual({ kind: "reset-required", reason: "invalid-patch" });
  });

  it("requires a snapshot when a patch skips a revision", () => {
    expect(
      applyOverviewEvent(
        makeSnapshot(),
        makePatch(3, {
          kind: "threads",
          upserts: [],
          removals: [],
        }),
      ),
    ).toEqual({ kind: "reset-required", reason: "revision-gap" });
  });

  it("applies keyed environment and freshness changes from the same revisioned stream", () => {
    const current = makeSnapshot();
    const environment = { ...makeEnvironment(), label: "Renamed source", revision: 2 };
    const freshness = {
      target: { registrationId: "registration-1", environmentId: "environment-1" },
      state: "stale",
      reason: "transport",
      updatedAt: null,
      retryAt: null,
    };
    const environmentResult = applyOverviewEvent(
      current,
      makePatch(2, {
        kind: "environments",
        upserts: [environment],
        removals: [],
      }),
    );
    expect(environmentResult.kind).toBe("applied");
    if (environmentResult.kind !== "applied") return;
    const freshnessResult = applyOverviewEvent(
      environmentResult.value,
      makePatch(3, {
        kind: "sourceFreshness",
        upserts: [freshness],
        removals: [],
      }),
    );
    expect(freshnessResult.kind).toBe("applied");
    if (freshnessResult.kind !== "applied") return;
    expect(freshnessResult.value.environments[0].label).toBe("Renamed source");
    expect(freshnessResult.value.sourceFreshness[0].state).toBe("stale");
  });

  it("retains and removes a standalone project with no threads", () => {
    const emptyProject = makeProject("empty-project", "registration-1", "Empty project");
    const current = makeSnapshot({ threads: [], projects: [emptyProject] });
    expect(current.threads).toEqual([]);
    expect(current.projects).toEqual([emptyProject]);

    const result = applyOverviewEvent(
      current,
      makePatch(2, {
        kind: "projects",
        upserts: [],
        removals: [{ key: emptyProject.key, target: emptyProject.target }],
      }),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.value.projects).toEqual([]);
    expect(result.value.threads).toEqual([]);
  });

  it("replaces a project route across registrations while retaining its group and favorite", () => {
    const first = makeProject("same-project", "registration-1", "Before");
    const replacement = makeProject("same-project", "registration-2", "After");
    const current = makeSnapshot({
      threads: [],
      projects: [first],
      groups: [
        {
          id: "group-1",
          name: "Pinned group",
          revision: 1,
          createdAt: utcNow,
          updatedAt: utcNow,
        },
      ],
      memberships: [{ groupId: "group-1", project: first.key }],
      favorites: [{ target: { kind: "project", project: first.key }, order: 0 }],
    });

    const result = applyOverviewEvent(
      current,
      makePatch(2, {
        kind: "projects",
        upserts: [replacement],
        removals: [],
      }),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.value.revision).toBe(2);
    expect(result.value.projects).toEqual([replacement]);
    expect(result.value.projects[0].target).toEqual({
      registrationId: "registration-2",
      environmentId: "environment-1",
    });
    expect(result.value.groups).toBe(current.groups);
    expect(result.value.memberships).toBe(current.memberships);
    expect(result.value.memberships[0].project).toEqual(result.value.projects[0].key);
    expect(result.value.favorites).toBe(current.favorites);
    expect(result.value.favorites[0].target).toEqual({
      kind: "project",
      project: result.value.projects[0].key,
    });
    expect(result.value.threads).toBe(current.threads);
    expect(current.projects).toEqual([first]);

    const removal = applyOverviewEvent(
      result.value,
      makePatch(3, {
        kind: "projects",
        upserts: [],
        removals: [{ key: first.key, target: first.target }],
      }),
    );
    expect(removal.kind).toBe("applied");
    if (removal.kind !== "applied") return;
    expect(removal.value.projects).toEqual([]);
    expect(result.value.projects).toEqual([replacement]);
  });

  it("keeps equal local project IDs distinct across environments", () => {
    const first = makeProject("same-project", "registration-1", "First source", "environment-1");
    const second = makeProject("same-project", "registration-1", "Second source", "environment-2");
    const current = makeSnapshot({ threads: [], projects: [first, second] });

    const updatedSecond = { ...second, title: "Updated second source" };
    const update = applyOverviewEvent(
      current,
      makePatch(2, {
        kind: "projects",
        upserts: [updatedSecond],
        removals: [],
      }),
    );
    expect(update.kind).toBe("applied");
    if (update.kind !== "applied") return;
    expect(update.value.projects).toEqual([first, updatedSecond]);

    const result = applyOverviewEvent(
      update.value,
      makePatch(3, {
        kind: "projects",
        upserts: [],
        removals: [{ key: first.key, target: first.target }],
      }),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.value.projects).toEqual([updatedSecond]);
    expect(current.projects).toEqual([first, second]);
  });

  it.each(["duplicate upserts", "upsert/removal conflict"])(
    "rejects %s across registrations atomically for the same domain project",
    (conflict) => {
      const first = makeProject("same-project", "registration-1", "Before");
      const replacement = makeProject("same-project", "registration-2", "After");
      const current = makeSnapshot({ threads: [], projects: [first] });

      const result = applyOverviewEvent(
        current,
        makePatch(2, {
          kind: "projects",
          upserts: conflict === "duplicate upserts" ? [first, replacement] : [replacement],
          removals:
            conflict === "duplicate upserts" ? [] : [{ key: first.key, target: first.target }],
        }),
      );
      expect(result).toEqual({ kind: "reset-required", reason: "invalid-patch" });
      expect(current.revision).toBe(1);
      expect(current.projects).toEqual([first]);
    },
  );

  it("updates project summaries without mutating the previous snapshot", () => {
    const currentProject = makeProject("empty-project", "registration-1", "Before");
    const updatedProject = { ...currentProject, title: "After" };
    const current = makeSnapshot({ threads: [], projects: [currentProject] });

    const result = applyOverviewEvent(
      current,
      makePatch(2, {
        kind: "projects",
        upserts: [updatedProject],
        removals: [],
      }),
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.value.projects).toEqual([updatedProject]);
    expect(result.value.projects).not.toBe(current.projects);
    expect(current.projects).toEqual([currentProject]);
  });

  it("applies the complete 10,000-thread snapshot at the exact 8 MiB wire limit", () => {
    const base = makeSnapshot({
      threads: Array.from({ length: FACTORY_MAX_THREADS }, (_, index) =>
        makeThread(index === 0 ? "x" : `Thread ${index}`, `thread-${index}`),
      ),
    });
    const firstThread = base.threads[0]!;
    const titleLength =
      firstThread.title.length + FACTORY_MAX_SNAPSHOT_BYTES - encodedSnapshotBytes(base);
    const threads = base.threads.map((thread, index) =>
      index === 0 ? { ...thread, title: "x".repeat(titleLength) } : thread,
    );
    const snapshot = makeSnapshot({ threads });

    expect(snapshot.threads).toHaveLength(FACTORY_MAX_THREADS);
    expect(encodedSnapshotBytes(snapshot)).toBe(FACTORY_MAX_SNAPSHOT_BYTES);
    const result = applyOverviewEvent(undefined, decodeEvent({ type: "snapshot", snapshot }));

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.value.threads).toHaveLength(FACTORY_MAX_THREADS);
    expect(result.value.threads[0]?.title).toHaveLength(titleLength);
  });
});
