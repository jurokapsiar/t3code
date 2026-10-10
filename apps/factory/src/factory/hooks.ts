import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import type { FactoryOverviewSnapshot } from "@t3tools/contracts/factory";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { FactoryConnectionApi, ConnectionStatus } from "./FactoryConnection";
import type { SourceLease } from "./sourceSessions";
import { factoryKeys } from "./queryKeys";

export function useFactoryConnectionStatus(connection: FactoryConnectionApi): ConnectionStatus {
  return useSyncExternalStore(
    connection.subscribeStatus,
    () => connection.status,
    () => connection.status,
  );
}

export function useFactoryOverviewQuery(factoryId: string) {
  return useQuery<FactoryOverviewSnapshot>({
    queryKey: factoryKeys.overview(factoryId),
    queryFn: skipToken,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function factoryEnvironmentsQueryOptions(
  connection: FactoryConnectionApi,
  factoryId: string,
) {
  return queryOptions({
    queryKey: factoryKeys.environments(factoryId),
    queryFn: ({ signal }) =>
      connection.request((client) => client["factory.environments.list"]({}), { signal }),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useFactoryEnvironmentsQuery(connection: FactoryConnectionApi, factoryId: string) {
  const status = useFactoryConnectionStatus(connection);
  return useQuery({
    ...factoryEnvironmentsQueryOptions(connection, factoryId),
    enabled:
      factoryId !== "" &&
      connection.factoryId === factoryId &&
      (status.phase === "online" ||
        status.phase === "synchronizing" ||
        status.reason === "overview-too-large"),
  });
}

export function useFactoryGroupsQuery(connection: FactoryConnectionApi, factoryId: string) {
  return useQuery({
    queryKey: factoryKeys.groups(factoryId),
    queryFn: ({ signal }) =>
      connection.request((client) => client["factory.groups.list"]({}), { signal }),
  });
}

export function useSourceQueryFreshness(
  query: {
    readonly isFetching: boolean;
    readonly isError: boolean;
    readonly isFetchedAfterMount: boolean;
    readonly dataUpdatedAt: number;
    readonly refetch: () => Promise<{ readonly isError: boolean }>;
  },
  lease: SourceLease | undefined,
  enabled: boolean,
  identity: string,
): boolean {
  const [attempt, setAttempt] = useState<{
    readonly lease: SourceLease;
    readonly identity: string;
    readonly startedAt: number;
  }>();
  useEffect(() => {
    if (lease === undefined || !enabled) {
      setAttempt(undefined);
      return;
    }
    const startedAt = Date.now();
    setAttempt({ lease, identity, startedAt });
    void query.refetch();
  }, [enabled, identity, lease, query.refetch]);
  return (
    enabled &&
    lease !== undefined &&
    attempt?.lease === lease &&
    attempt.identity === identity &&
    query.isFetchedAfterMount &&
    query.dataUpdatedAt >= attempt.startedAt &&
    !query.isFetching &&
    !query.isError
  );
}

export function useSourceConfigQuery(
  factoryId: string,
  environmentId: string,
  lease?: SourceLease,
  enabled = true,
  registrationId = lease?.registrationId ?? "",
) {
  const query = useQuery({
    queryKey: factoryKeys.sourceConfig(factoryId, environmentId, registrationId),
    queryFn:
      lease === undefined || !enabled
        ? skipToken
        : ({ signal }) => lease.request((client) => client["server.getConfig"]({}), { signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const sourceSynchronized = useSourceQueryFreshness(
    query,
    lease,
    enabled,
    JSON.stringify([factoryId, registrationId, environmentId]),
  );
  return { ...query, sourceSynchronized };
}
