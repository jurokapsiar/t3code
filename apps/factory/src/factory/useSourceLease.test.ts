import { describe, expect, it } from "vite-plus/test";
import { renderSourceLeaseState, sourceLeaseForTarget } from "./useSourceLease";
import type { SourceLease } from "./sourceSessions";

describe("synchronous source lease ownership", () => {
  const owner = {};
  const replacementOwner = {};
  const lease = { environmentId: "env-a", status: { phase: "online" } } as SourceLease;
  const state = { owner, environmentId: "env-a", lease, status: { phase: "online" as const } };

  it("hides the previous online lease on the render before the environment effect resets", () => {
    expect(renderSourceLeaseState(state, owner, "env-a", true).lease).toBe(lease);
    const next = renderSourceLeaseState(state, owner, "env-b", true);
    expect(next.lease).toBeUndefined();
    expect(next.status.phase).toBe("connecting");
    expect(
      sourceLeaseForTarget(next.lease, { environmentId: "env-b", threadId: "same" }),
    ).toBeUndefined();
  });

  it("hides a same-environment lease when the connection owner changes before effects", () => {
    expect(renderSourceLeaseState(state, replacementOwner, "env-a", true).lease).toBeUndefined();
  });

  it("does not expose a disabled lease or a lease with a mismatched environment identity", () => {
    expect(renderSourceLeaseState(state, owner, "env-a", false)).toEqual({
      status: { phase: "offline" },
    });
    expect(
      renderSourceLeaseState({ ...state, environmentId: "env-b" }, owner, "env-b", true).lease,
    ).toBeUndefined();
  });

  it("guards query and stream consumers even when they receive a mismatched or offline lease", () => {
    expect(
      sourceLeaseForTarget(lease, { environmentId: "env-b", threadId: "same" }),
    ).toBeUndefined();
    expect(sourceLeaseForTarget(lease, { environmentId: "env-a", threadId: "same" })).toBe(lease);
    expect(
      sourceLeaseForTarget(
        { ...lease, registrationId: "old" as SourceLease["registrationId"] },
        { registrationId: "replacement", environmentId: "env-a", threadId: "same" },
      ),
    ).toBeUndefined();
    expect(
      sourceLeaseForTarget(
        { ...lease, status: { phase: "offline" } },
        { environmentId: "env-a", threadId: "same" },
      ),
    ).toBeUndefined();
  });
});
