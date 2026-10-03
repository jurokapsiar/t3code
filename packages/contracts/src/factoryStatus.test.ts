import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { classifyFactoryState, factoryStateInputFromShell } from "./factoryStatus.ts";

describe("classifyFactoryState", () => {
  it.each([
    ["preparing", "active"],
    ["queued", "active"],
    ["starting", "active"],
    ["running", "active"],
    ["waiting", "waiting"],
    ["failed", "failed"],
    ["completed", "finished"],
    ["interrupted", "cancelled"],
    ["cancelled", "cancelled"],
    ["rolled_back", "idle"],
    ["idle", "idle"],
    ["missing", "unknown"],
    ["incompatible", "unknown"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(classifyFactoryState({ status, hasPendingRequest: false, settled: false })).toBe(
      expected,
    );
  });

  it("gives pending requests precedence over running status and settlement", () => {
    expect(
      classifyFactoryState({ status: "running", hasPendingRequest: true, settled: true }),
    ).toBe("waiting");
  });

  it("keeps live source work active when settlement metadata is present", () => {
    expect(
      classifyFactoryState({ status: "queued", hasPendingRequest: false, settled: true }),
    ).toBe("active");
  });

  it("distinguishes settled completion from completion awaiting finalization", () => {
    expect(
      classifyFactoryState({ status: "completed", hasPendingRequest: false, settled: true }),
    ).toBe("settled");
    expect(
      classifyFactoryState({ status: "completed", hasPendingRequest: false, settled: false }),
    ).toBe("finished");
  });
  it("adapts shell settlement overrides without treating an active override as settled", () => {
    expect(
      factoryStateInputFromShell({
        status: "running",
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        settledAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
        settledOverride: "active",
      }),
    ).toEqual({ status: "running", hasPendingRequest: false, settled: false });
  });

  it("classifies source-normalized failures separately from unavailable data", () => {
    expect(
      classifyFactoryState({ status: "failed", hasPendingRequest: false, settled: false }),
    ).toBe("failed");
    expect(
      classifyFactoryState({ status: "missing", hasPendingRequest: false, settled: false }),
    ).toBe("unknown");
    expect(
      classifyFactoryState({ status: "incompatible", hasPendingRequest: false, settled: false }),
    ).toBe("unknown");
  });
});
