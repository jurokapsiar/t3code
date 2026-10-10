import {
  QueryClient,
  QueryObserver,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { FactoryEnvironmentView, FactoryFrameTarget } from "@t3tools/contracts/factory";
import { WsRpcGroup } from "@t3tools/contracts/rpc";
import { describe, expect, it } from "vite-plus/test";
import { SourceSessionOwner, type SourceLease, type SourceRpcClient } from "./sourceSessions";
import { threadDetailKey } from "./queryKeys";
import { invalidateMutableWorkspace, recordWorkspaceVcsStatus } from "./workspaceCache";
import {
  workspaceBrowseQueryOptions,
  workspaceFileQueryOptions,
  workingDiffQueryOptions,
} from "./sourceDetailHooks";

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
function harness() {
  let revision = 1;
  let reads = 0;
  const source = new Proxy(
    {},
    {
      get(_target, method) {
        return () => {
          reads += 1;
          const rpc = [...WsRpcGroup.requests.values()].find((rpc) => rpc._tag === method);
          if (!rpc) throw new Error("Unknown source read");
          const result =
            method === "projects.listEntries"
              ? { entries: [{ path: `file-${revision}.txt`, kind: "file" }], truncated: false }
              : method === "projects.readFile"
                ? {
                    relativePath: "file.txt",
                    contents: `revision-${revision}`,
                    byteLength: 10,
                    truncated: false,
                  }
                : {
                    cwd: "/work",
                    generatedAt: DateTime.makeUnsafe("2026-10-04T10:00:00Z"),
                    sources: [
                      {
                        id: "working",
                        kind: "working-tree",
                        title: "Working",
                        baseRef: null,
                        headRef: null,
                        diff: `revision-${revision}`,
                        diffHash: `hash-${revision}`,
                        truncated: false,
                      },
                    ],
                  };
          return Effect.succeed(Schema.decodeUnknownSync(rpc.successSchema)(result));
        };
      },
    },
  ) as SourceRpcClient;
  const owner = new SourceSessionOwner({
    isCurrent: () => true,
    getEnvironments: async () => [environment],
    openTransport: async () => ({ client: source, environmentId: "env-a", close: async () => {} }),
  });
  return {
    owner,
    advance: () => {
      revision += 1;
    },
    get reads() {
      return reads;
    },
  };
}

async function verifyRefresh<Data, Key extends QueryKey>(
  client: QueryClient,
  h: ReturnType<typeof harness>,
  options: UseQueryOptions<Data, Error, Data, Key>,
  expected: string,
) {
  await client.fetchQuery<Data, Error, Data, Key>(options);
  expect(h.reads).toBe(1);
  h.advance();
  const observer = new QueryObserver<Data, Error, Data, Data, Key>(client, options);
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  const unsubscribe = observer.subscribe((result) => {
    if (!result.isFetching) resolve();
  });
  if (!observer.getCurrentResult().isFetching) resolve();
  await settled;
  unsubscribe();
  expect(h.reads).toBe(2);
  expect(JSON.stringify(observer.getCurrentResult().data)).toContain(expected);
}

const cases = [
  [
    "directory",
    (lease, client, h) =>
      verifyRefresh(
        client,
        h,
        workspaceBrowseQueryOptions("factory", target, lease, "/work", ""),
        "file-2.txt",
      ),
  ],
  [
    "file",
    (lease, client, h) =>
      verifyRefresh(
        client,
        h,
        workspaceFileQueryOptions("factory", target, lease, "/work", "file.txt"),
        "revision-2",
      ),
  ],
  [
    "working diff",
    (lease, client, h) =>
      verifyRefresh(
        client,
        h,
        workingDiffQueryOptions("factory", target, lease, "/work"),
        "revision-2",
      ),
  ],
] as const satisfies ReadonlyArray<
  readonly [
    string,
    (lease: SourceLease, client: QueryClient, h: ReturnType<typeof harness>) => Promise<void>,
  ]
>;

describe("mutable source Query policy", () => {
  it.each(cases)(
    "refreshes %s on activation instead of reusing a permanently fresh cache",
    async (_name, verify) => {
      const h = harness();
      const client = new QueryClient();
      try {
        const lease = await h.owner.acquireSource("env-a");
        await verify(lease, client, h);
        lease.release();
      } finally {
        await h.owner.invalidate();
        client.clear();
      }
    },
  );
  it("invalidates only mutable matching workspace reads from changed VCS evidence, leaving immutable diffs untouched", async () => {
    const client = new QueryClient();
    const prefix = threadDetailKey(
      "factory",
      target.environmentId,
      target.threadId,
      target.registrationId,
    );
    const mutable = [
      [...prefix, "files", "/work", ""],
      [...prefix, "file", "/work", "file.txt"],
      [...prefix, "diff", "working-tree", "/work"],
    ];
    const preserved = [
      [...prefix, "diff", "thread", 3],
      [...prefix, "diff", "checkpoint", "checkpoint"],
      [...prefix, "file", "/other-workspace", "file.txt"],
      [
        ...threadDetailKey(
          "other-factory",
          target.environmentId,
          target.threadId,
          target.registrationId,
        ),
        "file",
        "/work",
        "file.txt",
      ],
      [
        ...threadDetailKey("factory", target.environmentId, target.threadId, "other-registration"),
        "file",
        "/work",
        "file.txt",
      ],
      [
        ...threadDetailKey("factory", "other-environment", target.threadId, target.registrationId),
        "file",
        "/work",
        "file.txt",
      ],
      [
        ...threadDetailKey("factory", target.environmentId, "other-thread", target.registrationId),
        "file",
        "/work",
        "file.txt",
      ],
    ];
    try {
      for (const key of [...mutable, ...preserved]) client.setQueryData(key, { content: "cached" });
      await recordWorkspaceVcsStatus(client, "factory", target, "/work", { changed: ["file.txt"] });
      for (const key of mutable) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      for (const key of preserved) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      for (const key of mutable) client.setQueryData(key, { content: "refreshed" });
      await recordWorkspaceVcsStatus(client, "factory", target, "/work", { changed: ["file.txt"] });
      for (const key of mutable) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      await recordWorkspaceVcsStatus(client, "factory", target, "/work", {
        changed: ["other.txt"],
      });
      for (const key of mutable) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("deliberate refresh and a new source session read actual updated file content", async () => {
    const h = harness();
    const client = new QueryClient();
    try {
      const lease = await h.owner.acquireSource("env-a");
      const options = workspaceFileQueryOptions("factory", target, lease, "/work", "file.txt");
      await client.fetchQuery(options);
      const observer = new QueryObserver(client, { ...options, refetchOnMount: false });
      const unsubscribe = observer.subscribe(() => {});
      h.advance();
      await observer.refetch();
      expect(client.getQueryData(options.queryKey)?.contents).toBe("revision-2");
      h.advance();
      await invalidateMutableWorkspace(client, "factory", target, "/work");
      expect(client.getQueryData(options.queryKey)?.contents).toBe("revision-3");
      unsubscribe();
      await h.owner.retrySource("env-a");
      lease.release();
      const newLease = await h.owner.acquireSource("env-a");
      expect(newLease.sessionId).not.toBe(lease.sessionId);
      h.advance();
      const fresh = await client.fetchQuery(
        workspaceFileQueryOptions("factory", target, newLease, "/work", "file.txt"),
      );
      expect(fresh.contents).toBe("revision-4");
      newLease.release();
    } finally {
      await h.owner.invalidate();
      client.clear();
    }
  });
});
