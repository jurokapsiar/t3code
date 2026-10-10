import { WsRpcGroup } from "@t3tools/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { SourceSessionOwner, type SourceRpcClient } from "./sourceSessions";
import { readWorkspaceDirectory, readWorkspaceFile } from "./sourceDetailApi";
import { selectWorkspaceEntry, workspaceParentDirectory } from "./workspaceFiles";
import { FactoryEnvironmentView } from "@t3tools/contracts/factory";

const listing = [...WsRpcGroup.requests.values()].find(
  (rpc) => rpc._tag === "projects.listEntries",
)!;
const fileRead = [...WsRpcGroup.requests.values()].find((rpc) => rpc._tag === "projects.readFile")!;

describe("native workspace entries", () => {
  it.each([
    "/work/project",
    "/",
    "C:\\work\\project",
    "C:\\",
    "\\\\server\\share\\project",
    "\\\\server\\share\\",
  ])("lists and selects real files under source root %s", async (cwd) => {
    const requests: Array<readonly [string, unknown]> = [];
    const directories = {
      "": {
        entries: [
          { path: "src", kind: "directory" },
          { path: "README.md", kind: "file" },
          { path: "ignored.txt", kind: "file", ignored: true },
          { path: "C:notes.txt", kind: "file" },
          { path: "a\\b.txt", kind: "file" },
        ],
        truncated: false,
      },
      src: {
        entries: [
          { path: "src/deep", kind: "directory" },
          { path: "src/main.ts", kind: "file" },
        ],
        truncated: false,
      },
      "src/deep": { entries: [], truncated: false },
    };
    const client = new Proxy(
      {},
      {
        get(_target, method) {
          if (method === "projects.listEntries")
            return (raw: unknown) => {
              const input = Schema.decodeUnknownSync(listing.payloadSchema)(raw);
              requests.push([String(method), input]);
              const result = directories[input.directoryPath as keyof typeof directories];
              if (result === undefined)
                throw new Error(
                  "Must request immediate source children, not recursive or prefix browse.",
                );
              return Effect.succeed(Schema.decodeUnknownSync(listing.successSchema)(result));
            };
          if (method === "projects.readFile")
            return (raw: unknown) => {
              const input = Schema.decodeUnknownSync(fileRead.payloadSchema)(raw);
              requests.push([String(method), input]);
              if (input.relativePath === "binary.dat" || input.relativePath === "missing.txt") {
                return Effect.fail(
                  Schema.decodeUnknownSync(fileRead.errorSchema)({
                    _tag: "ProjectReadFileError",
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    failure:
                      input.relativePath === "binary.dat" ? "binary_file" : "operation_failed",
                    operation: "open",
                    message: "The source cannot read this file.",
                  }),
                );
              }
              return Effect.succeed(
                Schema.decodeUnknownSync(fileRead.successSchema)({
                  relativePath: input.relativePath,
                  contents: "source text",
                  byteLength: 11,
                  truncated: false,
                }),
              );
            };
          throw new Error(`Unallowlisted workspace method: ${String(method)}`);
        },
      },
    ) as SourceRpcClient;
    const environment = Schema.decodeUnknownSync(FactoryEnvironmentView)({
      registrationId: "registration-a",
      environmentId: "env-a",
      endpoint: "https://unused.test",
      label: "Source",
      platform: null,
      enabled: true,
      state: "online",
      sourceAccess: {
        websocketRoute: "/factory/env/registration-a/ws",
        httpPrefix: "/factory/env/registration-a/",
        capabilities: { websocket: true, http: true },
      },
      credentialStorage: null,
      credentialExpiresAt: null,
      renewal: "unsupported",
      lastSeenAt: null,
      revision: 1,
    });
    const owner = new SourceSessionOwner({
      isCurrent: () => true,
      getEnvironments: async () => [environment],
      openTransport: async () => ({ client, environmentId: "env-a", close: async () => {} }),
    });
    try {
      const lease = await owner.acquireSource("env-a");
      const root = await readWorkspaceDirectory(lease, cwd, "");
      expect(root.entries.map((entry) => entry.path)).toEqual([
        "src",
        "README.md",
        "ignored.txt",
        "C:notes.txt",
        "a\\b.txt",
      ]);
      expect(selectWorkspaceEntry(root.entries[1], "")).toEqual({
        directoryPath: "",
        filePath: "README.md",
      });
      expect(await readWorkspaceFile(lease, cwd, "README.md")).toMatchObject({
        relativePath: "README.md",
        contents: "source text",
      });
      expect(selectWorkspaceEntry(root.entries[0], "")).toEqual({ directoryPath: "src" });
      for (const entry of root.entries.slice(3)) {
        const selection = selectWorkspaceEntry(entry, "");
        expect(selection.filePath).toBe(entry.path);
        expect(await readWorkspaceFile(lease, cwd, selection.filePath!)).toMatchObject({
          relativePath: entry.path,
          contents: "source text",
        });
      }
      const children = await readWorkspaceDirectory(lease, cwd, "src");
      expect(selectWorkspaceEntry(children.entries[1], "src")).toEqual({
        directoryPath: "src",
        filePath: "src/main.ts",
      });
      const selected = selectWorkspaceEntry(children.entries[1], "src");
      expect(await readWorkspaceFile(lease, cwd, selected.filePath!)).toEqual({
        relativePath: "src/main.ts",
        contents: "source text",
        byteLength: 11,
        truncated: false,
      });
      expect((await readWorkspaceDirectory(lease, cwd, "src/deep")).entries).toEqual([]);
      expect(workspaceParentDirectory("src/deep")).toBe("src");
      expect(workspaceParentDirectory("src")).toBe("");
      expect(workspaceParentDirectory("")).toBeUndefined();
      expect(requests).toEqual([
        ["projects.listEntries", { cwd, directoryPath: "" }],
        ["projects.readFile", { cwd, relativePath: "README.md" }],
        ["projects.readFile", { cwd, relativePath: "C:notes.txt" }],
        ["projects.readFile", { cwd, relativePath: "a\\b.txt" }],
        ["projects.listEntries", { cwd, directoryPath: "src" }],
        ["projects.readFile", { cwd, relativePath: "src/main.ts" }],
        ["projects.listEntries", { cwd, directoryPath: "src/deep" }],
      ]);
      directories.src.truncated = true;
      expect((await readWorkspaceDirectory(lease, cwd, "src")).truncated).toBe(true);
      await expect(readWorkspaceFile(lease, cwd, "binary.dat")).rejects.toMatchObject({
        _tag: "ProjectReadFileError",
        failure: "binary_file",
      });
      await expect(readWorkspaceFile(lease, cwd, "missing.txt")).rejects.toMatchObject({
        _tag: "ProjectReadFileError",
        failure: "operation_failed",
        operation: "open",
      });
    } finally {
      await owner.invalidate();
    }
  });

  it("rejects entries from siblings or ancestor directories rather than navigating out of scope", () => {
    expect(() => selectWorkspaceEntry({ path: "sibling/file.ts", kind: "file" }, "src")).toThrow();
    expect(() => selectWorkspaceEntry({ path: "src2", kind: "directory" }, "src")).toThrow();
    expect(() => selectWorkspaceEntry({ path: "README.md", kind: "file" }, "src")).toThrow();
  });

  it.each([
    "../outside",
    "/outside",
    "C:/outside",
    "//server/share/outside",
    "src/../../outside",
    "src//outside",
    "./outside",
  ])("rejects non-source-relative entry %s", (path) => {
    expect(() => selectWorkspaceEntry({ path, kind: "file" }, "")).toThrow();
  });
});
