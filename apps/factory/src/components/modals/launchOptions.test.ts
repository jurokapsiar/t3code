import { describe, expect, it } from "vite-plus/test";
import {
  defaultModelOptionValue,
  projectIdentity,
  resolveModelOptions,
  type ModelOptionDescriptor,
} from "./launchOptions";

const options: readonly ModelOptionDescriptor[] = [
  {
    id: "reasoning",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ],
  },
  { id: "search", label: "Search", type: "boolean", currentValue: false },
  { id: "empty", label: "Unsupported select", type: "select", options: [] },
];

describe("source model launch options", () => {
  it("keeps identical local project IDs distinct across source environments", () => {
    expect(projectIdentity({ environmentId: "source-a", projectId: "same" })).not.toBe(
      projectIdentity({ environmentId: "source-b", projectId: "same" }),
    );
    expect(projectIdentity({ environmentId: "a:b", projectId: "c" })).not.toBe(
      projectIdentity({ environmentId: "a", projectId: "b:c" }),
    );
  });
  it("defaults every advertised option type and preserves false boolean values", () => {
    expect(defaultModelOptionValue(options[0]!)).toBe("high");
    expect(defaultModelOptionValue(options[1]!)).toBe(false);
    expect(resolveModelOptions(options, {})).toEqual([
      { id: "reasoning", value: "high" },
      { id: "search", value: false },
    ]);
  });

  it("uses only source-issued select values and retains explicit boolean choices", () => {
    expect(
      resolveModelOptions(options, { reasoning: "low", search: true, empty: "invented" }),
    ).toEqual([
      { id: "reasoning", value: "low" },
      { id: "search", value: true },
    ]);
    expect(resolveModelOptions(options, { reasoning: "invented" })).toEqual([
      { id: "reasoning", value: "high" },
      { id: "search", value: false },
    ]);
  });
});
