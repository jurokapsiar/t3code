import type { SourceLease } from "./sourceSessions";
import type * as Schema from "effect/Schema";
import { validateWorkspaceListing } from "./workspaceFiles";

export async function readWorkspaceDirectory(
  lease: SourceLease,
  cwd: string,
  directoryPath: string,
  signal?: AbortSignal,
) {
  const result = await lease.request(
    (client) => client["projects.listEntries"]({ cwd, directoryPath }),
    { signal },
  );
  validateWorkspaceListing(result, directoryPath);
  return result;
}

export function readWorkspaceFile(
  lease: SourceLease,
  cwd: string,
  relativePath: string,
  signal?: AbortSignal,
) {
  return lease.request((client) => client["projects.readFile"]({ cwd, relativePath }), { signal });
}

type EnvironmentHttpApiContract =
  typeof import("@t3tools/contracts/environmentHttp").EnvironmentHttpApi;
export type BoundedSnapshot =
  EnvironmentHttpApiContract["groups"]["orchestration"]["endpoints"]["threadBoundedSnapshot"]["~Success"]["Type"];
type ThreadHistoryPage =
  EnvironmentHttpApiContract["groups"]["orchestration"]["endpoints"]["threadHistoryPage"]["~Success"]["Type"];

function firstSuccessSchema<T>(endpoint: {
  readonly success: ReadonlySet<Schema.Top>;
}): Schema.ConstraintDecoder<T> {
  const schema = endpoint.success.values().next().value;
  if (schema === undefined) throw new Error("The source detail contract has no success schema.");
  return schema as unknown as Schema.ConstraintDecoder<T>;
}

export async function readThreadBoundedSnapshot(
  lease: SourceLease,
  threadId: string,
  signal?: AbortSignal,
) {
  const { EnvironmentHttpApi } = await import("@t3tools/contracts/environmentHttp");
  const endpoint = EnvironmentHttpApi.groups.orchestration.endpoints.threadBoundedSnapshot;
  const schema = firstSuccessSchema<BoundedSnapshot>(endpoint);
  return lease.readHttp(
    `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
    schema,
    signal === undefined ? {} : { signal },
  );
}

export async function readThreadHistoryPage(
  lease: SourceLease,
  threadId: string,
  cursor: string,
  signal?: AbortSignal,
) {
  const { EnvironmentHttpApi } = await import("@t3tools/contracts/environmentHttp");
  const endpoint = EnvironmentHttpApi.groups.orchestration.endpoints.threadHistoryPage;
  const schema = firstSuccessSchema<ThreadHistoryPage>(endpoint);
  const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}/history?cursor=${encodeURIComponent(cursor)}`;
  return lease.readHttp(path, schema, signal === undefined ? {} : { signal });
}
