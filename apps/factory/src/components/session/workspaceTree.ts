import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import type { readWorkspaceDirectory } from "../../factory/sourceDetailApi";
import {
  selectWorkspaceEntry,
  validateWorkspaceListing,
  workspaceParentDirectory,
} from "../../factory/workspaceFiles";

export type WorkspaceListing = Awaited<ReturnType<typeof readWorkspaceDirectory>>;
type WorkspaceEntry = WorkspaceListing["entries"][number];
export interface WorkspaceTreeState {
  readonly identity: string;
  readonly expanded: ReadonlyArray<string>;
  readonly filePath?: string;
}
export type WorkspaceTreeRow =
  | {
      readonly kind: "entry";
      readonly entry: WorkspaceEntry;
      readonly parentPath: string;
      readonly depth: number;
    }
  | { readonly kind: "listing"; readonly path: string; readonly depth: number };

export function workspaceTreeIdentity(
  factoryId: string,
  target: FactoryFrameTarget,
  workspaceRoot: string | undefined,
): string {
  return JSON.stringify([
    factoryId,
    target.registrationId,
    target.environmentId,
    target.threadId,
    workspaceRoot,
  ]);
}
export function workspaceTreeState(
  state: WorkspaceTreeState,
  identity: string,
): WorkspaceTreeState {
  return state.identity === identity ? state : { identity, expanded: [] };
}
export function selectWorkspaceTreeEntry(
  state: WorkspaceTreeState,
  entry: WorkspaceEntry,
  parentPath: string,
): WorkspaceTreeState {
  const selection = selectWorkspaceEntry(entry, parentPath);
  if (selection.filePath !== undefined) return { ...state, filePath: selection.filePath };
  const path = selection.directoryPath;
  return {
    ...state,
    expanded: state.expanded.includes(path)
      ? state.expanded.filter((item) => item !== path)
      : [...state.expanded, path],
  };
}
export function workspaceTreeReadPaths(
  workspaceRoot: string | undefined,
  expanded: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (workspaceRoot === undefined) return [];
  const open = new Set(expanded);
  return [
    "",
    ...expanded
      .filter((path) => {
        let parent = workspaceParentDirectory(path);
        while (parent !== undefined && parent !== "") {
          if (!open.has(parent)) return false;
          parent = workspaceParentDirectory(parent);
        }
        return path !== "";
      })
      .sort((left, right) => left.split("/").length - right.split("/").length),
  ];
}
export function flattenWorkspaceTree(
  listings: ReadonlyMap<string, WorkspaceListing>,
  expanded: ReadonlyArray<string>,
): WorkspaceTreeRow[] {
  const open = new Set(expanded);
  const rows: WorkspaceTreeRow[] = [];
  const appendDirectory = (path: string, depth: number) => {
    rows.push({ kind: "listing", path, depth });
    const listing = listings.get(path);
    if (listing === undefined) return;
    validateWorkspaceListing(listing, path);
    for (const entry of listing.entries) {
      rows.push({ kind: "entry", entry, parentPath: path, depth });
      if (entry.kind === "directory" && open.has(entry.path))
        appendDirectory(entry.path, depth + 1);
    }
  };
  appendDirectory("", 0);
  return rows;
}
