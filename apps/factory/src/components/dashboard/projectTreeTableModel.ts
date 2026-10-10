import {
  createExpandedRowModel,
  rowExpandingFeature,
  tableFeatures,
  type ExpandedState,
  type Row,
  type Updater,
} from "@tanstack/react-table";
import type {
  OverviewGroupRow,
  OverviewProjectRow,
  OverviewRow,
  OverviewSessionRow,
} from "../../factory/overviewSelectors";
import { targetKey } from "../../factory/queryKeys";

export type SessionTreeRow = OverviewSessionRow & {
  readonly kind: "session";
  readonly id: string;
  readonly parentId: string;
};
export type ProjectTreeRow = Omit<OverviewProjectRow, "sessions"> & {
  readonly sessions: ReadonlyArray<SessionTreeRow>;
};
export type GroupTreeRow = Omit<OverviewGroupRow, "sessions"> & {
  readonly sessions: ReadonlyArray<SessionTreeRow>;
};
export type DashboardTreeRow = ProjectTreeRow | GroupTreeRow | SessionTreeRow;

export const projectTreeFeatures = tableFeatures({
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
});

export function projectTreeRowId(row: Pick<DashboardTreeRow, "kind" | "id">): string {
  return row.kind === "session" ? row.id : `${row.kind}:${row.id}`;
}

export function createProjectTreeData(
  rows: ReadonlyArray<OverviewRow>,
): ReadonlyArray<ProjectTreeRow | GroupTreeRow> {
  return rows.map((row): ProjectTreeRow | GroupTreeRow => ({
    ...row,
    sessions: row.sessions.map((session): SessionTreeRow => ({
      ...session,
      kind: "session",
      parentId: projectTreeRowId(row),
      id: targetKey(session.target),
    })),
  }));
}

export function projectTreeTableOptions(
  data: ReadonlyArray<ProjectTreeRow | GroupTreeRow>,
  expandedRowIds: ReadonlyArray<string>,
  setExpandedRows: (ids: string[]) => void,
) {
  const expanded = Object.fromEntries(expandedRowIds.map((id) => [id, true]));
  return {
    features: projectTreeFeatures,
    data,
    getSubRows: (row: DashboardTreeRow) => (row.kind === "session" ? undefined : row.sessions),
    getRowId: projectTreeRowId,
    state: { expanded },
    onExpandedChange: (updater: Updater<ExpandedState>) => {
      const current = expanded;
      const next = typeof updater === "function" ? updater(current) : updater;
      if (next === true) {
        setExpandedRows(data.map(projectTreeRowId));
        return;
      }
      const rowIds = data.flatMap((row) => {
        const id = projectTreeRowId(row);
        return next[id] ? [id] : [];
      });
      setExpandedRows(rowIds);
    },
  };
}

export function handleProjectTreeRowKey(
  key: string,
  row: Row<typeof projectTreeFeatures, DashboardTreeRow>,
  expandedRowIds: ReadonlyArray<string>,
  toggleExpandRow: (id: string) => void,
  openSession: (session: SessionTreeRow, mode: "split") => void,
): boolean {
  if (key === "Enter") {
    if (row.original.kind !== "session") row.toggleExpanded();
    else openSession(row.original, "split");
    return true;
  }
  if (key === "ArrowRight" && row.getCanExpand() && !row.getIsExpanded()) {
    row.toggleExpanded(true);
    return true;
  } else if (key === "ArrowLeft") {
    if (row.getCanExpand() && row.getIsExpanded()) {
      row.toggleExpanded(false);
      return true;
    } else if (row.original.kind === "session" && expandedRowIds.includes(row.original.parentId)) {
      toggleExpandRow(row.original.parentId);
      return true;
    }
  }
  return false;
}
