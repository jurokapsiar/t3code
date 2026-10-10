import type * as Effect from "effect/Effect";
import type { SourceRpcClient } from "./sourceSessions";

type WorkspaceListing = Effect.Success<ReturnType<SourceRpcClient["projects.listEntries"]>>;
type WorkspaceEntry = WorkspaceListing["entries"][number];

export interface WorkspaceSelection {
  readonly directoryPath: string;
  readonly filePath?: string;
}

function requireRelativeEntryPath(path: string): void {
  // Native entries already use '/' separators; backslashes and colons can be POSIX names.
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("The source returned a path outside its workspace-relative entry contract.");
  }
}

export function selectWorkspaceEntry(
  entry: WorkspaceEntry,
  directoryPath: string,
): WorkspaceSelection {
  requireRelativeEntryPath(entry.path);
  if (workspaceParentDirectory(entry.path) !== directoryPath) {
    throw new Error("The source returned an entry outside the selected workspace directory.");
  }
  return entry.kind === "directory"
    ? { directoryPath: entry.path }
    : { directoryPath, filePath: entry.path };
}

export function validateWorkspaceListing(result: WorkspaceListing, directoryPath: string): void {
  if (directoryPath !== "") requireRelativeEntryPath(directoryPath);
  for (const entry of result.entries) selectWorkspaceEntry(entry, directoryPath);
}

export function workspaceParentDirectory(directoryPath: string): string | undefined {
  if (directoryPath === "") return undefined;
  requireRelativeEntryPath(directoryPath);
  const separator = directoryPath.lastIndexOf("/");
  return separator === -1 ? "" : directoryPath.slice(0, separator);
}
