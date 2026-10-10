import type { QueryClient } from "@tanstack/react-query";
import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { threadDetailKey } from "./queryKeys";

export function invalidateMutableWorkspace(
  client: QueryClient,
  factoryId: string,
  target: FactoryFrameTarget,
  workspaceRoot: string,
) {
  const prefix = threadDetailKey(
    factoryId,
    target.environmentId,
    target.threadId,
    target.registrationId,
  );
  return client.invalidateQueries(
    {
      predicate: (query) => {
        const key = query.queryKey;
        if (!prefix.every((part, index) => part === key[index])) return false;
        return (
          ((key[7] === "files" || key[7] === "file") && key[8] === workspaceRoot) ||
          (key[7] === "diff" && key[8] === "working-tree" && key[9] === workspaceRoot)
        );
      },
    },
    { cancelRefetch: false },
  );
}

export function recordWorkspaceVcsStatus(
  client: QueryClient,
  factoryId: string,
  target: FactoryFrameTarget,
  workspaceRoot: string,
  status: unknown,
) {
  const key = [
    ...threadDetailKey(factoryId, target.environmentId, target.threadId, target.registrationId),
    "vcs",
    workspaceRoot,
  ];
  const previous = client.getQueryData(key);
  const current = client.setQueryData(key, status);
  return previous === current
    ? Promise.resolve()
    : invalidateMutableWorkspace(client, factoryId, target, workspaceRoot);
}
