import type * as Effect from "effect/Effect";
import type { SourceRpcClient } from "../../factory/sourceSessions";

type SourceConfig = Effect.Success<ReturnType<SourceRpcClient["server.getConfig"]>>;
type SourceModel = SourceConfig["providers"][number]["models"][number];
export type ModelOptionDescriptor = NonNullable<
  NonNullable<SourceModel["capabilities"]>["optionDescriptors"]
>[number];
export type ModelOptionValues = Readonly<Record<string, string | boolean>>;

export function projectIdentity(project: {
  readonly environmentId: string;
  readonly projectId: string;
}): string {
  return JSON.stringify([project.environmentId, project.projectId]);
}

export function defaultModelOptionValue(option: ModelOptionDescriptor): string | boolean {
  if (option.type === "boolean") return option.currentValue ?? false;
  const currentValue = option.currentValue;
  if (currentValue !== undefined && option.options.some((choice) => choice.id === currentValue))
    return currentValue;
  return option.options.find((choice) => choice.isDefault)?.id ?? option.options[0]?.id ?? "";
}

export function resolveModelOptions(
  descriptors: readonly ModelOptionDescriptor[],
  selected: ModelOptionValues,
): Array<{ readonly id: string; readonly value: string | boolean }> {
  const values: Array<{ readonly id: string; readonly value: string | boolean }> = [];
  for (const option of descriptors) {
    if (option.type === "boolean") {
      const candidate = selected[option.id];
      values.push({
        id: option.id,
        value: typeof candidate === "boolean" ? candidate : (option.currentValue ?? false),
      });
      continue;
    }
    if (option.options.length === 0) continue;
    const candidate = selected[option.id];
    const value =
      typeof candidate === "string" && option.options.some((choice) => choice.id === candidate)
        ? candidate
        : defaultModelOptionValue(option);
    if (typeof value === "string" && value.length > 0) values.push({ id: option.id, value });
  }
  return values;
}
