import type { TerminalAttachEvent } from "./PtyTerminalView";

type SnapshotEvent = Extract<TerminalAttachEvent, { readonly type: "snapshot" | "restarted" }>;
type OutputEvent = Extract<TerminalAttachEvent, { readonly type: "output" }>;
export interface TerminalOutputState {
  readonly latestSnapshot?: SnapshotEvent;
  readonly history: string;
  readonly outputs: ReadonlyArray<OutputEvent>;
  readonly hasSnapshot: boolean;
  readonly truncated: boolean;
  readonly status: "waiting" | "attached" | "exited" | "closed" | "error";
  readonly error?: string;
}
export function beginTerminalOutput(current?: TerminalOutputState): TerminalOutputState {
  return {
    history: "",
    outputs: [],
    truncated: false,
    ...current,
    hasSnapshot: false,
    status: "waiting",
    error: undefined,
  };
}
export function appendTerminalOutput(
  current: TerminalOutputState | undefined,
  event: TerminalAttachEvent,
): TerminalOutputState {
  const state = current ?? beginTerminalOutput();
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return {
        latestSnapshot: event,
        history: event.snapshot.history,
        outputs: [],
        hasSnapshot: true,
        truncated: false,
        status: "attached",
      };
    case "output":
      return {
        ...state,
        outputs: [...state.outputs.slice(-99), event],
        truncated: state.truncated || state.outputs.length >= 100,
      };
    case "cleared":
      return { ...state, history: "", outputs: [], truncated: false };
    case "exited":
    case "closed":
      return { ...state, status: event.type };
    case "error":
      return { ...state, status: "error", error: event.message };
    case "activity":
      return state;
  }
}
export function terminalOutputPresentation(state: TerminalOutputState | undefined) {
  return {
    text: (state?.history ?? "") + (state?.outputs ?? []).map((event) => event.data).join(""),
    ready: state?.hasSnapshot === true,
    truncated: state?.truncated === true,
    status: state?.status ?? "waiting",
    error: state?.error,
  };
}
