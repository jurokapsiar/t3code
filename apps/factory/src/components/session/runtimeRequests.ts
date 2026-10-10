import type { SourceRpcClient } from "../../factory/sourceSessions";
import type { BoundedSnapshot } from "../../factory/sourceDetailApi";

type SourceRuntimeRequest = BoundedSnapshot["projection"]["runtimeRequests"][number];
type SourceTurnItem = BoundedSnapshot["projection"]["visibleTurnItems"][number]["item"];
type ApprovalRequestDetail = Pick<
  Extract<SourceTurnItem, { readonly type: "approval_request" }>,
  "type" | "requestId" | "requestKind" | "options" | "prompt" | "appName"
>;
type UserInputRequestDetail = Pick<
  Extract<SourceTurnItem, { readonly type: "user_input_request" }>,
  "type" | "requestId" | "questions"
>;

export type RuntimeRequestSummary = Pick<
  SourceRuntimeRequest,
  "id" | "kind" | "status" | "responseCapability" | "decision"
>;
export type RuntimeRequestDetail = ApprovalRequestDetail | UserInputRequestDetail;
export type RuntimeRequestResponseCommand = Extract<
  Parameters<SourceRpcClient["orchestration.dispatchCommand"]>[0],
  { readonly type: "runtime-request.respond" }
>;

export interface RuntimeRequestView {
  readonly request: RuntimeRequestSummary;
  readonly detail?: RuntimeRequestDetail;
  readonly actionable: boolean;
}

export function describeRuntimeRequests(
  summaries: readonly RuntimeRequestSummary[],
  details: readonly RuntimeRequestDetail[],
): RuntimeRequestView[] {
  const detailsById = new Map(details.map((detail) => [detail.requestId, detail]));
  const requestsById = new Map(summaries.map((request) => [request.id, request]));

  return Array.from(requestsById.values(), (request) => {
    const detail = detailsById.get(request.id);
    const hasChoices =
      detail?.type === "approval_request"
        ? (detail.options?.length ?? 0) > 0
        : detail?.type === "user_input_request" &&
          detail.questions.length > 0 &&
          !detail.questions.some(
            (question) =>
              question.required === true &&
              question.multiSelect === true &&
              question.options.length === 0 &&
              question.allowCustomAnswer !== true,
          );
    return {
      request,
      ...(detail ? { detail } : {}),
      actionable:
        request.status === "pending" &&
        request.responseCapability.type !== "not_resumable" &&
        hasChoices,
    };
  });
}

type AnswerInput = Readonly<Record<string, string | readonly string[]>>;

export type AnswerValidation =
  | { readonly ok: true; readonly answers: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason:
        | "not-user-input"
        | "unknown-question"
        | "required"
        | "invalid-option"
        | "invalid-shape";
      readonly questionIds: readonly string[];
    };

export function prepareUserInputAnswers(
  detail: RuntimeRequestDetail,
  input: AnswerInput,
): AnswerValidation {
  if (detail.type !== "user_input_request") {
    return { ok: false, reason: "not-user-input", questionIds: [] };
  }

  const questionsById = new Map(detail.questions.map((question) => [question.id, question]));
  const unknownQuestions = Object.keys(input).filter((id) => !questionsById.has(id));
  if (unknownQuestions.length) {
    return { ok: false, reason: "unknown-question", questionIds: unknownQuestions };
  }

  const answers: Record<string, unknown> = {};
  const missingRequired: string[] = [];
  const invalidOptions: string[] = [];
  const invalidShape: string[] = [];

  for (const question of detail.questions) {
    const value = input[question.id];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      if (question.required === true) missingRequired.push(question.id);
      continue;
    }

    const allowedValues = new Set(question.options.map((option) => option.value ?? option.label));
    if (Array.isArray(value)) {
      if (question.multiSelect !== true) {
        invalidShape.push(question.id);
        continue;
      }
      if (!question.allowCustomAnswer && value.some((answer) => !allowedValues.has(answer))) {
        invalidOptions.push(question.id);
        continue;
      }
      answers[question.id] = [...value];
      continue;
    }

    if (question.multiSelect === true) {
      invalidShape.push(question.id);
      continue;
    }
    if (typeof value !== "string") {
      invalidShape.push(question.id);
      continue;
    }
    if (question.options.length === 0) {
      answers[question.id] = value;
      continue;
    }
    if (value.length > 0 && !question.allowCustomAnswer && !allowedValues.has(value)) {
      invalidOptions.push(question.id);
      continue;
    }
    answers[question.id] = value;
  }

  if (missingRequired.length)
    return { ok: false, reason: "required", questionIds: missingRequired };
  if (invalidShape.length) return { ok: false, reason: "invalid-shape", questionIds: invalidShape };
  if (invalidOptions.length)
    return { ok: false, reason: "invalid-option", questionIds: invalidOptions };
  return { ok: true, answers };
}

export function makeRuntimeRequestResponse(input: {
  readonly commandId: RuntimeRequestResponseCommand["commandId"];
  readonly threadId: RuntimeRequestResponseCommand["threadId"];
  readonly requestId: RuntimeRequestResponseCommand["requestId"];
  readonly decision?: NonNullable<RuntimeRequestResponseCommand["decision"]>;
  readonly answers?: Readonly<Record<string, unknown>>;
}): RuntimeRequestResponseCommand {
  if ((input.decision === undefined) === (input.answers === undefined)) {
    throw new Error("A runtime response must contain exactly one decision or answer set.");
  }
  return {
    type: "runtime-request.respond",
    commandId: input.commandId,
    threadId: input.threadId,
    requestId: input.requestId,
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(input.answers === undefined ? {} : { answers: { ...input.answers } }),
  };
}
