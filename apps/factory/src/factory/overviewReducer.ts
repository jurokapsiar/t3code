import type {
  FactoryOverviewEvent,
  FactoryOverviewSnapshot,
  FactoryProjectSummary,
} from "@t3tools/contracts/factory";
import { targetKey } from "./queryKeys";

export type OverviewResetReason =
  | "missing-snapshot"
  | "generation-changed"
  | "revision-gap"
  | "invalid-snapshot"
  | "invalid-patch";

export type OverviewApplyResult =
  | { readonly kind: "applied"; readonly value: FactoryOverviewSnapshot }
  | { readonly kind: "ignored" }
  | { readonly kind: "reset-required"; readonly reason: OverviewResetReason };

function resetRequired(reason: OverviewResetReason): OverviewApplyResult {
  return { kind: "reset-required", reason };
}

function projectKey(project: Pick<FactoryProjectSummary, "key">): string {
  return JSON.stringify([project.key.environmentId, project.key.projectId]);
}

function applyKeyedChanges<T>(
  current: ReadonlyArray<T>,
  upserts: ReadonlyArray<T>,
  removals: ReadonlyArray<string>,
  keyOf: (value: T) => string,
): ReadonlyArray<T> | undefined {
  const values = new Map(current.map((value) => [keyOf(value), value]));
  const upsertKeys = new Set<string>();
  for (const value of upserts) {
    const key = keyOf(value);
    if (upsertKeys.has(key)) return undefined;
    upsertKeys.add(key);
  }

  const removalKeys = new Set<string>();
  for (const key of removals) {
    if (removalKeys.has(key) || !values.has(key) || upsertKeys.has(key)) return undefined;
    removalKeys.add(key);
  }

  for (const key of removalKeys) values.delete(key);
  for (const value of upserts) values.set(keyOf(value), value);
  return [...values.values()];
}

function applyPatch(
  current: FactoryOverviewSnapshot,
  event: Extract<FactoryOverviewEvent, { readonly type: "patch" }>,
): FactoryOverviewSnapshot | undefined {
  switch (event.patch.kind) {
    case "threads": {
      const threads = applyKeyedChanges(
        current.threads,
        event.patch.upserts,
        event.patch.removals.map(targetKey),
        (thread) => targetKey(thread.key),
      );
      return threads === undefined ? undefined : { ...current, revision: event.revision, threads };
    }
    case "projects": {
      const projects = applyKeyedChanges(
        current.projects,
        event.patch.upserts,
        event.patch.removals.map(projectKey),
        projectKey,
      );
      return projects === undefined
        ? undefined
        : { ...current, revision: event.revision, projects };
    }
    case "environments": {
      const environments = applyKeyedChanges(
        current.environments,
        event.patch.upserts,
        event.patch.removals,
        (environment) => environment.registrationId,
      );
      return environments === undefined
        ? undefined
        : { ...current, revision: event.revision, environments };
    }
    case "sourceFreshness": {
      const sourceFreshness = applyKeyedChanges(
        current.sourceFreshness,
        event.patch.upserts,
        event.patch.removals.map((target) =>
          JSON.stringify([target.registrationId, target.environmentId]),
        ),
        (freshness) =>
          JSON.stringify([freshness.target.registrationId, freshness.target.environmentId]),
      );
      return sourceFreshness === undefined
        ? undefined
        : { ...current, revision: event.revision, sourceFreshness };
    }
    case "metadata":
      return {
        ...current,
        revision: event.revision,
        groups: event.patch.groups,
        memberships: event.patch.memberships,
        favorites: event.patch.favorites,
      };
  }
}

export function applyOverviewEvent(
  cache: FactoryOverviewSnapshot | undefined,
  event: FactoryOverviewEvent,
): OverviewApplyResult {
  if (event.type === "snapshot") {
    if (
      !event.snapshot.generation ||
      !Number.isSafeInteger(event.snapshot.revision) ||
      event.snapshot.revision < 0
    ) {
      return resetRequired("invalid-snapshot");
    }
    return { kind: "applied", value: event.snapshot };
  }

  if (cache === undefined) return resetRequired("missing-snapshot");
  if (event.generation !== cache.generation) return resetRequired("generation-changed");
  if (!Number.isSafeInteger(event.revision) || event.revision < 0)
    return resetRequired("invalid-patch");
  if (event.revision <= cache.revision) return { kind: "ignored" };
  if (event.revision !== cache.revision + 1) return resetRequired("revision-gap");

  const value = applyPatch(cache, event);
  return value === undefined ? resetRequired("invalid-patch") : { kind: "applied", value };
}
