import { QueryObserver, QueryClient } from "@tanstack/react-query";
import { FactoryEnvironmentView, FactoryFrameTarget } from "@t3tools/contracts/factory";
import { WsRpcGroup } from "@t3tools/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { SourceSessionOwner, type SourceRpcClient } from "../../factory/sourceSessions";
import {
  workspaceBrowseQueryOptions,
  workspaceFileQueryOptions,
} from "../../factory/sourceDetailHooks";
import { invalidateMutableWorkspace } from "../../factory/workspaceCache";
import {
  selectWorkspaceTreeEntry,
  workspaceTreeIdentity,
  workspaceTreeReadPaths,
  type WorkspaceTreeState,
} from "./workspaceTree";

const target = Schema.decodeUnknownSync(FactoryFrameTarget)({
  registrationId: "registration-a",
  environmentId: "env-a",
  threadId: "thread-a",
});
const environment = Schema.decodeUnknownSync(FactoryEnvironmentView)({
  ...target,
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

describe("lazy tree scoped query reads", () => {
  it("refreshes only visible expanded listings, retains collapsed cache, and pauses stale reads", async () => {
    const requests: Array<readonly [string, unknown]> = [];
    const source = new Proxy(
      {},
      {
        get(_target, method) {
          return (raw: unknown) => {
            const rpc = [...WsRpcGroup.requests.values()].find((rpc) => rpc._tag === method);
            if (!rpc) throw new Error("Unexpected source RPC.");
            const input = Schema.decodeUnknownSync(rpc.payloadSchema)(raw);
            requests.push([String(method), input]);
            if (method === "projects.listEntries") {
              if (!("directoryPath" in input)) throw new Error("Missing directory path.");
              const entries =
                input.directoryPath === ""
                  ? [
                      { path: "src", kind: "directory" },
                      { path: "README.md", kind: "file" },
                    ]
                  : input.directoryPath === "src"
                    ? [{ path: "src/main.ts", kind: "file" }]
                    : undefined;
              if (entries === undefined)
                throw new Error("The tree must not read undisclosed directories.");
              return Effect.succeed(
                Schema.decodeUnknownSync(rpc.successSchema)({ entries, truncated: false }),
              );
            }
            if (method === "projects.readFile")
              return Effect.succeed(
                Schema.decodeUnknownSync(rpc.successSchema)({
                  relativePath: "src/main.ts",
                  contents: "text",
                  byteLength: 4,
                  truncated: false,
                }),
              );
            throw new Error(`Unexpected source method: ${String(method)}`);
          };
        },
      },
    ) as SourceRpcClient;
    const owner = new SourceSessionOwner({
      isCurrent: () => true,
      getEnvironments: async () => [environment],
      openTransport: async () => ({
        client: source,
        environmentId: target.environmentId,
        close: async () => {},
      }),
    });
    const client = new QueryClient();
    const createObserver = (options: ReturnType<typeof workspaceBrowseQueryOptions>) =>
      new QueryObserver(client, options);
    const observers = new Map<
      string,
      { observer: ReturnType<typeof createObserver>; unsubscribe: () => void }
    >();
    const observe = (options: Array<ReturnType<typeof workspaceBrowseQueryOptions>>) => {
      const keys = new Set(options.map((option) => JSON.stringify(option.queryKey)));
      for (const [key, entry] of observers) {
        if (!keys.has(key)) {
          entry.unsubscribe();
          observers.delete(key);
        }
      }
      for (const option of options) {
        const key = JSON.stringify(option.queryKey);
        const existing = observers.get(key);
        if (existing) existing.observer.setOptions(option);
        else {
          const observer = createObserver(option);
          observers.set(key, { observer, unsubscribe: observer.subscribe(() => {}) });
        }
      }
    };
    try {
      const lease = await owner.acquireSource(target.environmentId);
      let state: WorkspaceTreeState = {
        identity: workspaceTreeIdentity("factory", target, "/work"),
        expanded: [],
      };
      const activeOptions = () =>
        workspaceTreeReadPaths("/work", state.expanded).map((path) =>
          workspaceBrowseQueryOptions("factory", target, lease, "/work", path),
        );
      observe(activeOptions());
      const root = await client.ensureQueryData(
        workspaceBrowseQueryOptions("factory", target, lease, "/work", ""),
      );
      expect(requests).toEqual([["projects.listEntries", { cwd: "/work", directoryPath: "" }]]);

      state = selectWorkspaceTreeEntry(state, root.entries[0], "");
      observe(activeOptions());
      const srcOptions = workspaceBrowseQueryOptions("factory", target, lease, "/work", "src");
      const src = await client.ensureQueryData(srcOptions);
      expect(requests).toEqual([
        ["projects.listEntries", { cwd: "/work", directoryPath: "" }],
        ["projects.listEntries", { cwd: "/work", directoryPath: "src" }],
      ]);

      state = selectWorkspaceTreeEntry(state, src.entries[0], "src");
      await client.fetchQuery(
        workspaceFileQueryOptions("factory", target, lease, "/work", state.filePath),
      );
      state = selectWorkspaceTreeEntry(state, root.entries[0], "");
      observe(activeOptions());
      await invalidateMutableWorkspace(client, "factory", target, "/work");
      expect(requests.slice(2)).toEqual([
        ["projects.readFile", { cwd: "/work", relativePath: "src/main.ts" }],
        ["projects.listEntries", { cwd: "/work", directoryPath: "" }],
      ]);
      expect(client.getQueryData(srcOptions.queryKey)?.entries).toEqual([
        { path: "src/main.ts", kind: "file" },
      ]);

      state = selectWorkspaceTreeEntry(state, root.entries[0], "");
      observe(
        workspaceTreeReadPaths("/work", state.expanded).map((path) =>
          workspaceBrowseQueryOptions("factory", target, undefined, "/work", path),
        ),
      );
      await invalidateMutableWorkspace(client, "factory", target, "/work");
      expect(requests).toHaveLength(4);
      expect(client.getQueryData(srcOptions.queryKey)?.entries).toEqual([
        { path: "src/main.ts", kind: "file" },
      ]);
      lease.release();
    } finally {
      for (const entry of observers.values()) entry.unsubscribe();
      client.clear();
      await owner.invalidate();
    }
  });
});
