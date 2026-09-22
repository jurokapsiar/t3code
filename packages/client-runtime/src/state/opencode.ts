import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function openCodeReconcileKey(input: {
  readonly isServerThread: boolean;
  readonly providerName: string | null | undefined;
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
}): string | null {
  if (!input.isServerThread || input.providerName !== "opencode") return null;
  return `${input.environmentId}:${input.threadId}:${input.providerInstanceId}`;
}

export function openCodeReconcileKeyAfterResult(input: {
  readonly currentKey: string | null;
  readonly attemptKey: string;
  readonly status: "deferred" | "reconciled" | "failed";
}): string | null {
  if (input.currentKey !== input.attemptKey) return input.currentKey;
  return input.status === "reconciled" ? input.currentKey : null;
}

export function shouldReconcileOpenCodeThread(input: {
  readonly isServerThread: boolean;
  readonly providerName: string | null | undefined;
  readonly sessionStatus:
    | "idle"
    | "starting"
    | "ready"
    | "running"
    | "error"
    | "stopped"
    | "interrupted";
  readonly activeTurnId: string | null | undefined;
}): boolean {
  return (
    input.isServerThread &&
    input.providerName === "opencode" &&
    input.sessionStatus === "ready" &&
    input.activeTurnId == null
  );
}

export function createOpenCodeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  return {
    sessions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider:opencode-sessions",
      tag: WS_METHODS.opencodeListSessions,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    sessionMessages: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider:opencode-session-messages",
      tag: WS_METHODS.opencodeGetSessionMessages,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    reconcileThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:opencode-reconcile-thread",
      tag: WS_METHODS.opencodeReconcileThread,
    }),
  };
}
