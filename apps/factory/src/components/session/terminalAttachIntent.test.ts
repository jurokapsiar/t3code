import { describe, expect, it } from "vite-plus/test";
import {
  createTerminalAttachIntent,
  isTerminalAttachRequested,
  syncTerminalAttachIntent,
  terminalAttachIdentity,
  toggleTerminalAttachIntent,
} from "./terminalAttachIntent";

describe("terminal output attachment intent", () => {
  it("requires a new explicit attach after switching away from a terminal and back", () => {
    const target = JSON.stringify(["registration-a", "environment-a", "thread-a"]);
    const terminalA = terminalAttachIdentity(target, "pty-a", 1);
    const terminalB = terminalAttachIdentity(target, "pty-b", 1);
    let intent = toggleTerminalAttachIntent(createTerminalAttachIntent(terminalA), terminalA);

    expect(isTerminalAttachRequested(intent)).toBe(true);
    intent = syncTerminalAttachIntent(intent, terminalB);
    expect(isTerminalAttachRequested(intent)).toBe(false);
    intent = syncTerminalAttachIntent(intent, terminalA);
    expect(isTerminalAttachRequested(intent)).toBe(false);
  });

  it("clears attachment intent when the target or source session changes", () => {
    const target = JSON.stringify(["registration-a", "environment-a", "thread-a"]);
    const otherTarget = JSON.stringify(["registration-b", "environment-b", "thread-b"]);
    const firstSession = terminalAttachIdentity(target, "pty-a", 1);
    const otherTargetSession = terminalAttachIdentity(otherTarget, "pty-a", 1);
    const replacementSession = terminalAttachIdentity(target, "pty-a", 2);
    const attached = toggleTerminalAttachIntent(
      createTerminalAttachIntent(firstSession),
      firstSession,
    );

    expect(isTerminalAttachRequested(syncTerminalAttachIntent(attached, otherTargetSession))).toBe(
      false,
    );
    expect(isTerminalAttachRequested(syncTerminalAttachIntent(attached, replacementSession))).toBe(
      false,
    );
  });

  it("supports explicit attach and detach intent transitions", () => {
    const identity = terminalAttachIdentity("target", "pty-a", 1);
    const detached = createTerminalAttachIntent(identity);
    const attached = toggleTerminalAttachIntent(detached, identity);

    expect(isTerminalAttachRequested(attached)).toBe(true);
    expect(isTerminalAttachRequested(toggleTerminalAttachIntent(attached, identity))).toBe(false);
  });
});
