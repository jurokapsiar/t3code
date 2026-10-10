import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  FactoryFavoriteTarget,
  FactoryGroup,
  FactoryOverviewSnapshot,
} from "@t3tools/contracts/factory";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import {
  ChevronUp,
  ChevronsUpDown,
  FolderGit2,
  Layers,
  ListFilter,
  MoreHorizontal,
  Plus,
  Search,
  Star,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  MenuButton,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Toolbar,
  ToolbarButton,
  Tooltip,
  TreeToggle,
} from "../../design-system/actions";
import {
  Menu,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  SearchBox,
  MessageBar,
} from "../../design-system/forms";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import {
  selectOverviewRows,
  toggleOverviewSort,
  type OverviewSort,
  type OverviewSortColumn,
  type OverviewStateFilter,
} from "../../factory/overviewSelectors";
import { formatTimestamp } from "../../factory/formatTimestamp";
import { targetKey } from "../../factory/queryKeys";
import { useT3Store } from "../../store/useT3Store";
import { getSessionStatePresentation } from "./sessionState";
import { ProjectGroupModal } from "../modals/ProjectGroupModal";
import {
  createProjectTreeData,
  handleProjectTreeRowKey,
  projectTreeFeatures,
  projectTreeRowId,
  projectTreeTableOptions,
  type DashboardTreeRow,
  type GroupTreeRow,
  type ProjectTreeRow,
  type SessionTreeRow,
} from "./projectTreeTableModel";
import styles from "./ProjectTreeTable.module.css";

interface ProjectTreeTableProps {
  readonly snapshot: FactoryOverviewSnapshot;
  readonly connection: FactoryConnectionApi;
}

const columnHelper = createColumnHelper<typeof projectTreeFeatures, DashboardTreeRow>();
const sortColumns: Readonly<Record<string, OverviewSortColumn>> = {
  subject: "name",
  status: "state",
  source: "source",
  updated: "updated",
};
const stateFilters: ReadonlyArray<{ value: OverviewStateFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "waiting", label: "Waiting" },
  { value: "failed", label: "Failed" },
  { value: "settled", label: "Settled" },
  { value: "finished", label: "Finished" },
  { value: "cancelled", label: "Cancelled" },
  { value: "idle", label: "Idle" },
  { value: "unknown", label: "Unknown" },
];

function favoriteTarget(row: ProjectTreeRow | GroupTreeRow): FactoryFavoriteTarget {
  return row.kind === "group"
    ? { kind: "group", groupId: row.group.id }
    : { kind: "project", project: row.project.key };
}

function targetIsFavorite(
  snapshot: FactoryOverviewSnapshot,
  target: FactoryFavoriteTarget,
): boolean {
  const key = JSON.stringify(target);
  return snapshot.favorites.some((favorite) => JSON.stringify(favorite.target) === key);
}

function freshnessColor(state: string | undefined): "success" | "warning" | "neutral" | "danger" {
  if (state === "fresh") return "success";
  if (state === "synchronizing" || state === "stale") return "warning";
  if (state === "blocked") return "danger";
  return "neutral";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectTreeTable({ snapshot, connection }: ProjectTreeTableProps) {
  const environmentFilter = useT3Store((state) => state.activeEnvironmentFilter);
  const stateFilter = useT3Store((state) => state.stateFilter);
  const setStateFilter = useT3Store((state) => state.setStateFilter);
  const groupFilter = useT3Store((state) => state.groupFilter);
  const setGroupFilter = useT3Store((state) => state.setGroupFilter);
  const searchQuery = useT3Store((state) => state.searchQuery);
  const setSearchQuery = useT3Store((state) => state.setSearchQuery);
  const expandedRowIds = useT3Store((state) => state.expandedRowIds);
  const toggleExpandRow = useT3Store((state) => state.toggleExpandRow);
  const setExpandedRows = useT3Store((state) => state.setExpandedRows);
  const selectedTarget = useT3Store((state) => state.selectedTarget);
  const setSelectedTarget = useT3Store((state) => state.setSelectedTarget);
  const [sort, setSort] = useState<OverviewSort>({ column: "name", direction: "asc" });
  const [searchOpen, setSearchOpen] = useState(() => searchQuery.trim().length > 0);
  const [editingGroup, setEditingGroup] = useState<FactoryGroup>();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [pendingFavorite, setPendingFavorite] = useState<string>();
  const [error, setError] = useState<string>();
  const searchPaneRef = useRef<HTMLDivElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);

  const selection = useMemo(
    () =>
      selectOverviewRows(
        snapshot,
        {
          groupId: groupFilter,
          state: stateFilter,
          search: searchQuery,
          environment: environmentFilter,
        },
        sort,
      ),
    [snapshot, groupFilter, stateFilter, searchQuery, environmentFilter, sort],
  );
  const tableData = useMemo(() => createProjectTreeData(selection.rows), [selection.rows]);
  const environmentsById = useMemo(
    () =>
      new Map(snapshot.environments.map((environment) => [environment.environmentId, environment])),
    [snapshot.environments],
  );
  const freshnessByEnvironment = useMemo(
    () => new Map(snapshot.sourceFreshness.map((source) => [source.target.environmentId, source])),
    [snapshot.sourceFreshness],
  );

  const changeFavorite = async (row: ProjectTreeRow | GroupTreeRow) => {
    const target = favoriteTarget(row);
    const identity = JSON.stringify(target);
    setPendingFavorite(identity);
    setError(undefined);
    try {
      await connection.request((client) =>
        client["factory.favorites.set"]({
          target,
          favorite: !targetIsFavorite(snapshot, target),
        }),
      );
    } catch (cause) {
      setError(`The factory could not update this favorite. ${errorText(cause)}`);
    } finally {
      setPendingFavorite(undefined);
    }
  };

  const openSession = (session: SessionTreeRow, mode: "split" | "fullscreen") => {
    setSelectedTarget(session.target, mode);
  };

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "subject",
          header: "Project / session",
          cell: ({ row }) => {
            const item = row.original;
            if (item.kind === "session") {
              const source = environmentsById.get(item.target.environmentId);
              return (
                <div className={styles.sessionSubject}>
                  <Tooltip content={item.thread.title} relationship="description">
                    <span className={styles.sessionTitle}>{item.thread.title}</span>
                  </Tooltip>
                  <Tooltip
                    content={`${source?.label ?? item.target.environmentId} · ${item.project.title} · ${item.thread.key.threadId}`}
                    relationship="description"
                  >
                    <code className={styles.worktreePath}>
                      {source?.label ?? item.target.environmentId} · {item.project.title} ·{" "}
                      {item.thread.key.threadId}
                    </code>
                  </Tooltip>
                </div>
              );
            }
            const isGroup = item.kind === "group";
            const name = isGroup ? item.group.name : item.project.title;
            const id = projectTreeRowId(item);
            const favorite = targetIsFavorite(snapshot, favoriteTarget(item));
            const groupSourceNames = isGroup
              ? [
                  ...new Set(
                    item.projects.map(
                      (project) =>
                        environmentsById.get(project.key.environmentId)?.label ??
                        project.key.environmentId,
                    ),
                  ),
                ]
              : [];
            const source = !isGroup
              ? environmentsById.get(item.project.key.environmentId)
              : undefined;
            const path = !isGroup
              ? item.project.workspaceRoot
              : `${item.projects.length} projects · ${groupSourceNames.join(", ") || "No sources"}`;
            return (
              <div className={styles.projectSubject}>
                <div className={styles.subjectHeading}>
                  {row.getCanExpand() ? (
                    <TreeToggle
                      expanded={row.getIsExpanded()}
                      aria-label={`${row.getIsExpanded() ? "Collapse" : "Expand"} ${name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        row.toggleExpanded();
                      }}
                    />
                  ) : (
                    <span className={styles.toggleSpacer} aria-hidden="true" />
                  )}
                  <Tooltip
                    content={favorite ? "Remove from favorites" : "Add to favorites"}
                    relationship="label"
                  >
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={<Star size={14} fill={favorite ? "currentColor" : "none"} />}
                      aria-label={`${favorite ? "Unpin" : "Pin"} ${name}`}
                      aria-pressed={favorite}
                      className={styles.favoriteButton}
                      disabled={pendingFavorite === JSON.stringify(favoriteTarget(item))}
                      onClick={(event) => {
                        event.stopPropagation();
                        void changeFavorite(item);
                      }}
                    />
                  </Tooltip>
                  {isGroup ? (
                    <Layers className={styles.projectIcon} size={16} aria-hidden="true" />
                  ) : (
                    <FolderGit2 className={styles.projectIcon} size={16} aria-hidden="true" />
                  )}
                  <span className={styles.projectName}>{name}</span>
                  <Badge size="small" appearance="ghost" mono className={styles.sessionCount}>
                    {item.sessions.length}
                  </Badge>
                  {isGroup ? (
                    <Tooltip content="Edit group and project membership" relationship="label">
                      <Button
                        appearance="subtle"
                        size="small"
                        aria-label={`Edit ${name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingGroup(item.group);
                        }}
                      >
                        Edit
                      </Button>
                    </Tooltip>
                  ) : null}
                </div>
                <div className={styles.subjectMeta}>
                  <Tooltip content={path} relationship="description">
                    <code className={styles.projectPath}>{path}</code>
                  </Tooltip>
                  {isGroup ? null : (
                    <Badge appearance="outline" color="neutral" size="small">
                      {source?.label ?? item.project.key.environmentId}
                    </Badge>
                  )}
                  <span className={styles.rowIdentity}>{id}</span>
                </div>
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "status",
          header: "State / source",
          cell: ({ row }) => {
            const item = row.original;
            if (item.kind === "session") {
              const presentation = getSessionStatePresentation(item.thread.classification);
              const freshness = item.sourceFreshness;
              return (
                <div className={styles.statusStack}>
                  <Badge
                    appearance="tint"
                    color={presentation.color}
                    dot
                    pulse={presentation.pulse}
                    size="small"
                  >
                    {presentation.label}
                  </Badge>
                  <Badge
                    appearance="outline"
                    color={freshnessColor(freshness?.state)}
                    size="small"
                    title={freshness?.reason ?? undefined}
                  >
                    {item.thread.sourceStatus} · {freshness?.state ?? "unavailable"}
                  </Badge>
                </div>
              );
            }
            if (item.kind === "group") {
              return (
                <Badge appearance="outline" color="neutral" size="small">
                  {item.projects.length} projects
                </Badge>
              );
            }
            const freshness = freshnessByEnvironment.get(item.project.key.environmentId);
            return (
              <Badge appearance="outline" color={freshnessColor(freshness?.state)} size="small">
                {freshness?.state ?? "unavailable"}
              </Badge>
            );
          },
        }),
        columnHelper.display({
          id: "source",
          header: "Source / project",
          cell: ({ row }) => {
            const item = row.original;
            if (item.kind === "session")
              return (
                <span className={styles.mutedText}>
                  {environmentsById.get(item.target.environmentId)?.label ??
                    item.target.environmentId}
                </span>
              );
            if (item.kind === "group")
              return (
                <span className={styles.mutedText}>
                  {new Set(item.projects.map((project) => project.key.environmentId)).size} sources
                </span>
              );
            return <span className={styles.mutedText}>{item.project.key.environmentId}</span>;
          },
        }),
        columnHelper.display({
          id: "updated",
          header: "Updated",
          cell: ({ row }) => {
            const item = row.original;
            if (item.kind === "session")
              return (
                <time className={styles.mutedText}>{formatTimestamp(item.thread.updatedAt)}</time>
              );
            return (
              <span className={styles.mutedText}>{item.sessions.length} current sessions</span>
            );
          },
        }),
        columnHelper.display({
          id: "actions",
          header: "Actions",
          cell: ({ row }) => {
            const item = row.original;
            const actions =
              item.kind === "session"
                ? [{ label: "Open summary fullscreen", run: () => openSession(item, "fullscreen") }]
                : item.kind === "group"
                  ? [
                      { label: "Edit group", run: () => setEditingGroup(item.group) },
                      { label: "Pin or unpin group", run: () => void changeFavorite(item) },
                    ]
                  : [{ label: "Pin or unpin project", run: () => void changeFavorite(item) }];
            const label =
              item.kind === "session"
                ? item.thread.title
                : item.kind === "group"
                  ? item.group.name
                  : item.project.title;
            return (
              <div className={styles.actions} onClick={(event) => event.stopPropagation()}>
                <Toolbar aria-label={`Actions for ${label}`} className={styles.rowActions}>
                  {actions.map((action) => (
                    <Button
                      key={action.label}
                      appearance="subtle"
                      size="small"
                      onClick={action.run}
                    >
                      {action.label}
                    </Button>
                  ))}
                </Toolbar>
                <div className={styles.overflowActions}>
                  <Menu positioning="below-end">
                    <MenuTrigger>
                      <MenuButton
                        appearance="subtle"
                        size="small"
                        menuIcon={<MoreHorizontal size={16} />}
                        aria-label={`Actions for ${label}`}
                      />
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {actions.map((action) => (
                          <MenuItem key={action.label} onClick={action.run}>
                            {action.label}
                          </MenuItem>
                        ))}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                </div>
              </div>
            );
          },
        }),
      ]),
    [
      snapshot,
      environmentsById,
      freshnessByEnvironment,
      pendingFavorite,
      changeFavorite,
      openSession,
    ],
  );

  const tableOptions = useMemo(
    () => projectTreeTableOptions(tableData, expandedRowIds, setExpandedRows),
    [tableData, expandedRowIds, setExpandedRows],
  );
  const table = useTable({
    ...tableOptions,
    columns,
  });
  const rows = table.getRowModel().rows;

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    row: (typeof rows)[number],
  ) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target !== event.currentTarget &&
      target.closest('button, a, input, [role="tab"]')
    )
      return;
    if (handleProjectTreeRowKey(event.key, row, expandedRowIds, toggleExpandRow, openSession)) {
      event.preventDefault();
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    requestAnimationFrame(() => searchToggleRef.current?.focus({ preventScroll: true }));
  };
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() =>
      searchPaneRef.current?.querySelector("input")?.focus({ preventScroll: true }),
    );
  };
  const rootRowIds = tableData.map(projectTreeRowId);

  return (
    <section className={styles.surface} aria-label="Projects and sessions">
      <div className={styles.controls}>
        <div className={styles.filterRow}>
          <TabList
            appearance="pill"
            size="small"
            selectedValue={stateFilter}
            onTabSelect={(_, data) => {
              const selected = stateFilters.find((filter) => filter.value === data.value);
              if (selected) setStateFilter(selected.value);
            }}
            className={styles.filters}
            aria-label="Filter sessions by state"
          >
            {stateFilters.map((filter) => (
              <Tab
                key={filter.value}
                value={filter.value}
                color={
                  filter.value === "all"
                    ? "neutral"
                    : getSessionStatePresentation(filter.value).color
                }
                className={styles.filterTab}
              >
                <span className={styles.filterLabel}>
                  {filter.label}
                  <span className={styles.filterCount}>{selection.stateCounts[filter.value]}</span>
                </span>
              </Tab>
            ))}
          </TabList>
        </div>
        {error ? (
          <MessageBar intent="error" role="alert">
            {error}
          </MessageBar>
        ) : null}
        <div className={styles.actionRow}>
          <Badge appearance="outline" color="neutral" mono>
            {selection.filteredCount} / {selection.totalCount} sessions
          </Badge>
          <div className={styles.searchActions} data-search-open={searchOpen || undefined}>
            <div
              ref={searchPaneRef}
              className={styles.searchPane}
              inert={!searchOpen}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  closeSearch();
                }
              }}
            >
              <SearchBox
                size="small"
                value={searchQuery}
                onChange={(_, data) => setSearchQuery(data.value)}
                placeholder="Search projects and sessions"
                aria-label="Search projects and sessions"
                className={styles.searchBox}
              />
              <Tooltip content="Close search" relationship="label">
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<X size={14} />}
                  aria-label="Close search"
                  className={styles.searchClose}
                  onClick={closeSearch}
                />
              </Tooltip>
            </div>
            <Toolbar
              aria-label="Project tree controls"
              className={styles.treeActions}
              inert={searchOpen}
            >
              <Menu
                positioning="below-end"
                checkedValues={{ group: [groupFilter] }}
                onCheckedValueChange={(_, data) => {
                  const value = data.checkedItems[0];
                  if (value !== undefined) setGroupFilter(value);
                }}
              >
                <Tooltip
                  content={
                    groupFilter === "all"
                      ? "All groups and projects"
                      : (snapshot.groups.find((group) => group.id === groupFilter)?.name ??
                        "Selected group")
                  }
                  relationship="description"
                >
                  <MenuTrigger>
                    <ToolbarButton
                      icon={
                        <ListFilter
                          size={14}
                          className={styles.groupFilterIcon}
                          data-active={groupFilter !== "all" || undefined}
                        />
                      }
                      aria-label="Filter by project group"
                    />
                  </MenuTrigger>
                </Tooltip>
                <MenuPopover>
                  <MenuList>
                    <MenuItemRadio name="group" value="all" persistOnClick={false}>
                      All groups and projects
                    </MenuItemRadio>
                    {snapshot.groups.map((group) => (
                      <MenuItemRadio
                        key={group.id}
                        name="group"
                        value={group.id}
                        persistOnClick={false}
                      >
                        {group.name}
                      </MenuItemRadio>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              <Tooltip content="Create project group" relationship="label">
                <ToolbarButton
                  icon={<Plus size={14} />}
                  aria-label="Create project group"
                  onClick={() => setCreatingGroup(true)}
                />
              </Tooltip>
              <Tooltip content="Expand all" relationship="label">
                <ToolbarButton
                  icon={<ChevronsUpDown size={14} />}
                  aria-label="Expand all"
                  onClick={() => setExpandedRows(rootRowIds)}
                />
              </Tooltip>
              <Tooltip content="Collapse all" relationship="label">
                <ToolbarButton
                  icon={<ChevronUp size={14} />}
                  aria-label="Collapse all"
                  onClick={() => setExpandedRows([])}
                />
              </Tooltip>
              <Tooltip content="Search projects and sessions" relationship="label">
                <ToolbarButton
                  ref={searchToggleRef}
                  icon={<Search size={14} />}
                  aria-label="Search projects and sessions"
                  aria-expanded={searchOpen}
                  onClick={openSearch}
                />
              </Tooltip>
            </Toolbar>
          </div>
        </div>
      </div>
      <div className={styles.tableScroller}>
        <Table role="treegrid" aria-label="Project and session tree" className={styles.table}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} role="row" className={styles.headerRow}>
                {headerGroup.headers.map((header) => {
                  const column = sortColumns[header.column.id];
                  const active = column === sort.column;
                  return (
                    <TableHeaderCell
                      key={header.id}
                      scope="col"
                      aria-sort={
                        column === undefined
                          ? undefined
                          : active
                            ? sort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                      }
                      className={styles[`${header.column.id}Column`]}
                    >
                      {header.isPlaceholder ? null : column === undefined ? (
                        <span className={styles.columnLabel}>
                          <table.FlexRender header={header} />
                        </span>
                      ) : (
                        <Button
                          appearance="transparent"
                          size="small"
                          onClick={() => setSort((current) => toggleOverviewSort(current, column))}
                        >
                          <table.FlexRender header={header} />
                          {active ? (sort.direction === "asc" ? " ↑" : " ↓") : null}
                        </Button>
                      )}
                    </TableHeaderCell>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow role="row">
                <TableCell colSpan={table.getAllLeafColumns().length} className={styles.emptyCell}>
                  <FolderGit2 size={24} aria-hidden="true" />
                  <strong>No matching projects or sessions</strong>
                  <span>Change the source, group, state, or search filter.</span>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const isSession = row.original.kind === "session";
                const identity = row.original.kind === "session" ? row.original.target : undefined;
                const selected =
                  identity !== undefined &&
                  selectedTarget !== null &&
                  targetKey(identity) === targetKey(selectedTarget);
                return (
                  <TableRow
                    key={row.id}
                    role="row"
                    tabIndex={0}
                    aria-level={row.depth + 1}
                    aria-expanded={row.getCanExpand() ? row.getIsExpanded() : undefined}
                    aria-selected={selected || undefined}
                    data-kind={isSession ? "session" : "group"}
                    data-level={row.depth}
                    data-selected={selected ? "true" : undefined}
                    className={isSession ? styles.sessionRow : styles.projectRow}
                    onClick={() => {
                      if (row.original.kind === "session") openSession(row.original, "split");
                      else row.toggleExpanded();
                    }}
                    onKeyDown={(event) => handleRowKeyDown(event, row)}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className={styles[`${cell.column.id}Column`]}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {creatingGroup || editingGroup !== undefined ? (
        <ProjectGroupModal
          open
          group={editingGroup}
          snapshot={snapshot}
          connection={connection}
          onClose={() => {
            setCreatingGroup(false);
            setEditingGroup(undefined);
          }}
        />
      ) : null}
    </section>
  );
}
