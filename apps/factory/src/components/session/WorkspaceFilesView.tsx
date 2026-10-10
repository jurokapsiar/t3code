import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { File, Folder, RefreshCw } from "lucide-react";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tooltip,
  TreeToggle,
} from "../../design-system/actions";
import { MessageBar } from "../../design-system/forms";
import type { SourceLease } from "../../factory/sourceSessions";
import {
  useVcsStatusStream,
  useWorkspaceFileQuery,
  workspaceBrowseQueryOptions,
} from "../../factory/sourceDetailHooks";
import { sourceLeaseForTarget } from "../../factory/useSourceLease";
import {
  flattenWorkspaceTree,
  selectWorkspaceTreeEntry,
  workspaceTreeIdentity,
  workspaceTreeReadPaths,
  workspaceTreeState,
  type WorkspaceListing,
  type WorkspaceTreeRow,
  type WorkspaceTreeState,
} from "./workspaceTree";
import styles from "./WorkspaceFilesView.module.css";

const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, WorkspaceTreeRow>();

interface Props {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly lease?: SourceLease;
  readonly workspaceRoot?: string;
  readonly stale: boolean;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The source returned an error.";
}

function fileReadErrorText(error: unknown): string {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return errorText(error);
  if (
    error._tag === "EnvironmentAuthorizationError" ||
    error._tag === "EnvironmentScopeRequiredError"
  ) {
    return "The source denied this file read. Check that this browser has source access.";
  }
  if (error._tag !== "ProjectReadFileError" || !("failure" in error)) return errorText(error);
  if (error.failure === "binary_file") return "This file is binary and cannot be shown as text.";
  if (error.failure === "path_not_file") return "The selected path is not a file.";
  if (
    error.failure === "workspace_path_outside_root" ||
    error.failure === "resolved_path_outside_root"
  ) {
    return "The source rejected this path because it is outside the workspace root.";
  }
  return errorText(error);
}

export default function WorkspaceFilesView({
  factoryId,
  target,
  lease,
  workspaceRoot,
  stale,
}: Props) {
  lease = stale ? undefined : sourceLeaseForTarget(lease, target);
  const identity = workspaceTreeIdentity(factoryId, target, workspaceRoot);
  const [navigation, setNavigation] = useState<WorkspaceTreeState>({ identity, expanded: [] });
  const current = workspaceTreeState(navigation, identity);
  const { expanded, filePath } = current;
  const readPaths = useMemo(
    () => workspaceTreeReadPaths(workspaceRoot, expanded),
    [workspaceRoot, expanded],
  );
  const options = useMemo(
    () =>
      readPaths.map((path) =>
        workspaceBrowseQueryOptions(factoryId, target, lease, workspaceRoot, path),
      ),
    [
      factoryId,
      target.registrationId,
      target.environmentId,
      target.threadId,
      lease,
      workspaceRoot,
      readPaths,
    ],
  );
  const directories = useQueries({
    queries: options,
    combine: (results) =>
      results.map((query) => ({
        data: query.data,
        error: query.error,
        isError: query.isError,
        isFetching: query.isFetching,
        refetch: query.refetch,
      })),
  });
  const queryClient = useQueryClient();
  const previousLease = useRef(lease);
  useEffect(() => {
    const changed = previousLease.current !== lease;
    previousLease.current = lease;
    if (!changed || lease === undefined) return;
    // Mutable listings must refresh on a renewed lease, not only on expansion.
    for (const { queryKey } of options) {
      void queryClient.refetchQueries(
        { queryKey, exact: true, type: "active" },
        { cancelRefetch: false },
      );
    }
  }, [lease, queryClient, options]);
  const file = useWorkspaceFileQuery(factoryId, target, lease, workspaceRoot, filePath);
  const vcs = useVcsStatusStream(factoryId, target, lease, workspaceRoot);
  const { notices, data } = useMemo(() => {
    const listings = new Map<string, WorkspaceListing>();
    const notices = new Map<string, ReactNode>();
    directories.forEach((query, index) => {
      const path = readPaths[index];
      if (query.data !== undefined) listings.set(path, query.data);
      if (
        query.isError ||
        query.data === undefined ||
        query.data.truncated ||
        query.data.entries.length === 0
      ) {
        notices.set(
          path,
          <>
            {query.isError ? (
              <MessageBar intent="error">
                Unable to browse {path || "this workspace"}: {errorText(query.error)}
              </MessageBar>
            ) : null}
            {query.data?.truncated ? (
              <MessageBar intent="warning">
                The source truncated this directory listing. Some entries are not shown.
                {query.data.entries.length === 0
                  ? " No entries were returned in this partial listing."
                  : ""}
              </MessageBar>
            ) : null}
            {!query.isError && query.data === undefined ? (
              <p className={styles.emptyFiles} role="status">
                {stale
                  ? "No cached directory listing is available while the source is stale."
                  : "Loading workspace files."}
              </p>
            ) : null}
            {query.data?.entries.length === 0 && !query.data.truncated ? (
              <p className={styles.emptyFiles}>This directory is empty.</p>
            ) : null}
          </>,
        );
      }
    });
    return {
      notices,
      data: flattenWorkspaceTree(listings, expanded).filter(
        (row) => row.kind === "entry" || notices.has(row.path),
      ),
    };
  }, [directories, readPaths, expanded, stale]);
  const select = useCallback(
    (row: Extract<WorkspaceTreeRow, { kind: "entry" }>) =>
      setNavigation((state) =>
        selectWorkspaceTreeEntry(workspaceTreeState(state, identity), row.entry, row.parentPath),
      ),
    [identity],
  );
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "name",
          header: "Name",
          cell: ({ row }) => {
            const item = row.original;
            if (item.kind === "listing") return notices.get(item.path);
            const isDirectory = item.entry.kind === "directory";
            const name = item.entry.path.split("/").at(-1);
            return (
              <div className={styles.fileName}>
                {isDirectory ? (
                  <TreeToggle
                    expanded={expanded.includes(item.entry.path)}
                    aria-label={`${expanded.includes(item.entry.path) ? "Collapse" : "Expand"} ${item.entry.path}`}
                    onClick={() => select(item)}
                  />
                ) : (
                  <span className={styles.toggleSpace} aria-hidden="true" />
                )}
                <div className={styles.entryAction}>
                  <Tooltip content={item.entry.path} relationship="description">
                    <Button
                      appearance="transparent"
                      size="small"
                      className={styles.pathAction}
                      icon={
                        isDirectory ? (
                          <Folder size={16} aria-hidden="true" />
                        ) : (
                          <File size={16} aria-hidden="true" />
                        )
                      }
                      onClick={() => select(item)}
                    >
                      <span className={styles.pathText}>
                        {name}
                        {item.entry.ignored ? " (ignored)" : ""}
                      </span>
                    </Button>
                  </Tooltip>
                </div>
              </div>
            );
          },
        }),
      ]),
    [notices, expanded, filePath, select],
  );
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => (row.kind === "entry" ? `entry:${row.entry.path}` : `listing:${row.path}`),
  });
  const handleRowKey = (event: KeyboardEvent<HTMLTableRowElement>, row: WorkspaceTreeRow) => {
    if (event.target !== event.currentTarget || row.kind !== "entry") return;
    const open = expanded.includes(row.entry.path);
    if (
      event.key === "Enter" ||
      event.key === " " ||
      (row.entry.kind === "directory" &&
        ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open)))
    ) {
      event.preventDefault();
      select(row);
    }
  };

  if (workspaceRoot === undefined)
    return (
      <MessageBar intent="warning">
        The source did not provide a workspace root. Files are unavailable.
      </MessageBar>
    );
  return (
    <main className={styles.view}>
      <header className={styles.workspaceHeader}>
        <Tooltip content={workspaceRoot} relationship="description">
          <code className={styles.workspacePath}>{workspaceRoot}</code>
        </Tooltip>
        <Tooltip content="Refresh files" relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<RefreshCw size={16} aria-hidden="true" />}
            aria-label="Refresh files"
            disabled={
              stale ||
              lease === undefined ||
              directories.some((query) => query.isFetching) ||
              file.isFetching
            }
            onClick={() => {
              for (const directory of directories) void directory.refetch();
              if (filePath !== undefined) void file.refetch();
            }}
          />
        </Tooltip>
      </header>
      {vcs.streamError !== undefined ? (
        <MessageBar intent="error">
          Unable to track workspace changes: {errorText(vcs.streamError)}. Refresh files to read
          current content.
        </MessageBar>
      ) : null}
      <div className={styles.workspaceContent}>
        <nav className={styles.fileNavigation} aria-label="Workspace files">
          <Table className={styles.fileTable} role="treegrid" aria-label="Workspace files">
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} role="row">
                  {group.headers.map((header) => (
                    <TableHeaderCell key={header.id} scope="col" role="columnheader">
                      <table.FlexRender header={header} />
                    </TableHeaderCell>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => {
                const item = row.original;
                const isDirectory = item.kind === "entry" && item.entry.kind === "directory";
                return (
                  <TableRow
                    key={row.id}
                    className={styles.fileRow}
                    role="row"
                    data-level={item.depth}
                    data-kind={isDirectory ? "group" : undefined}
                    data-selected={
                      (item.kind === "entry" && filePath === item.entry.path) || undefined
                    }
                    aria-level={item.depth + 1}
                    aria-expanded={isDirectory ? expanded.includes(item.entry.path) : undefined}
                    aria-selected={
                      item.kind === "entry" && !isDirectory
                        ? filePath === item.entry.path
                        : undefined
                    }
                    tabIndex={item.kind === "entry" ? 0 : undefined}
                    onKeyDown={(event) => handleRowKey(event, item)}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} role="gridcell">
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </nav>
        <section className={styles.preview} aria-label="Selected file">
          {filePath !== undefined ? (
            file.error ? (
              <MessageBar intent="error">
                The source could not read this path as text: {fileReadErrorText(file.error)} Missing
                or unreadable content is not shown as an empty file.
              </MessageBar>
            ) : file.data === undefined ? (
              <p className={styles.emptyPreview}>
                {stale
                  ? "No cached file content is available while the source is stale."
                  : "Loading file content."}
              </p>
            ) : (
              <>
                <header className={styles.previewHeader}>
                  <h2>
                    {file.data.relativePath}{" "}
                    <span className={styles.byteSize}>{file.data.byteLength} bytes</span>
                  </h2>
                </header>
                {file.data.truncated ? (
                  <MessageBar intent="warning">
                    The source truncated this file. The content below is partial.
                  </MessageBar>
                ) : null}
                <div className={styles.previewBody}>
                  <pre className={styles.fileContent}>{file.data.contents}</pre>
                </div>
              </>
            )
          ) : (
            <p className={styles.emptyPreview}>
              Expand a directory or select a file to browse the source workspace.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
