import { useEffect, useState, useSyncExternalStore } from "react";
import type { FactoryConnectionApi } from "./FactoryConnection";
import type { SourceLease, SourceSessionStatus } from "./sourceSessions";
import type { ThreadTarget } from "./queryKeys";

export interface SourceLeaseState {
  readonly lease?: SourceLease;
  readonly status: SourceSessionStatus;
  readonly error?: string;
}

export interface OwnedSourceLeaseState extends SourceLeaseState {
  readonly owner: object;
  readonly environmentId: string;
}

export function renderSourceLeaseState(
  state: OwnedSourceLeaseState,
  owner: object,
  environmentId: string,
  enabled: boolean,
): SourceLeaseState {
  if (!enabled) return { status: { phase: "offline" } };
  if (
    state.owner !== owner ||
    state.environmentId !== environmentId ||
    (state.lease !== undefined && state.lease.environmentId !== environmentId)
  ) {
    return { status: { phase: "connecting" } };
  }
  return { lease: state.lease, status: state.status, error: state.error };
}

export function sourceLeaseForTarget(
  lease: SourceLease | undefined,
  target: ThreadTarget,
): SourceLease | undefined {
  return lease?.environmentId === target.environmentId &&
    (target.registrationId === undefined || lease.registrationId === target.registrationId) &&
    lease.status.phase === "online"
    ? lease
    : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "The source detail request failed.";
}

export function useSourceLease(
  connection: FactoryConnectionApi,
  environmentId: string,
  enabled: boolean,
): SourceLeaseState {
  const blocked = useSyncExternalStore(
    (listener) => connection.subscribeSourceAccess(() => listener()),
    () => connection.isSourceBlocked(environmentId),
    () => connection.isSourceBlocked(environmentId),
  );
  const [state, setState] = useState<OwnedSourceLeaseState>({
    owner: connection,
    environmentId,
    status: { phase: "offline" },
  });

  useEffect(() => {
    if (!enabled) {
      setState({ owner: connection, environmentId, status: { phase: "offline" } });
      return;
    }
    return observeSourceLease(connection, environmentId, setState).dispose;
  }, [connection, enabled, environmentId]);

  if (blocked)
    return {
      status: { phase: "blocked" },
      error: "Access to the source is blocked. Re-enroll it in Nodes.",
    };
  return renderSourceLeaseState(state, connection, environmentId, enabled);
}

export function observeSourceLease(
  connection: Pick<FactoryConnectionApi, "acquireSource"> &
    Partial<Pick<FactoryConnectionApi, "subscribeSourceAccess">>,
  environmentId: string,
  update: (state: OwnedSourceLeaseState) => void,
) {
  const controller = new AbortController();
  let lease: SourceLease | undefined;
  let unsubscribe = () => {};
  const publish = (state: SourceLeaseState) => {
    if (!controller.signal.aborted) update({ ...state, owner: connection, environmentId });
  };
  let generation = 0;
  let settled: Promise<void>;
  const acquire = () => {
    const current = ++generation;
    unsubscribe();
    lease?.release();
    lease = undefined;
    publish({ status: { phase: "connecting" } });
    return connection
      .acquireSource(environmentId, { signal: controller.signal })
      .then((acquired) => {
        if (controller.signal.aborted || current !== generation) {
          acquired.release();
          return;
        }
        if (acquired.environmentId !== environmentId) {
          acquired.release();
          throw new Error("The source lease does not match this environment.");
        }
        lease = acquired;
        unsubscribe = acquired.subscribeStatus((status) =>
          publish({
            lease: acquired,
            status,
            ...(status.error === undefined ? {} : { error: errorMessage(status.error) }),
          }),
        );
      })
      .catch((error) => {
        if (current !== generation) return;
        const reason =
          typeof error === "object" && error !== null && "reason" in error
            ? error.reason
            : undefined;
        const blocked = [
          "authorization",
          "identity-mismatch",
          "protocol-mismatch",
          "invalid-route",
          "ambiguous-environment",
          "unsupported-fixture",
        ].includes(String(reason));
        publish({
          status: { phase: blocked ? "blocked" : "offline", error },
          error: errorMessage(error),
        });
      });
  };
  const unsubscribeAccess = connection.subscribeSourceAccess?.((event) => {
    if (event.target.environmentId !== environmentId || controller.signal.aborted) return;
    if (event.state === "retry" || event.state === "ready") settled = acquire();
    else {
      generation += 1;
      unsubscribe();
      lease?.release();
      lease = undefined;
      publish({
        status: { phase: "blocked" },
        error: "Access to the source is blocked. Re-enroll it in Nodes.",
      });
    }
  });
  settled = acquire();
  return {
    get settled() {
      return settled;
    },
    dispose() {
      controller.abort();
      unsubscribe();
      unsubscribeAccess?.();
      lease?.release();
    },
  };
}
