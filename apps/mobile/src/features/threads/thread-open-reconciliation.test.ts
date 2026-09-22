import { describe, expect, it } from "vite-plus/test";

import { openCodeReconcileKey } from "@t3tools/client-runtime/state/opencode";

describe("mobile OpenCode thread reconciliation", () => {
  it("routes only existing OpenCode threads to reconciliation", () => {
    expect(
      openCodeReconcileKey({
        isServerThread: true,
        providerName: "opencode",
        environmentId: "environment",
        threadId: "thread",
        providerInstanceId: "opencode",
      }),
    ).toBe("environment:thread:opencode");
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
