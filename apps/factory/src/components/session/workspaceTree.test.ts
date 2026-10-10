import { FactoryFrameTarget } from "@t3tools/contracts/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  flattenWorkspaceTree,
  selectWorkspaceTreeEntry,
  workspaceTreeIdentity,
  workspaceTreeReadPaths,
  workspaceTreeState,
  type WorkspaceTreeState,
} from "./workspaceTree";

const target = { registrationId: "registration-a", environmentId: "env-a", threadId: "thread-a" };
const identity = workspaceTreeIdentity(
  "factory-a",
  Schema.decodeUnknownSync(FactoryFrameTarget)(target),
  "/work",
);
const initial: WorkspaceTreeState = { identity, expanded: [] };
const root = {
  entries: [
    { path: "src", kind: "directory" as const },
    { path: "README.md", kind: "file" as const },
  ],
  truncated: false,
};
const src = {
  entries: [
    { path: "src/deep", kind: "directory" as const },
    { path: "src/main.ts", kind: "file" as const },
  ],
  truncated: false,
};
const deep = { entries: [{ path: "src/deep/a.ts", kind: "file" as const }], truncated: false };
const listings = new Map([
  ["", root],
  ["src", src],
  ["src/deep", deep],
]);

describe("lazy workspace tree", () => {
  it("reads only the root initially and a directory only after expansion", () => {
    expect(workspaceTreeReadPaths("/work", initial.expanded)).toEqual([""]);
    const expanded = selectWorkspaceTreeEntry(initial, root.entries[0], "");
    expect(workspaceTreeReadPaths("/work", expanded.expanded)).toEqual(["", "src"]);
    expect(expanded.filePath).toBeUndefined();
    expect(
      flattenWorkspaceTree(listings, expanded.expanded)
        .filter((row) => row.kind === "entry")
        .map((row) => [row.entry.path, row.depth]),
    ).toEqual([
      ["src", 0],
      ["src/deep", 1],
      ["src/main.ts", 1],
      ["README.md", 0],
    ]);
  });

  it("collapsing a parent hides cached descendants and removes their read observers", () => {
    const expanded = selectWorkspaceTreeEntry(
      selectWorkspaceTreeEntry(initial, root.entries[0], ""),
      src.entries[0],
      "src",
    );
    expect(workspaceTreeReadPaths("/work", expanded.expanded)).toEqual(["", "src", "src/deep"]);
    const collapsed = selectWorkspaceTreeEntry(expanded, root.entries[0], "");
    expect(workspaceTreeReadPaths("/work", collapsed.expanded)).toEqual([""]);
    expect(
      flattenWorkspaceTree(listings, collapsed.expanded)
        .filter((row) => row.kind === "entry")
        .map((row) => row.entry.path),
    ).toEqual(["src", "README.md"]);
    const reopened = selectWorkspaceTreeEntry(collapsed, root.entries[0], "");
    expect(workspaceTreeReadPaths("/work", reopened.expanded)).toEqual(["", "src", "src/deep"]);
    expect(
      flattenWorkspaceTree(listings, reopened.expanded)
        .filter((row) => row.kind === "entry")
        .map((row) => [row.entry.path, row.depth]),
    ).toEqual([
      ["src", 0],
      ["src/deep", 1],
      ["src/deep/a.ts", 2],
      ["src/main.ts", 1],
      ["README.md", 0],
    ]);
  });

  it("selects only the clicked file, without changing directory reads", () => {
    const expanded = selectWorkspaceTreeEntry(initial, root.entries[0], "");
    const selected = selectWorkspaceTreeEntry(expanded, src.entries[1], "src");
    expect(selected.filePath).toBe("src/main.ts");
    expect(workspaceTreeReadPaths("/work", selected.expanded)).toEqual(["", "src"]);
    expect(selectWorkspaceTreeEntry(selected, root.entries[1], "").filePath).toBe("README.md");
  });

  it("never synthesizes a root read when the source has no workspace", () => {
    expect(workspaceTreeReadPaths(undefined, ["src"])).toEqual([]);
    expect(
      workspaceTreeIdentity(
        "factory-a",
        Schema.decodeUnknownSync(FactoryFrameTarget)(target),
        undefined,
      ),
    ).not.toBe(
      workspaceTreeIdentity("factory-a", Schema.decodeUnknownSync(FactoryFrameTarget)(target), ""),
    );
  });

  it.each([
    ["factory-b", target, "/work"],
    ["factory-a", { ...target, registrationId: "registration-b" }, "/work"],
    ["factory-a", { ...target, environmentId: "env-b" }, "/work"],
    ["factory-a", { ...target, threadId: "thread-b" }, "/work"],
    ["factory-a", target, "/other"],
  ] as const)(
    "resets expansion and preview for identity %s %o %s",
    (factoryId, nextTarget, rootPath) => {
      const selected: WorkspaceTreeState = { identity, expanded: ["src"], filePath: "src/main.ts" };
      const nextIdentity = workspaceTreeIdentity(
        factoryId,
        Schema.decodeUnknownSync(FactoryFrameTarget)(nextTarget),
        rootPath,
      );
      const reset = workspaceTreeState(selected, nextIdentity);
      expect(reset.expanded).toEqual([]);
      expect(reset.filePath).toBeUndefined();
      expect(reset.identity).toBe(nextIdentity);
      expect(workspaceTreeState(selected, identity)).toBe(selected);
    },
  );

  it("retains listing positions for loading, error, empty and truncated directory notices", () => {
    const rows = flattenWorkspaceTree(new Map([["", root]]), ["src"]);
    expect(
      rows.filter((row) => row.kind === "listing").map((row) => [row.path, row.depth]),
    ).toEqual([
      ["", 0],
      ["src", 1],
    ]);
  });

  it("rejects invalid source entries before using them as expansion or preview paths", () => {
    expect(() =>
      selectWorkspaceTreeEntry(initial, { path: "../escape", kind: "directory" }, ""),
    ).toThrow();
    expect(() =>
      selectWorkspaceTreeEntry(initial, { path: "elsewhere/file.ts", kind: "file" }, "src"),
    ).toThrow();
    expect(() =>
      flattenWorkspaceTree(
        new Map([["", { entries: [{ path: "../escape", kind: "directory" }], truncated: false }]]),
        [],
      ),
    ).toThrow();
  });
});
