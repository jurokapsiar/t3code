import { describe, expect, it } from "vite-plus/test";
import {
  describeRuntimeRequests,
  makeRuntimeRequestResponse,
  prepareUserInputAnswers,
  type RuntimeRequestDetail,
  type RuntimeRequestResponseCommand,
  type RuntimeRequestSummary,
} from "./runtimeRequests";

const requestId = (id: string) => id as RuntimeRequestSummary["id"];
const commandId = (id: string) => id as RuntimeRequestResponseCommand["commandId"];
const threadId = (id: string) => id as RuntimeRequestResponseCommand["threadId"];

function request(overrides: Partial<RuntimeRequestSummary> = {}): RuntimeRequestSummary {
  return {
    id: requestId("request-1"),
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    ...overrides,
  };
}

function approvalDetail(
  requestId: RuntimeRequestSummary["id"],
  options: NonNullable<Extract<RuntimeRequestDetail, { type: "approval_request" }>["options"]>,
): RuntimeRequestDetail {
  return { type: "approval_request", requestId, requestKind: "command", options };
}

function userInputDetail(
  requestId: RuntimeRequestSummary["id"],
  questions: Extract<RuntimeRequestDetail, { type: "user_input_request" }>["questions"],
): RuntimeRequestDetail {
  return { type: "user_input_request", requestId, questions };
}

describe("source runtime requests", () => {
  it("keeps actual decision options and marks resolved or expired requests as read only", () => {
    const pending = request({ id: requestId("approval-1"), kind: "command" });
    const resolved = request({
      id: requestId("approval-2"),
      kind: "permission",
      status: "resolved",
      decision: "accept",
    });
    const expired = request({
      id: requestId("approval-3"),
      kind: "file-change",
      status: "expired",
    });
    const detail = approvalDetail(pending.id, [
      { decision: "accept", label: "Allow", warning: "This command can change files." },
      { decision: "decline", label: "Decline" },
    ]);

    const [first, second, third] = describeRuntimeRequests([pending, resolved, expired], [detail]);

    expect(first?.detail?.type === "approval_request" ? first.detail.options : undefined).toEqual(
      detail.type === "approval_request" ? detail.options : undefined,
    );
    expect(first?.actionable).toBe(true);
    expect(second?.actionable).toBe(false);
    expect(third?.actionable).toBe(false);
    expect(second?.request.status).toBe("resolved");
    expect(third?.request.status).toBe("expired");
  });

  it("deduplicates source request IDs without creating another request", () => {
    const first = request({ id: requestId("same-id"), status: "pending" });
    const resolved = request({ id: requestId("same-id"), status: "resolved", decision: "decline" });

    expect(describeRuntimeRequests([first, resolved], [])).toEqual([
      expect.objectContaining({ request: resolved, actionable: false }),
    ]);
  });

  it("builds single, multiple, and custom answers from source question options", () => {
    const detail = userInputDetail(requestId("questions-1"), [
      {
        id: "language",
        header: "Language",
        question: "Choose a language",
        required: true,
        options: [
          { label: "TypeScript", description: "", value: "ts" },
          { label: "JavaScript", description: "" },
        ],
      },
      {
        id: "checks",
        header: "Checks",
        question: "Choose checks",
        multiSelect: true,
        options: [
          { label: "Unit", description: "", value: "unit" },
          { label: "UI", description: "", value: "ui" },
        ],
      },
      {
        id: "notes",
        header: "Notes",
        question: "Add another option",
        allowCustomAnswer: true,
        options: [{ label: "Other", description: "" }],
      },
      {
        id: "summary",
        header: "Summary",
        question: "Describe the request",
        required: true,
        options: [],
      },
    ]);

    expect(
      prepareUserInputAnswers(detail, {
        language: "ts",
        checks: ["unit", "ui"],
        notes: "Use the project default",
        summary: "Keep the existing configuration",
      }),
    ).toEqual({
      ok: true,
      answers: {
        language: "ts",
        checks: ["unit", "ui"],
        notes: "Use the project default",
        summary: "Keep the existing configuration",
      },
    });
  });

  it("supports source-authorized custom multi-select answers without options", () => {
    const detail = userInputDetail(requestId("custom-multi-1"), [
      {
        id: "checks",
        header: "Checks",
        question: "Name checks",
        required: true,
        multiSelect: true,
        allowCustomAnswer: true,
        options: [],
      },
    ]);
    expect(prepareUserInputAnswers(detail, { checks: ["unit", "typecheck"] })).toEqual({
      ok: true,
      answers: { checks: ["unit", "typecheck"] },
    });
    expect(prepareUserInputAnswers(detail, { checks: "unit" })).toEqual({
      ok: false,
      reason: "invalid-shape",
      questionIds: ["checks"],
    });
  });

  it("requires a choice for a required question and rejects values not supplied by the source", () => {
    const detail = userInputDetail(requestId("questions-2"), [
      {
        id: "provider",
        header: "Provider",
        question: "Choose one",
        required: true,
        options: [{ label: "Codex", description: "", value: "codex" }],
      },
    ]);

    expect(prepareUserInputAnswers(detail, {})).toEqual({
      ok: false,
      reason: "required",
      questionIds: ["provider"],
    });
    expect(prepareUserInputAnswers(detail, { provider: "unknown" })).toEqual({
      ok: false,
      reason: "invalid-option",
      questionIds: ["provider"],
    });
  });

  it("disables an unanswerable required multi-select question", () => {
    const pending = request();
    const detail = userInputDetail(pending.id, [
      {
        id: "checks",
        header: "Checks",
        question: "Choose checks",
        required: true,
        multiSelect: true,
        options: [],
      },
    ]);
    expect(describeRuntimeRequests([pending], [detail])[0]?.actionable).toBe(false);
  });

  it("uses the source request ID and structured answer fields in the typed response command", () => {
    expect(
      makeRuntimeRequestResponse({
        commandId: commandId("command-1"),
        threadId: threadId("thread-1"),
        requestId: requestId("request-7"),
        answers: { language: "ts", checks: ["unit"] },
      }),
    ).toEqual({
      type: "runtime-request.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-7",
      answers: { language: "ts", checks: ["unit"] },
    });
  });
});
