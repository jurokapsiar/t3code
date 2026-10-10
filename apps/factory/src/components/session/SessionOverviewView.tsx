import { useEffect, useMemo, useRef, useState } from "react";
import type { FactoryFrameTarget, FactoryThreadSummary } from "@t3tools/contracts/factory";
import { Badge, Button, Card } from "../../design-system/actions";
import { Checkbox, Field, Input, MessageBar, Select, Textarea } from "../../design-system/forms";
import {
  canControlSource,
  createCommandId,
  dispatchSourceCommand,
  sourceActionRecordText,
  threadActionObservation,
} from "../../factory/actionPolicy";
import type { SourceActionRegistry, SourceDispatchCommand } from "../../factory/actionPolicy";
import { useSourceActions } from "../../factory/useSourceActions";
import { useSourceControlAuthorization } from "../../factory/useSourceAuthorization";
import type { SourceLease } from "../../factory/sourceSessions";
import { useThreadBoundedQuery } from "../../factory/sourceDetailHooks";
import {
  describeRuntimeRequests,
  makeRuntimeRequestResponse,
  prepareUserInputAnswers,
  type RuntimeRequestDetail,
} from "./runtimeRequests";
import styles from "./SessionOverviewView.module.css";

interface Props {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly lease?: SourceLease;
  readonly stale: boolean;
  readonly thread?: FactoryThreadSummary;
  readonly actions: SourceActionRegistry;
}

const respondOperations = ["runtime-request.respond"] as const;

type AnswerFields = Record<string, string | readonly string[]>;
type AnswersByRequest = Record<string, AnswerFields>;
type CustomAnswersByRequest = Record<string, Record<string, string>>;

function formatValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "Not available";
}

function isRequestDetail(
  item: RuntimeRequestDetail | { readonly type: string },
): item is RuntimeRequestDetail {
  return item.type === "approval_request" || item.type === "user_input_request";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "The source did not return a result.";
}

export default function SessionOverviewView({
  factoryId,
  target,
  lease,
  stale,
  thread,
  actions,
}: Props) {
  const query = useThreadBoundedQuery(factoryId, target, lease);
  const authorization = useSourceControlAuthorization(factoryId, lease, respondOperations);
  const [answersByRequest, setAnswersByRequest] = useState<AnswersByRequest>({});
  const [customAnswersByRequest, setCustomAnswersByRequest] = useState<CustomAnswersByRequest>({});
  const [actionError, setActionError] = useState<string>();
  const lastThreadUpdate = useRef(thread?.updatedAt);
  const fresh =
    query.data !== undefined &&
    query.sourceSynchronized &&
    !query.isFetching &&
    !query.isError &&
    query.data.payloadBudgetExceeded !== true;
  const observation = useMemo(
    () =>
      fresh && query.data !== undefined && thread !== undefined
        ? threadActionObservation(query.data, thread)
        : undefined,
    [fresh, query.data, thread?.sourceStatus, thread?.settled],
  );
  const scope = {
    type: "thread",
    factoryId,
    environmentId: target.environmentId,
    threadId: target.threadId,
  } as const;
  const { records, blocking } = useSourceActions(actions, scope, observation);
  const responseRecords = new Map(
    records.flatMap((record) =>
      record.intent.kind === "runtime-response" ? [[record.intent.requestId, record] as const] : [],
    ),
  );
  useEffect(() => {
    if (lastThreadUpdate.current === thread?.updatedAt) return;
    lastThreadUpdate.current = thread?.updatedAt;
    if (thread !== undefined) void query.refetch();
  }, [query.refetch, thread, thread?.updatedAt]);
  if (query.data === undefined) {
    if (query.error !== null)
      return (
        <MessageBar intent="error">
          Unable to read session detail:{" "}
          {query.error instanceof Error ? query.error.message : "The source returned an error."}
        </MessageBar>
      );
    return (
      <MessageBar intent={stale ? "warning" : "info"}>
        {stale
          ? "No cached session detail is available. New reads are paused until the source is fresh."
          : "Reading the bounded session snapshot."}
      </MessageBar>
    );
  }
  const bounded = query.data;
  if (bounded.payloadBudgetExceeded === true)
    return (
      <main className={styles.view}>
        <MessageBar intent="warning">
          The source snapshot exceeded its data limit. Details are incomplete and runtime requests
          are read only.
        </MessageBar>
        {[...responseRecords].map(([requestId, record]) => (
          <p key={requestId} role="status">
            Request <code>{requestId}</code>: {sourceActionRecordText(record)} This snapshot cannot
            confirm completion.
          </p>
        ))}
      </main>
    );
  const sourceThread = bounded.projection.thread;
  const details = bounded.projection.visibleTurnItems.flatMap((item) =>
    isRequestDetail(item.item) ? [item.item] : [],
  );
  const runtimeRequests = describeRuntimeRequests(bounded.projection.runtimeRequests, details);
  const controlState = {
    online: lease?.status.phase === "online",
    synchronized: !stale,
    allowed: authorization.authorized,
  };
  const canRespond = canControlSource(controlState) && fresh && blocking === undefined;

  const sendResponse = async (requestId: string, command: SourceDispatchCommand) => {
    if (!lease || !canRespond) return;
    setActionError(undefined);
    try {
      await dispatchSourceCommand({
        registry: actions,
        scope,
        lease,
        state: controlState,
        command,
        intent: { kind: "runtime-response", requestId },
        baseSequence: bounded.snapshotSequence,
      });
      await query.refetch();
    } catch (error) {
      if (!(error instanceof Error && error.name === "SourceCommandUncertainError"))
        setActionError(messageOf(error));
      await query.refetch();
    }
  };

  const submitAnswers = (requestId: string, detail: RuntimeRequestDetail) => {
    if (detail.type !== "user_input_request") return;
    const fields = { ...(answersByRequest[requestId] ?? {}) };
    for (const question of detail.questions) {
      const custom = customAnswersByRequest[requestId]?.[question.id]?.trim();
      if (custom) {
        const existing = fields[question.id];
        fields[question.id] =
          question.multiSelect === true
            ? [
                ...(Array.isArray(existing)
                  ? existing
                  : typeof existing === "string" && existing
                    ? [existing]
                    : []),
                custom,
              ]
            : custom;
      }
    }
    const validation = prepareUserInputAnswers(detail, fields);
    if (!validation.ok) {
      const labels: Record<typeof validation.reason, string> = {
        "not-user-input": "This request does not accept structured answers.",
        "unknown-question": "An answer does not match a source question.",
        required: `Answer all required questions: ${validation.questionIds.join(", ")}.`,
        "invalid-option":
          "Choose an option supplied by the source or enter an allowed custom answer.",
        "invalid-shape": "Use the answer format supplied by the source.",
      };
      setActionError(labels[validation.reason]);
      return;
    }
    const command = makeRuntimeRequestResponse({
      commandId: createCommandId(),
      threadId: target.threadId,
      requestId: detail.requestId,
      answers: validation.answers,
    });
    void sendResponse(requestId, command);
  };

  return (
    <main className={styles.view}>
      {stale ? (
        <MessageBar intent="warning">Source data is stale. New actions are paused.</MessageBar>
      ) : null}
      {authorization.message ? (
        <MessageBar intent={authorization.phase === "error" ? "error" : "warning"}>
          {authorization.message}
        </MessageBar>
      ) : null}
      {query.isError ? (
        <MessageBar intent="warning">
          The source snapshot could not be refreshed. Cached runtime requests are read only.
        </MessageBar>
      ) : null}
      {actionError ? <MessageBar intent="error">{actionError}</MessageBar> : null}
      {blocking ? (
        <MessageBar intent="warning">{sourceActionRecordText(blocking)}</MessageBar>
      ) : null}
      {query.isFetching ? (
        <p role="status">Refreshing source session details.</p>
      ) : !query.sourceSynchronized ? (
        <p role="status">Confirming the source snapshot. Runtime requests are read only.</p>
      ) : null}
      <section className={styles.summary} aria-label="Session details">
        <h3>Session</h3>
        <dl>
          <div>
            <dt>Project</dt>
            <dd>
              <code>{thread?.project.projectId ?? sourceThread.projectId}</code>
            </dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>
              <code>{sourceThread.providerInstanceId}</code>
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{sourceThread.modelSelection.model}</dd>
          </div>
          <div>
            <dt>Runtime mode</dt>
            <dd>{sourceThread.runtimeMode}</dd>
          </div>
          <div>
            <dt>Interaction mode</dt>
            <dd>{sourceThread.interactionMode}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{sourceThread.branch ?? "Not available"}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>
              <code>{sourceThread.worktreePath ?? thread?.worktreePath ?? "Not available"}</code>
            </dd>
          </div>
          <div>
            <dt>Snapshot sequence</dt>
            <dd>{bounded.snapshotSequence}</dd>
          </div>
        </dl>
      </section>
      <section className={styles.runtime} aria-label="Runtime options and requests">
        <Card appearance="outline" className={styles.detailCard}>
          <header className={styles.cardHeader}>
            <h3>Runtime options</h3>
            <Badge appearance="outline">Read only</Badge>
          </header>
          {sourceThread.modelSelection.options === undefined ? (
            <p>Runtime options were not supplied by the source.</p>
          ) : (
            <pre>{formatValue(sourceThread.modelSelection.options)}</pre>
          )}
        </Card>
        <Card appearance="outline" className={styles.detailCard}>
          <header className={styles.cardHeader}>
            <h3>Runtime requests</h3>
            <div className={styles.requestActions}>
              <Badge appearance="outline">
                {runtimeRequests.filter((item) => item.request.status === "pending").length} pending
              </Badge>
              <Button
                appearance="secondary"
                size="small"
                disabled={stale || query.isFetching}
                onClick={() => {
                  void query.refetch();
                }}
              >
                Refresh requests
              </Button>
            </div>
          </header>
          {runtimeRequests.length === 0 ? (
            <p>No runtime requests were returned.</p>
          ) : (
            <ul className={styles.requestList}>
              {runtimeRequests.map(({ request, detail, actionable }) => {
                const response = responseRecords.get(request.id);
                const alreadyAnswered = response !== undefined && response.phase !== "rejected";
                const approval = detail?.type === "approval_request" ? detail : undefined;
                const userInput = detail?.type === "user_input_request" ? detail : undefined;
                const inputValues = answersByRequest[request.id] ?? {};
                return (
                  <li key={request.id} className={styles.requestItem}>
                    <header className={styles.requestHeader}>
                      <div>
                        <strong>{request.kind}</strong>
                        <Badge
                          color={
                            request.status === "pending"
                              ? "warning"
                              : request.status === "resolved"
                                ? "success"
                                : "neutral"
                          }
                        >
                          {request.status}
                        </Badge>
                      </div>
                      <code>{request.id}</code>
                    </header>
                    {approval?.prompt ? <p>{approval.prompt}</p> : null}
                    {approval?.appName ? <p>Requested by {approval.appName}.</p> : null}
                    {request.status === "resolved" ? (
                      <p role="status">
                        The source has already resolved this request
                        {request.decision ? ` (${request.decision})` : ""}. No new permission
                        request was created.
                      </p>
                    ) : null}
                    {request.status === "expired" || request.status === "cancelled" ? (
                      <p role="status">
                        The source marked this request {request.status}. It cannot be answered.
                      </p>
                    ) : null}
                    {response && request.status === "pending" ? (
                      <p role="status">{sourceActionRecordText(response)}</p>
                    ) : null}
                    {request.responseCapability.type === "not_resumable" ? (
                      <p>{request.responseCapability.reason}</p>
                    ) : null}
                    {request.status === "pending" && detail === undefined ? (
                      <p>
                        The source did not include details for this request. Refresh before
                        responding.
                      </p>
                    ) : null}
                    {approval?.options?.length ? (
                      <div className={styles.responseChoices}>
                        {approval.options.map((option) => (
                          <div key={option.decision}>
                            {option.warning ? (
                              <p className={styles.warning}>{option.warning}</p>
                            ) : null}
                            <Button
                              type="button"
                              appearance={option.decision === "decline" ? "secondary" : "primary"}
                              disabled={!canRespond || alreadyAnswered || !actionable}
                              onClick={() => {
                                const command = makeRuntimeRequestResponse({
                                  commandId: createCommandId(),
                                  threadId: target.threadId,
                                  requestId: request.id,
                                  decision: option.decision,
                                });
                                void sendResponse(request.id, command);
                              }}
                            >
                              {option.label}
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {userInput ? (
                      <div className={styles.questionList}>
                        {userInput.questions.map((question) => {
                          const value = inputValues[question.id];
                          const selected = Array.isArray(value) ? value : [];
                          return (
                            <section key={question.id} className={styles.question}>
                              <Field
                                label={`${question.header}: ${question.question}`}
                                required={question.required === true}
                              >
                                {question.multiSelect ? (
                                  <div className={styles.checkboxChoices}>
                                    {question.options.map((option) => {
                                      const optionValue = option.value ?? option.label;
                                      return (
                                        <Checkbox
                                          key={optionValue}
                                          checked={selected.includes(optionValue)}
                                          label={option.label}
                                          onChange={(_, data) => {
                                            const next = data.checked
                                              ? [...selected, optionValue]
                                              : selected.filter((item) => item !== optionValue);
                                            setAnswersByRequest((current) => ({
                                              ...current,
                                              [request.id]: {
                                                ...(current[request.id] ?? {}),
                                                [question.id]: next,
                                              },
                                            }));
                                          }}
                                        />
                                      );
                                    })}
                                    {question.allowCustomAnswer ? (
                                      <Input
                                        aria-label={`Custom answer for ${question.header}`}
                                        placeholder="Add a custom answer"
                                        value={
                                          customAnswersByRequest[request.id]?.[question.id] ?? ""
                                        }
                                        onChange={(_, data) =>
                                          setCustomAnswersByRequest((current) => ({
                                            ...current,
                                            [request.id]: {
                                              ...(current[request.id] ?? {}),
                                              [question.id]: data.value,
                                            },
                                          }))
                                        }
                                      />
                                    ) : null}
                                  </div>
                                ) : question.options.length > 0 ? (
                                  <>
                                    <Select
                                      value={typeof value === "string" ? value : ""}
                                      onChange={(_, data) =>
                                        setAnswersByRequest((current) => ({
                                          ...current,
                                          [request.id]: {
                                            ...(current[request.id] ?? {}),
                                            [question.id]: data.value,
                                          },
                                        }))
                                      }
                                    >
                                      <option value="">Select an option</option>
                                      {question.options.map((option) => (
                                        <option
                                          key={option.value ?? option.label}
                                          value={option.value ?? option.label}
                                        >
                                          {option.label}
                                        </option>
                                      ))}
                                    </Select>
                                    {question.allowCustomAnswer ? (
                                      <Input
                                        aria-label={`Custom answer for ${question.header}`}
                                        placeholder="Or enter a custom answer"
                                        value={
                                          customAnswersByRequest[request.id]?.[question.id] ?? ""
                                        }
                                        onChange={(_, data) =>
                                          setCustomAnswersByRequest((current) => ({
                                            ...current,
                                            [request.id]: {
                                              ...(current[request.id] ?? {}),
                                              [question.id]: data.value,
                                            },
                                          }))
                                        }
                                      />
                                    ) : null}
                                  </>
                                ) : (
                                  <Textarea
                                    value={typeof value === "string" ? value : ""}
                                    onChange={(_, data) =>
                                      setAnswersByRequest((current) => ({
                                        ...current,
                                        [request.id]: {
                                          ...(current[request.id] ?? {}),
                                          [question.id]: data.value,
                                        },
                                      }))
                                    }
                                    rows={2}
                                  />
                                )}
                              </Field>
                            </section>
                          );
                        })}
                        <Button
                          type="button"
                          appearance="primary"
                          disabled={!canRespond || alreadyAnswered || !actionable}
                          onClick={() => submitAnswers(request.id, userInput)}
                        >
                          Submit answers
                        </Button>
                      </div>
                    ) : null}
                    {request.status === "pending" &&
                    detail &&
                    !actionable &&
                    request.responseCapability.type !== "not_resumable" ? (
                      <p>This request has no actionable options in the source snapshot.</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>
    </main>
  );
}
