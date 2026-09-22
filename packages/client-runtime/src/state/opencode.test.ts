import { describe, expect, it } from "vite-plus/test";

import {
  openCodeReconcileKey,
  openCodeReconcileKeyAfterResult,
  shouldReconcileOpenCodeThread,
} from "./opencode.ts";

describe("openCodeReconcileKey", () => {
  it("keys an existing OpenCode thread by environment, thread, and instance", () => {
    expect(
      openCodeReconcileKey({
        isServerThread: true,
        providerName: "opencode",
        environmentId: "environment",
        threadId: "thread",
        providerInstanceId: "opencode",
      }),
    ).toBe("environment:thread:opencode");
  });

  it("does not reconcile drafts or other providers", () => {
    expect(
      openCodeReconcileKey({
        isServerThread: false,
        providerName: "opencode",
        environmentId: "environment",
        threadId: "draft",
        providerInstanceId: "opencode",
      }),
    ).toBeNull();
    expect(
      openCodeReconcileKey({
        isServerThread: true,
        providerName: "codex",
        environmentId: "environment",
        threadId: "thread",
        providerInstanceId: "codex",
      }),
    ).toBeNull();
  });
});

describe("shouldReconcileOpenCodeThread", () => {
  it.each(["starting", "running"] as const)(
    "does not reconcile an OpenCode thread during %s",
    (status) => {
      expect(
        shouldReconcileOpenCodeThread({
          isServerThread: true,
          providerName: "opencode",
          sessionStatus: status,
          activeTurnId: null,
        }),
      ).toBe(false);
    },
  );

  it("reconciles an idle ready OpenCode thread", () => {
    expect(
      shouldReconcileOpenCodeThread({
        isServerThread: true,
        providerName: "opencode",
        sessionStatus: "ready",
        activeTurnId: null,
      }),
    ).toBe(true);
  });
});

describe("openCodeReconcileKeyAfterResult", () => {
  it("releases a deferred attempt so a ready-state transition can retry", () => {
    expect(
      openCodeReconcileKeyAfterResult({
        currentKey: "environment:thread:opencode",
        attemptKey: "environment:thread:opencode",
        status: "deferred",
      }),
    ).toBeNull();
  });

  it("keeps a completed attempt deduplicated", () => {
    expect(
      openCodeReconcileKeyAfterResult({
        currentKey: "environment:thread:opencode",
        attemptKey: "environment:thread:opencode",
        status: "reconciled",
      }),
    ).toBe("environment:thread:opencode");
  });
});
