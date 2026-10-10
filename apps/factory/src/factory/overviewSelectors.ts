import type {
  FactoryGroup,
  FactoryOverviewSnapshot,
  FactoryProjectSummary,
  FactorySourceFreshness,
  FactoryThreadClassification,
  FactoryThreadKey,
  FactoryThreadSummary,
} from "@t3tools/contracts/factory";
import * as DateTime from "effect/DateTime";
import { targetKey } from "./queryKeys";

export type OverviewSortColumn = "name" | "state" | "source" | "updated";
export interface OverviewSort {
  readonly column: OverviewSortColumn;
  readonly direction: "asc" | "desc";
}

export function toggleOverviewSort(
  current: OverviewSort,
  column: OverviewSortColumn,
): OverviewSort {
  return {
    column,
    direction: current.column === column && current.direction === "asc" ? "desc" : "asc",
  };
}

export type OverviewStateFilter = FactoryThreadClassification | "all";

export interface OverviewFilters {
  readonly groupId: string | "all";
  readonly state: OverviewStateFilter;
  readonly search: string;
  readonly environment: string | "all";
}

export interface OverviewSessionRow {
  readonly target: FactoryThreadKey;
  readonly thread: FactoryThreadSummary;
  readonly project: FactoryProjectSummary;
  readonly sourceFreshness: FactorySourceFreshness | undefined;
}

export interface OverviewProjectRow {
  readonly kind: "project";
  readonly id: string;
  readonly project: FactoryProjectSummary;
  readonly sessions: ReadonlyArray<OverviewSessionRow>;
}

export interface OverviewGroupRow {
  readonly kind: "group";
  readonly id: string;
  readonly group: FactoryGroup;
  readonly projects: ReadonlyArray<FactoryProjectSummary>;
  readonly sessions: ReadonlyArray<OverviewSessionRow>;
}

export type OverviewRow = OverviewProjectRow | OverviewGroupRow;
export type OverviewStateCounts = Readonly<Record<OverviewStateFilter, number>>;

export interface OverviewRowsSelection {
  readonly rows: ReadonlyArray<OverviewRow>;
  readonly totalCount: number;
  readonly filteredCount: number;
  readonly stateCounts: OverviewStateCounts;
}

export function overviewProjectKey(project: Pick<FactoryProjectSummary, "key">): string {
  return JSON.stringify([project.key.environmentId, project.key.projectId]);
}

function matchesState(thread: FactoryThreadSummary, state: OverviewStateFilter): boolean {
  if (state === "all") return true;
  if (state === "settled")
    return thread.classification === "settled" || thread.classification === "finished";
  return thread.classification === state;
}

function contains(value: string | null, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

function projectMatches(project: FactoryProjectSummary, query: string): boolean {
  return contains(project.title, query) || contains(project.workspaceRoot, query);
}

function threadMatches(thread: FactoryThreadSummary, query: string): boolean {
  return (
    contains(thread.title, query) ||
    contains(thread.key.threadId, query) ||
    contains(thread.model, query) ||
    contains(thread.branch, query) ||
    contains(thread.worktreePath, query)
  );
}

function emptyStateCounts(): Record<OverviewStateFilter, number> {
  return {
    all: 0,
    active: 0,
    waiting: 0,
    failed: 0,
    settled: 0,
    finished: 0,
    cancelled: 0,
    idle: 0,
    unknown: 0,
  };
}

export function selectOverviewRows(
  snapshot: FactoryOverviewSnapshot,
  filters: OverviewFilters,
  sort: OverviewSort = { column: "name", direction: "asc" },
): OverviewRowsSelection {
  const query = filters.search.trim().toLocaleLowerCase();
  const compare = (
    a: string | number,
    b: string | number,
    identityA: string,
    identityB: string,
  ) => {
    const order =
      typeof a === "string" && typeof b === "string"
        ? a.localeCompare(b, undefined, { numeric: true })
        : a < b
          ? -1
          : a > b
            ? 1
            : 0;
    return (
      order * (sort.direction === "asc" ? 1 : -1) ||
      (identityA < identityB ? -1 : identityA > identityB ? 1 : 0)
    );
  };
  const sourceLabels = new Map<string, string>(
    snapshot.environments.map((source) => [source.environmentId, source.label]),
  );
  const sourceStates = new Map(
    snapshot.sourceFreshness.map((source) => [
      JSON.stringify([source.target.registrationId, source.target.environmentId]),
      source.state,
    ]),
  );
  const sourceLabel = (environmentId: string) => sourceLabels.get(environmentId) ?? environmentId;
  const projectValue = (project: FactoryProjectSummary): string | number => {
    switch (sort.column) {
      case "name":
        return project.title;
      case "state":
        return (
          sourceStates.get(
            JSON.stringify([project.target.registrationId, project.key.environmentId]),
          ) ?? "unavailable"
        );
      case "source":
        return sourceLabel(project.key.environmentId);
      case "updated":
        return Date.parse(project.updatedAt);
    }
  };
  const compareProjects = (a: FactoryProjectSummary, b: FactoryProjectSummary) =>
    compare(projectValue(a), projectValue(b), overviewProjectKey(a), overviewProjectKey(b));
  const threadValue = (thread: FactoryThreadSummary): string | number => {
    switch (sort.column) {
      case "name":
        return thread.title;
      case "state":
        return thread.classification;
      case "source":
        return sourceLabel(thread.key.environmentId);
      case "updated":
        return DateTime.toEpochMillis(thread.updatedAt);
    }
  };
  const projects = snapshot.projects
    .filter(
      (project) =>
        filters.environment === "all" || project.key.environmentId === filters.environment,
    )
    .sort(compareProjects);
  const projectsByKey = new Map(projects.map((project) => [overviewProjectKey(project), project]));
  const membershipsByGroup = new Map<string, Set<string>>();
  const groupByProject = new Map<string, string>();
  for (const membership of snapshot.memberships) {
    const key = JSON.stringify([membership.project.environmentId, membership.project.projectId]);
    const members = membershipsByGroup.get(membership.groupId) ?? new Set<string>();
    members.add(key);
    membershipsByGroup.set(membership.groupId, members);
    groupByProject.set(key, membership.groupId);
  }

  const threadsByProject = new Map<string, FactoryThreadSummary[]>();
  for (const thread of snapshot.threads) {
    const key = JSON.stringify([thread.project.environmentId, thread.project.projectId]);
    const threads = threadsByProject.get(key) ?? [];
    threads.push(thread);
    threadsByProject.set(key, threads);
  }
  for (const threads of threadsByProject.values())
    threads.sort((a, b) =>
      compare(
        threadValue(a),
        threadValue(b),
        JSON.stringify([a.key.environmentId, a.project.projectId, a.key.threadId]),
        JSON.stringify([b.key.environmentId, b.project.projectId, b.key.threadId]),
      ),
    );
  const freshnessBySource = new Map(
    snapshot.sourceFreshness.map((source) => [
      JSON.stringify([source.target.registrationId, source.target.environmentId]),
      source,
    ]),
  );
  const rows: OverviewRow[] = [];
  const sessionRowsFor = (project: FactoryProjectSummary, groupMatchesSearch = false) => {
    const key = overviewProjectKey(project);
    const freshness = freshnessBySource.get(
      JSON.stringify([project.target.registrationId, project.key.environmentId]),
    );
    return (threadsByProject.get(key) ?? []).flatMap((thread) => {
      if (!matchesState(thread, filters.state)) return [];
      if (
        query &&
        !groupMatchesSearch &&
        !projectMatches(project, query) &&
        !threadMatches(thread, query)
      )
        return [];
      return [{ target: thread.key, thread, project, sourceFreshness: freshness }];
    });
  };

  const groups =
    filters.groupId === "all"
      ? snapshot.groups
      : snapshot.groups.filter((group) => group.id === filters.groupId);
  for (const group of groups) {
    const memberKeys = membershipsByGroup.get(group.id) ?? new Set<string>();
    const memberProjects = [...memberKeys]
      .map((key) => projectsByKey.get(key))
      .filter((project): project is FactoryProjectSummary => project !== undefined)
      .sort(compareProjects);
    const groupMatchesSearch = query.length > 0 && contains(group.name, query);
    const sessions = memberProjects.flatMap((project) =>
      sessionRowsFor(project, groupMatchesSearch),
    );
    const hasProjectSearchMatch = memberProjects.some((project) => projectMatches(project, query));
    if (query && !groupMatchesSearch && !hasProjectSearchMatch && sessions.length === 0) continue;
    if (filters.state !== "all" && sessions.length === 0) continue;
    rows.push({ kind: "group", id: group.id, group, projects: memberProjects, sessions });
  }

  if (filters.groupId === "all") {
    for (const project of projects) {
      if (groupByProject.has(overviewProjectKey(project))) continue;
      if (
        query &&
        !projectMatches(project, query) &&
        !(threadsByProject.get(overviewProjectKey(project)) ?? []).some(
          (thread) => threadMatches(thread, query) && matchesState(thread, filters.state),
        )
      )
        continue;
      const sessions = sessionRowsFor(project);
      if (filters.state !== "all" && sessions.length === 0) continue;
      rows.push({
        kind: "project",
        id: overviewProjectKey(project),
        project,
        sessions,
      });
    }
  }

  const stateCounts = emptyStateCounts();
  const scopedProjectKeys =
    filters.groupId === "all"
      ? new Set(projects.map(overviewProjectKey))
      : (membershipsByGroup.get(filters.groupId) ?? new Set<string>());
  for (const thread of snapshot.threads) {
    const key = JSON.stringify([thread.project.environmentId, thread.project.projectId]);
    if (!scopedProjectKeys.has(key)) continue;
    if (filters.environment !== "all" && thread.project.environmentId !== filters.environment)
      continue;
    stateCounts.all += 1;
    stateCounts[thread.classification] += 1;
    if (thread.classification === "finished") stateCounts.settled += 1;
  }

  return {
    rows: rows.sort((a, b) => {
      const value = (row: OverviewRow) =>
        row.kind === "project"
          ? projectValue(row.project)
          : sort.column === "updated"
            ? DateTime.toEpochMillis(row.group.updatedAt)
            : row.group.name;
      return compare(value(a), value(b), `${a.kind}:${a.id}`, `${b.kind}:${b.id}`);
    }),
    totalCount: snapshot.threads.length,
    filteredCount: rows.reduce((count, row) => count + row.sessions.length, 0),
    stateCounts,
  };
}
