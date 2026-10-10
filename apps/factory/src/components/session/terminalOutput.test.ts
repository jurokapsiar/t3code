import { describe, expect, it } from "vite-plus/test";
import type { TerminalAttachEvent } from "./PtyTerminalView";
import {
  appendTerminalOutput,
  beginTerminalOutput,
  terminalOutputPresentation,
} from "./terminalOutput";

const snapshot: TerminalAttachEvent = {
  type: "snapshot",
  snapshot: {
    threadId: "thread",
    terminalId: "terminal",
    cwd: "/work",
    worktreePath: null,
    status: "running",
    pid: 123,
    history: "Initial snapshot history\n",
    exitCode: null,
    exitSignal: null,
    label: "Shell",
    updatedAt: "2026-10-04T10:00:00Z",
  },
};
const output = (index: number): TerminalAttachEvent => ({
  type: "output",
  threadId: "thread",
  terminalId: "terminal",
  data: `output-${index}\n`,
});
describe("terminal output retention", () => {
  it("keeps attachment and snapshot history after 100 events and explicitly reports bounded truncation", () => {
    let state = appendTerminalOutput(undefined, snapshot);
    for (let i = 1; i <= 100; i += 1) state = appendTerminalOutput(state, output(i));
    expect(terminalOutputPresentation(state)).toMatchObject({
      ready: true,
      status: "attached",
      truncated: false,
    });
    expect(terminalOutputPresentation(state).text).toContain("Initial snapshot history\n");
    state = appendTerminalOutput(state, output(101));
    const view = terminalOutputPresentation(state);
    expect(view).toMatchObject({ ready: true, status: "attached", truncated: true });
    expect(view.text).not.toContain("output-1\n");
    expect(view.text).toContain("output-2\n");
    expect(view.text).toContain("output-101\n");
    expect(view.text).toContain("Initial snapshot history\n");
  });
  it("retains truthful clear, exit, and error presentation without terminal mutations", () => {
    let state = appendTerminalOutput(undefined, snapshot);
    state = appendTerminalOutput(state, output(1));
    state = appendTerminalOutput(state, {
      type: "cleared",
      threadId: "thread",
      terminalId: "terminal",
    });
    expect(terminalOutputPresentation(state)).toMatchObject({
      ready: true,
      text: "",
      truncated: false,
    });
    state = appendTerminalOutput(state, {
      type: "exited",
      threadId: "thread",
      terminalId: "terminal",
      exitCode: 0,
      exitSignal: null,
    });
    expect(terminalOutputPresentation(state).status).toBe("exited");
    state = appendTerminalOutput(state, {
      type: "error",
      threadId: "thread",
      terminalId: "terminal",
      message: "Source failure",
    });
    expect(terminalOutputPresentation(state)).toMatchObject({
      status: "error",
      error: "Source failure",
    });
  });
  it("requires a new snapshot after an explicit new attachment while retaining cached history", () => {
    let state = appendTerminalOutput(undefined, snapshot);
    state = appendTerminalOutput(state, output(1));
    state = beginTerminalOutput(state);
    expect(terminalOutputPresentation(state)).toMatchObject({ ready: false, status: "waiting" });
    expect(terminalOutputPresentation(state).text).toContain("Initial snapshot history");
    state = appendTerminalOutput(state, snapshot);
    expect(terminalOutputPresentation(state)).toMatchObject({
      ready: true,
      status: "attached",
      truncated: false,
    });
    expect(terminalOutputPresentation(state).text).not.toContain("output-1");
  });
});
