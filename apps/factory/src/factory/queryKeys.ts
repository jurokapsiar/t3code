import type { FactoryFrameTarget } from "@t3tools/contracts/factory";

export interface ThreadTarget {
  readonly registrationId?: string;
  readonly environmentId: string;
  readonly threadId: string;
}

export function targetKey(target: ThreadTarget): string {
  return JSON.stringify([target.environmentId, target.threadId]);
}

export function frameTargetKey(target: FactoryFrameTarget): string {
  return JSON.stringify([target.registrationId, target.environmentId, target.threadId]);
}

function sourceKey(factoryId: string, environmentId: string, registrationId: string) {
  return ["factory", factoryId, "source", registrationId, environmentId] as const;
}

export function threadDetailKey(
  factoryId: string,
  environmentId: string,
  threadId: string,
  registrationId: string,
) {
  return [
    ...sourceKey(factoryId, environmentId, registrationId),
    "thread-detail",
    threadId,
  ] as const;
}

export const factoryKeys = {
  root: (factoryId: string) => ["factory", factoryId] as const,
  overview: (factoryId: string) => ["factory", factoryId, "overview"] as const,
  environments: (factoryId: string) => ["factory", factoryId, "environments"] as const,
  groups: (factoryId: string) => ["factory", factoryId, "groups"] as const,
  sourceConfig: (factoryId: string, environmentId: string, registrationId: string) =>
    [...sourceKey(factoryId, environmentId, registrationId), "config"] as const,
  controlAdmission: (
    factoryId: string,
    environmentId: string,
    sourceSessionId: number,
    operation: string,
    registrationId: string,
  ) =>
    [
      ...sourceKey(factoryId, environmentId, registrationId),
      "control-admission",
      sourceSessionId,
      operation,
    ] as const,
  thread: (factoryId: string, target: ThreadTarget) =>
    [
      ...sourceKey(factoryId, target.environmentId, target.registrationId ?? ""),
      "thread",
      target.threadId,
    ] as const,
  threadTarget: (factoryId: string, target: ThreadTarget) =>
    [
      ...sourceKey(factoryId, target.environmentId, target.registrationId ?? ""),
      "target",
      targetKey(target),
    ] as const,
  embeddedRoute: (factoryId: string, target: FactoryFrameTarget) =>
    [
      "factory",
      factoryId,
      "embedded-route",
      target.registrationId,
      target.environmentId,
      target.threadId,
    ] as const,
};

/** Match the complete Factory/registration/environment identity, never a local thread ID. */
export function isProtectedSourceQuery(
  key: readonly unknown[],
  factoryId: string,
  target: { readonly registrationId: string; readonly environmentId: string },
): boolean {
  if (key[0] !== "factory" || key[1] !== factoryId) return false;
  if (key[2] === "source" || key[2] === "embedded-route") {
    return key[3] === target.registrationId && key[4] === target.environmentId;
  }
  return false;
}
