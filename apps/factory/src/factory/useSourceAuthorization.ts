import { skipToken, useQueries } from "@tanstack/react-query";
import type { FactoryControlOperation as ControlOperation } from "@t3tools/contracts/factoryRpc";
import { factoryKeys } from "./queryKeys";
import type { SourceLease } from "./sourceSessions";

/** One shared admission read per factory, source session, and operation. Failures are not retried. */
export function sourceControlAdmissionQuery(
  factoryId: string,
  lease: SourceLease | undefined,
  operation: ControlOperation,
) {
  return {
    queryKey: factoryKeys.controlAdmission(
      factoryId,
      lease?.environmentId ?? "",
      lease?.sessionId ?? -1,
      operation,
      lease?.registrationId ?? "",
    ),
    queryFn:
      lease === undefined || lease.status.phase !== "online"
        ? skipToken
        : ({ signal }: { readonly signal: AbortSignal }) => lease.observeControl(operation, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } as const;
}

/**
 * Reads factory control admission for only the listed operations. Consumers of the same
 * source session share one request per operation. A new source session reads again.
 */
export function useSourceControlAuthorization(
  factoryId: string,
  lease: SourceLease | undefined,
  operations: readonly ControlOperation[],
) {
  const online = lease?.status.phase === "online";
  const results = useQueries({
    queries: operations.map((operation) =>
      sourceControlAdmissionQuery(factoryId, lease, operation),
    ),
  });
  const allowed = (kind: ControlOperation) => {
    const index = operations.indexOf(kind);
    return online && index >= 0 && results[index]?.data?.allowed === true;
  };
  const failed = results.find((result) => result.isError);
  const denied = results.flatMap((result) =>
    result.data?.allowed === false ? [result.data] : [],
  )[0];
  const ready = online && results.every((result) => result.data !== undefined);
  const authorized = operations[0] !== undefined && allowed(operations[0]);
  return {
    authorized,
    allowed,
    phase:
      failed !== undefined
        ? ("error" as const)
        : !ready
          ? ("checking" as const)
          : authorized
            ? ("allowed" as const)
            : ("denied" as const),
    message:
      failed !== undefined
        ? failed.error instanceof Error
          ? failed.error.message
          : "The factory control policy could not be read."
        : lease !== undefined && !online
          ? "The source control lease is no longer online."
          : denied !== undefined
            ? `Source control is unavailable: ${denied.reason}.`
            : undefined,
  };
}
