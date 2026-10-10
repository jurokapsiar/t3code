import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { threadDetailKey } from "./queryKeys";
import { recordWorkspaceVcsStatus } from "./workspaceCache";
import { useSourceQueryFreshness } from "./hooks";
import type { SourceLease } from "./sourceSessions";
import { sourceLeaseForTarget } from "./useSourceLease";
import {
  readThreadBoundedSnapshot,
  readThreadHistoryPage,
  readWorkspaceDirectory,
  readWorkspaceFile,
} from "./sourceDetailApi";

function detailKey(factoryId: string, target: FactoryFrameTarget, ...parts: ReadonlyArray<string>) {
  return [
    ...threadDetailKey(factoryId, target.environmentId, target.threadId, target.registrationId),
    ...parts,
  ] as const;
}

export function useThreadBoundedQuery(
  factoryId: string,
  target: FactoryFrameTarget,
  lease?: SourceLease,
  enabled = true,
) {
  lease = sourceLeaseForTarget(lease, target);
  const query = useQuery({
    queryKey: detailKey(factoryId, target, "snapshot"),
    queryFn:
      lease === undefined || !enabled
        ? skipToken
        : ({ signal }) => readThreadBoundedSnapshot(lease, target.threadId, signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const sourceSynchronized = useSourceQueryFreshness(
    query,
    lease,
    enabled,
    JSON.stringify([factoryId, target.environmentId, target.threadId]),
  );
  return { ...query, sourceSynchronized };
}

export function useThreadHistoryPageQuery(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  cursor: string | undefined,
) {
  lease = sourceLeaseForTarget(lease, target);
  return useQuery({
    queryKey: detailKey(factoryId, target, "history", cursor ?? "initial"),
    queryFn:
      lease === undefined || cursor === undefined
        ? skipToken
        : ({ signal }) => readThreadHistoryPage(lease, target.threadId, cursor, signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function workspaceBrowseQueryOptions(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  workspaceRoot: string | undefined,
  directoryPath: string,
) {
  lease = sourceLeaseForTarget(lease, target);
  return queryOptions({
    queryKey: detailKey(factoryId, target, "files", workspaceRoot ?? "", directoryPath),
    queryFn:
      lease === undefined || workspaceRoot === undefined
        ? skipToken
        : ({ signal }) => readWorkspaceDirectory(lease, workspaceRoot, directoryPath, signal),
    staleTime: 0,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function workspaceFileQueryOptions(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  workspaceRoot: string | undefined,
  relativePath: string | undefined,
) {
  lease = sourceLeaseForTarget(lease, target);
  return queryOptions({
    queryKey: detailKey(factoryId, target, "file", workspaceRoot ?? "", relativePath ?? ""),
    queryFn:
      lease === undefined || workspaceRoot === undefined || relativePath === undefined
        ? skipToken
        : ({ signal }) => readWorkspaceFile(lease, workspaceRoot, relativePath, signal),
    staleTime: 0,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function workingDiffQueryOptions(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  workspaceRoot: string | undefined,
  enabled = true,
) {
  lease = sourceLeaseForTarget(lease, target);
  return queryOptions({
    queryKey: detailKey(factoryId, target, "diff", "working-tree", workspaceRoot ?? ""),
    queryFn:
      lease === undefined || workspaceRoot === undefined || !enabled
        ? skipToken
        : ({ signal }) =>
            lease.request((client) => client["review.getDiffPreview"]({ cwd: workspaceRoot }), {
              signal,
            }),
    staleTime: 0,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

function useMutableActivation(
  query: { readonly refetch: (options: { cancelRefetch: boolean }) => Promise<unknown> },
  lease: SourceLease | undefined,
  enabled: boolean,
  identity: string,
) {
  useEffect(() => {
    if (lease !== undefined && enabled) void query.refetch({ cancelRefetch: false });
  }, [lease, enabled, identity, query.refetch]);
}

export function useWorkspaceBrowseQuery(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  workspaceRoot: string | undefined,
  directoryPath: string,
) {
  lease = sourceLeaseForTarget(lease, target);
  const options = workspaceBrowseQueryOptions(
    factoryId,
    target,
    lease,
    workspaceRoot,
    directoryPath,
  );
  const query = useQuery(options);
  useMutableActivation(query, lease, workspaceRoot !== undefined, JSON.stringify(options.queryKey));
  return query;
}
export function useWorkspaceFileQuery(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  workspaceRoot: string | undefined,
  relativePath: string | undefined,
) {
  lease = sourceLeaseForTarget(lease, target);
  const options = workspaceFileQueryOptions(factoryId, target, lease, workspaceRoot, relativePath);
  const query = useQuery(options);
  useMutableActivation(
    query,
    lease,
    workspaceRoot !== undefined && relativePath !== undefined,
    JSON.stringify(options.queryKey),
  );
  return query;
}
export function useWorkingDiffQuery(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  workspaceRoot: string | undefined,
  enabled = true,
) {
  lease = sourceLeaseForTarget(lease, target);
  const options = workingDiffQueryOptions(factoryId, target, lease, workspaceRoot, enabled);
  const query = useQuery(options);
  useMutableActivation(
    query,
    lease,
    enabled && workspaceRoot !== undefined,
    JSON.stringify(options.queryKey),
  );
  return query;
}

export function useThreadEventStream(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  afterSequence: number | undefined,
) {
  lease = sourceLeaseForTarget(lease, target);
  const queryClient = useQueryClient();
  const queryKey = detailKey(factoryId, target, "events");
  const errorKey = [...queryKey, "error"] as const;
  const query = useQuery<ReadonlyArray<unknown>>({
    queryKey,
    queryFn: skipToken,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (lease === undefined || afterSequence === undefined) return;
    const key = detailKey(factoryId, target, "events");
    const stream = lease.acquireStream(
      `thread-events:${JSON.stringify([target.registrationId, target.environmentId, target.threadId])}`,
      (client) =>
        client["orchestration.subscribeThread"]({
          threadId: target.threadId,
          afterSequence,
          acceptBoundedSnapshot: true,
        }),
      (event) => {
        queryClient.removeQueries({ queryKey: [...key, "error"], exact: true });
        queryClient.setQueryData<ReadonlyArray<unknown>>(key, (current) =>
          [...(current ?? []), event].slice(-100),
        );
      },
      (error) => queryClient.setQueryData([...key, "error"], error),
    );
    return () => stream.release();
  }, [
    afterSequence,
    factoryId,
    lease,
    queryClient,
    target.registrationId,
    target.environmentId,
    target.threadId,
  ]);
  const streamError = useQuery<unknown>({
    queryKey: errorKey,
    queryFn: skipToken,
    staleTime: Infinity,
  });
  return { ...query, streamError: streamError.data };
}

export function useVcsStatusStream(
  factoryId: string,
  target: FactoryFrameTarget,
  lease: SourceLease | undefined,
  workspaceRoot: string | undefined,
  enabled = true,
) {
  lease = sourceLeaseForTarget(lease, target);
  const queryClient = useQueryClient();
  const queryKey = detailKey(factoryId, target, "vcs", workspaceRoot ?? "");
  const errorKey = [...queryKey, "error"] as const;
  const query = useQuery<unknown>({
    queryKey,
    queryFn: skipToken,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (lease === undefined || workspaceRoot === undefined || !enabled) return;
    const key = detailKey(factoryId, target, "vcs", workspaceRoot);
    const stream = lease.acquireStream(
      `vcs-status:${JSON.stringify([target.registrationId, target.environmentId, target.threadId, workspaceRoot])}`,
      (client) => client["subscribeVcsStatus"]({ cwd: workspaceRoot }),
      (event) => {
        queryClient.removeQueries({ queryKey: [...key, "error"], exact: true });
        if ("local" in event)
          void recordWorkspaceVcsStatus(queryClient, factoryId, target, workspaceRoot, event.local);
      },
      (error) => queryClient.setQueryData([...key, "error"], error),
    );
    return () => stream.release();
  }, [
    enabled,
    factoryId,
    lease,
    queryClient,
    target.registrationId,
    target.environmentId,
    target.threadId,
    workspaceRoot,
  ]);
  const streamError = useQuery<unknown>({
    queryKey: errorKey,
    queryFn: skipToken,
    staleTime: Infinity,
  });
  return { ...query, streamError: streamError.data };
}
