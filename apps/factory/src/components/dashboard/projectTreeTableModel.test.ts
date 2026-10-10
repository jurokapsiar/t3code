import { FactoryOverviewSnapshot } from "@t3tools/contracts/factory";
import { constructTable, createColumnHelper, tableFeatures } from "@tanstack/react-table";
import { storeReactivityBindings } from "@tanstack/table-core/store-reactivity-bindings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { selectOverviewRows } from "../../factory/overviewSelectors";
import {
  createProjectTreeData,
  handleProjectTreeRowKey,
  projectTreeFeatures,
  projectTreeRowId,
  projectTreeTableOptions,
  type DashboardTreeRow,
} from "./projectTreeTableModel";

const time = "2026-10-03T12:00:00Z";
const dateTime = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(time);
const projects = ["a", "b", "c"].map((environmentId) => ({
  key: { environmentId, projectId: "same" },
  target: { environmentId, registrationId: `registration-${environmentId}` },
  title: `Project ${environmentId}`,
  workspaceRoot: `/work/${environmentId}`,
  createdAt: time,
  updatedAt: time,
}));
const snapshot = Schema.decodeUnknownSync(FactoryOverviewSnapshot)({
  generation: "generation",
  revision: 1,
  environments: [],
  sourceFreshness: [],
  favorites: [],
  projects,
  threads: projects.map((project) => ({
    key: { environmentId: project.key.environmentId, threadId: "same-thread" },
    target: project.target,
    project: project.key,
    title: "Session",
    sourceStatus: "running",
    classification: "active",
    providerInstanceId: "provider",
    model: "test",
    branch: null,
    worktreePath: null,
    settled: false,
    settledAt: null,
    settledOverride: null,
    providerCompletedAt: null,
    finalizedAt: null,
    createdAt: dateTime,
    updatedAt: dateTime,
  })),
  // The raw group ID deliberately collides with a composite project ID.
  groups: [
    { id: '["a","same"]', name: "Group", revision: 1, createdAt: dateTime, updatedAt: dateTime },
  ],
  memberships: [{ groupId: '["a","same"]', project: projects[2].key }],
});
const data = createProjectTreeData(
  selectOverviewRows(snapshot, {
    groupId: "all",
    environment: "all",
    state: "all",
    search: "",
  }).rows,
);
const columns = createColumnHelper<typeof projectTreeFeatures, DashboardTreeRow>().columns([]);

function makeTable(initialIds: string[] = []) {
  let expandedRowIds = initialIds;
  const features = tableFeatures({
    ...projectTreeFeatures,
    coreReactivityFeature: storeReactivityBindings(),
  });
  const table = constructTable({
    ...projectTreeTableOptions(data, expandedRowIds, setExpandedRows),
    features,
    columns,
  });
  function setExpandedRows(ids: string[]) {
    expandedRowIds = ids;
    table.setOptions((previous) => ({
      ...previous,
      ...projectTreeTableOptions(data, ids, setExpandedRows),
      features,
    }));
  }
  function pressKey(key: string, row: ReturnType<typeof table.getRow>) {
    return handleProjectTreeRowKey(
      key,
      row,
      expandedRowIds,
      (id) => {
        setExpandedRows(
          expandedRowIds.includes(id)
            ? expandedRowIds.filter((value) => value !== id)
            : [...expandedRowIds, id],
        );
      },
      () => {
        throw new Error("Expansion must not open a session");
      },
    );
  }
  return {
    table,
    setExpandedRows,
    pressKey,
    expandedIds: () => expandedRowIds,
    visibleSessions: () =>
      table
        .getRowModel()
        .rows.flatMap((row) => (row.original.kind === "session" ? [row.original.target] : [])),
  };
}

const groupId = 'group:["a","same"]';
const projectAId = 'project:["a","same"]';
const projectBId = 'project:["b","same"]';
const rootIds = [groupId, projectAId, projectBId];

describe("project tree controlled v9 expansion", () => {
  it.each([
    { id: groupId, environmentId: "c" },
    { id: projectAId, environmentId: "a" },
    { id: projectBId, environmentId: "b" },
  ])("shows and removes nested sessions when $id is toggled", ({ id, environmentId }) => {
    const view = makeTable();
    const row = view.table.getRowModel().rows.find((row) => projectTreeRowId(row.original) === id)!;
    expect(view.visibleSessions()).toEqual([]);
    row.toggleExpanded();
    expect(view.visibleSessions()).toEqual([{ environmentId, threadId: "same-thread" }]);
    expect(row.getIsExpanded()).toBe(true);
    expect(view.expandedIds()).toEqual([id]);
    const child = view.table.getRowModel().rows.find((row) => row.original.kind === "session")!;
    expect(child.depth).toBe(1);
    expect(child.getParentRow()?.id).toBe(id);
    row.toggleExpanded();
    expect(view.visibleSessions()).toEqual([]);
    expect(row.getIsExpanded()).toBe(false);
    expect(view.expandedIds()).toEqual([]);
  });

  it.each([groupId, projectAId, projectBId])(
    "keeps keyboard and presentation state consistent for %s",
    (id) => {
      const view = makeTable();
      const row = view.table
        .getRowModel()
        .rows.find((row) => projectTreeRowId(row.original) === id)!;
      expect(view.pressKey("ArrowRight", row)).toBe(true);
      expect(view.visibleSessions()).toHaveLength(1);
      expect(view.pressKey("ArrowRight", row)).toBe(false);
      const child = view.table.getRowModel().rows.find((row) => row.original.kind === "session")!;
      expect(view.pressKey("ArrowLeft", child)).toBe(true);
      expect(view.visibleSessions()).toEqual([]);
      expect(view.expandedIds()).toEqual([]);
      expect(view.pressKey("Enter", row)).toBe(true);
      expect(view.visibleSessions()).toHaveLength(1);
      expect(view.pressKey("ArrowLeft", row)).toBe(true);
      expect(view.visibleSessions()).toEqual([]);
      expect(view.pressKey("ArrowLeft", row)).toBe(false);
      view.pressKey("Enter", row);
      view.pressKey("Enter", row);
      expect(view.visibleSessions()).toEqual([]);
    },
  );

  it("restores Expand all IDs without collisions and collapses only the selected parent", () => {
    const view = makeTable();
    view.setExpandedRows(data.map(projectTreeRowId));
    expect(view.visibleSessions()).toEqual([
      { environmentId: "c", threadId: "same-thread" },
      { environmentId: "a", threadId: "same-thread" },
      { environmentId: "b", threadId: "same-thread" },
    ]);
    expect(view.table.getRowModel().rows.map((row) => row.id)).toEqual([
      groupId,
      '["c","same-thread"]',
      projectAId,
      '["a","same-thread"]',
      projectBId,
      '["b","same-thread"]',
    ]);
    expect(view.expandedIds()).toEqual(rootIds);
    const restored = makeTable(JSON.parse(JSON.stringify(view.expandedIds())));
    expect(restored.visibleSessions()).toEqual(view.visibleSessions());
    const sessionA = restored.table
      .getRowModel()
      .rows.find(
        (row) => row.original.kind === "session" && row.original.target.environmentId === "a",
      )!;
    restored.pressKey("ArrowLeft", sessionA);
    expect(restored.visibleSessions()).toEqual([
      { environmentId: "c", threadId: "same-thread" },
      { environmentId: "b", threadId: "same-thread" },
    ]);
    expect(restored.expandedIds()).toEqual([groupId, projectBId]);
    restored.setExpandedRows([]);
    expect(restored.visibleSessions()).toEqual([]);
    expect(restored.table.getRowModel().rows.map((row) => row.id)).toEqual(rootIds);
    restored.table.toggleAllRowsExpanded(true);
    expect(restored.visibleSessions()).toHaveLength(3);
    expect(restored.expandedIds()).toEqual(rootIds);
    restored.table.toggleAllRowsExpanded(false);
    expect(restored.visibleSessions()).toEqual([]);
    expect(restored.expandedIds()).toEqual([]);
  });
});
