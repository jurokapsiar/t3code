import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isBlockingSourceAction, sourceActionScopeKey } from "./actionPolicy";
import type {
  SourceActionObservation,
  SourceActionRegistry,
  SourceActionScope,
} from "./actionPolicy";

/**
 * Reads the connection-owned records for one action scope and applies fresh source evidence.
 * Pass an observation only when it comes from a fresh, complete source read.
 */
export function useSourceActions(
  registry: SourceActionRegistry,
  scope: SourceActionScope,
  observation: SourceActionObservation | undefined,
) {
  const key = sourceActionScopeKey(scope);
  // The key fully identifies the scope; keep the object stable for the reconcile effect.
  const stableScope = useMemo(() => scope, [key]);
  const records = useSyncExternalStore(
    registry.subscribe,
    () => registry.records(key),
    () => registry.records(key),
  );
  useEffect(() => {
    if (observation !== undefined) registry.reconcile(stableScope, observation);
  }, [observation, records, registry, stableScope]);
  return { records, blocking: records.find(isBlockingSourceAction) };
}
