import * as Schema from "effect/Schema";

import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { FactorySourceStatus, type FactoryThreadClassification } from "./factory.ts";

export const FactoryStateInput = Schema.Struct({
  status: FactorySourceStatus,
  hasPendingRequest: Schema.Boolean,
  settled: Schema.Boolean,
});
export type FactoryStateInput = typeof FactoryStateInput.Type;

export const classifyFactoryState = ({
  status,
  hasPendingRequest,
  settled,
}: FactoryStateInput): FactoryThreadClassification => {
  if (status === "missing" || status === "incompatible") return "unknown";
  if (hasPendingRequest || status === "waiting") return "waiting";
  if (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running"
  ) {
    return "active";
  }
  if (status === "failed") return "failed";
  if (settled) return "settled";
  if (status === "completed") return "finished";
  if (status === "interrupted" || status === "cancelled") return "cancelled";
  return "idle";
};

export const factoryStateInputFromShell = (
  thread: Pick<
    OrchestrationV2ThreadShell,
    "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks" | "settledAt" | "settledOverride"
  >,
): FactoryStateInput => ({
  status: thread.status,
  hasPendingRequest:
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks !== undefined && thread.pendingBackgroundTasks.length > 0),
  settled:
    thread.settledOverride === "settled" ||
    (thread.settledOverride !== "active" && thread.settledAt !== null),
});
