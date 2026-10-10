import {
  FactoryOverviewSnapshot as FactoryOverviewSnapshotSchema,
  FACTORY_MAX_THREADS,
  type FactoryOverviewSnapshot,
} from "@t3tools/contracts/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { selectOverviewRows, toggleOverviewSort } from "./overviewSelectors";

const timestamp = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-10-03T12:00:00Z");
const decodeSnapshot = Schema.decodeUnknownSync(FactoryOverviewSnapshotSchema);

interface ProjectThreadFixture {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadIds: ReadonlyArray<string>;
}

interface GroupProjectsFixture {
  readonly groupId: string;
  readonly projects: ReadonlyArray<Pick<ProjectThreadFixture, "environmentId" | "projectId">>;
}

function makeOverviewFixture(input: {
  readonly projectThreads: ReadonlyArray<ProjectThreadFixture>;
  readonly groupProjects?: ReadonlyArray<GroupProjectsFixture>;
}): FactoryOverviewSnapshot {
  const environments = [...new Set(input.projectThreads.map((project) => project.environmentId))];
  const groups = input.groupProjects ?? [];
  const projects = input.projectThreads.map(({ environmentId, projectId }) => ({
    key: { environmentId, projectId },
    target: { environmentId, registrationId: `registration-${environmentId}` },
    title: `Project ${environmentId}/${projectId}`,
    workspaceRoot: `/work/${environmentId}/${projectId}`,
    createdAt: timestamp.toString(),
    updatedAt: timestamp.toString(),
  }));
  const threads = input.projectThreads.flatMap(({ environmentId, projectId, threadIds }) =>
    threadIds.map((threadId) => ({
      key: { environmentId, threadId },
      target: { environmentId, registrationId: `registration-${environmentId}` },
      project: { environmentId, projectId },
      title: `Thread ${environmentId}/${threadId}`,
      sourceStatus: "running" as const,
      classification: "active" as const,
      providerInstanceId: `provider-${environmentId}`,
      model: "test-model",
      branch: null,
      worktreePath: null,
      settled: false,
      settledAt: null,
      settledOverride: null,
      providerCompletedAt: null,
      finalizedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  );

  return decodeSnapshot({
    generation: "generation-1",
    revision: 1,
    environments: environments.map((environmentId) => ({
      registrationId: `registration-${environmentId}`,
      environmentId,
      endpoint: `http://${environmentId}.test`,
      label: `Source ${environmentId}`,
      platform: null,
      enabled: true,
      state: "online",
      credentialStorage: null,
      credentialExpiresAt: null,
      renewal: "unsupported",
      lastSeenAt: timestamp,
      revision: 1,
    })),
    sourceFreshness: environments.map((environmentId) => ({
      target: { registrationId: `registration-${environmentId}`, environmentId },
      state: "fresh",
      reason: null,
      updatedAt: timestamp,
      retryAt: null,
    })),
    threads,
    projects,
    groups: groups.map(({ groupId }) => ({
      id: groupId,
      name: groupId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    memberships: groups.flatMap(({ groupId, projects: members }) =>
      members.map((project) => ({ groupId, project })),
    ),
    favorites: [],
  });
}

describe("selectOverviewRows", () => {
  it("groups complete projects across environments and counts all versus filtered sessions", () => {
    const snapshot = makeOverviewFixture({
      projectThreads: [
        { environmentId: "a", projectId: "p1", threadIds: ["a1"] },
        { environmentId: "b", projectId: "p2", threadIds: ["b1"] },
        { environmentId: "a", projectId: "p3", threadIds: ["excluded"] },
      ],
      groupProjects: [
        {
          groupId: "payments",
          projects: [
            { environmentId: "a", projectId: "p1" },
            { environmentId: "b", projectId: "p2" },
          ],
        },
      ],
    });

    const view = selectOverviewRows(snapshot, {
      groupId: "payments",
      state: "all",
      search: "",
      environment: "all",
    });

    expect(
      view.rows.flatMap((row) => row.sessions.map((session) => session.target.threadId)),
    ).toEqual(["a1", "b1"]);
    expect(view.totalCount).toBe(3);
    expect(view.filteredCount).toBe(2);
  });

  it("keeps empty projects and same local IDs distinct across environments", () => {
    const snapshot = makeOverviewFixture({
      projectThreads: [
        { environmentId: "a", projectId: "same", threadIds: ["same-thread"] },
        { environmentId: "b", projectId: "same", threadIds: ["same-thread"] },
        { environmentId: "a", projectId: "empty", threadIds: [] },
        { environmentId: "b", projectId: "empty-grouped", threadIds: [] },
      ],
      groupProjects: [
        {
          groupId: "shared",
          projects: [
            { environmentId: "a", projectId: "same" },
            { environmentId: "b", projectId: "same" },
            { environmentId: "b", projectId: "empty-grouped" },
          ],
        },
      ],
    });

    const all = selectOverviewRows(snapshot, {
      groupId: "all",
      state: "all",
      search: "",
      environment: "all",
    });
    const grouped = all.rows.find((row) => row.kind === "group" && row.id === "shared");
    const emptyProject = all.rows.find(
      (row) => row.kind === "project" && row.project.key.projectId === "empty",
    );

    expect(grouped?.sessions.map((session) => session.target.environmentId)).toEqual(["a", "b"]);
    expect(
      grouped?.kind === "group" &&
        grouped.projects.some((project) => project.key.projectId === "empty-grouped"),
    ).toBe(true);
    expect(
      grouped?.kind === "group"
        ? grouped.sessions.filter((session) => session.project.key.projectId === "empty-grouped")
        : [],
    ).toEqual([]);
    expect(emptyProject?.sessions).toEqual([]);
    expect(all.totalCount).toBe(2);
    expect(all.filteredCount).toBe(2);
  });

  it("sorts all loaded summaries locally with stable composite ties and intact project membership", () => {
    const base = makeOverviewFixture({
      projectThreads: [
        { environmentId: "b", projectId: "same", threadIds: ["z", "a"] },
        { environmentId: "a", projectId: "same", threadIds: ["z", "a"] },
        { environmentId: "a", projectId: "empty", threadIds: [] },
      ],
      groupProjects: [
        {
          groupId: "group",
          projects: [
            { environmentId: "b", projectId: "same" },
            { environmentId: "a", projectId: "same" },
          ],
        },
      ],
    });
    const snapshot = {
      ...base,
      threads: base.threads.map((thread) => ({ ...thread, title: thread.key.threadId })),
    };
    const filters = { groupId: "all", state: "all", search: "", environment: "all" } as const;
    const asc = selectOverviewRows(snapshot, filters, { column: "name", direction: "asc" });
    const desc = selectOverviewRows(snapshot, filters, { column: "name", direction: "desc" });
    const group = (selection: typeof asc) => selection.rows.find((row) => row.kind === "group")!;
    expect(
      group(asc).sessions.map((session) => [
        session.project.key.environmentId,
        session.target.threadId,
      ]),
    ).toEqual([
      ["a", "a"],
      ["a", "z"],
      ["b", "a"],
      ["b", "z"],
    ]);
    expect(
      group(desc).sessions.map((session) => [
        session.project.key.environmentId,
        session.target.threadId,
      ]),
    ).toEqual([
      ["b", "z"],
      ["b", "a"],
      ["a", "z"],
      ["a", "a"],
    ]);
    expect(asc.rows.some((row) => row.kind === "project" && row.sessions.length === 0)).toBe(true);
    expect(asc.filteredCount).toBe(4);
    expect(desc.stateCounts).toEqual(asc.stateCounts);
    expect(snapshot.threads.map((thread) => thread.key.threadId)).toEqual(["z", "a", "z", "a"]);
    const tied = {
      ...snapshot,
      projects: snapshot.projects.map((project) => ({ ...project, title: "Equal" })),
      threads: snapshot.threads.map((thread) => ({ ...thread, title: "Equal" })),
    };
    for (const direction of ["asc", "desc"] as const) {
      const rows = selectOverviewRows(tied, filters, { column: "name", direction });
      expect(
        group(rows).sessions.map((session) => [
          session.project.key.environmentId,
          session.target.threadId,
        ]),
      ).toEqual([
        ["a", "a"],
        ["a", "z"],
        ["b", "a"],
        ["b", "z"],
      ]);
    }
  });

  it.each(["name", "state", "source", "updated"] as const)(
    "sorts %s ascending/descending without changing filter counts or composite tie order",
    (column) => {
      const base = makeOverviewFixture({
        projectThreads: [
          { environmentId: "b", projectId: "same", threadIds: ["z", "a"] },
          { environmentId: "a", projectId: "same", threadIds: ["z", "a"] },
        ],
      });
      const snapshot = decodeSnapshot({
        ...base,
        projects: base.projects.map((project) => ({ ...project, title: "Equal project" })),
        environments: base.environments.map((source) => ({
          ...source,
          label: source.environmentId === "a" ? "Zulu" : "Alpha",
        })),
        threads: base.threads.map((thread) => ({
          ...thread,
          title: thread.key.threadId === "a" ? "Alpha" : "Zulu",
          classification: thread.key.threadId === "a" ? "active" : "waiting",
          updatedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
            thread.key.threadId === "a" ? "2026-10-03T12:00:00Z" : "2026-10-03T13:00:00Z",
          ),
        })),
      });
      const filters = { groupId: "all", state: "all", search: "", environment: "all" } as const;
      const asc = { column, direction: "asc" } as const;
      const ascending = selectOverviewRows(snapshot, filters, asc);
      const descending = selectOverviewRows(snapshot, filters, toggleOverviewSort(asc, column));
      const expectedAsc = column === "source" ? ["b", "a"] : ["a", "b"];
      const expectedDesc = column === "source" ? ["a", "b"] : ["a", "b"];
      expect(
        ascending.rows.map((row) => (row.kind === "project" ? row.project.key.environmentId : "")),
      ).toEqual(expectedAsc);
      expect(
        descending.rows.map((row) => (row.kind === "project" ? row.project.key.environmentId : "")),
      ).toEqual(expectedDesc);
      expect(ascending.rows[0].sessions.map((session) => session.target.threadId)).toEqual([
        "a",
        "z",
      ]);
      expect(descending.rows[0].sessions.map((session) => session.target.threadId)).toEqual(
        column === "source" ? ["a", "z"] : ["z", "a"],
      );
      expect(descending.filteredCount).toBe(4);
      expect(descending.stateCounts).toEqual(ascending.stateCounts);
      const filtered = selectOverviewRows(
        snapshot,
        { ...filters, state: "active" },
        toggleOverviewSort(asc, column),
      );
      expect(filtered.filteredCount).toBe(2);
      expect(
        filtered.rows.every((row) =>
          row.sessions.every((session) => session.thread.classification === "active"),
        ),
      ).toBe(true);
    },
  );

  it("selects every session at the 10,000-thread overview limit", () => {
    const snapshot = makeOverviewFixture({
      projectThreads: [
        {
          environmentId: "source",
          projectId: "large-project",
          threadIds: Array.from({ length: FACTORY_MAX_THREADS }, (_, index) => `thread-${index}`),
        },
      ],
    });

    const selection = selectOverviewRows(snapshot, {
      groupId: "all",
      state: "all",
      search: "",
      environment: "all",
    });

    expect(snapshot.threads).toHaveLength(FACTORY_MAX_THREADS);
    expect(selection.totalCount).toBe(FACTORY_MAX_THREADS);
    expect(selection.filteredCount).toBe(FACTORY_MAX_THREADS);
    expect(selection.rows).toHaveLength(1);
    expect(selection.rows[0]?.sessions).toHaveLength(FACTORY_MAX_THREADS);
  });
});
