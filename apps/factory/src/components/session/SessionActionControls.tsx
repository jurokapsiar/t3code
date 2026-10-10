import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FactoryFrameTarget, FactoryThreadSummary } from "@t3tools/contracts/factory";
import { Button } from "../../design-system/actions";
import { Field, MessageBar, Textarea } from "../../design-system/forms";
import {
  canControlSource,
  createCommandId,
  createMessageId,
  dispatchSourceCommand,
  sourceActionRecordText,
  threadActionObservation,
} from "../../factory/actionPolicy";
import type {
  SourceActionIntent,
  SourceActionRegistry,
  SourceDispatchCommand,
} from "../../factory/actionPolicy";
import { useSourceConfigQuery } from "../../factory/hooks";
import { useSourceActions } from "../../factory/useSourceActions";
import { useSourceControlAuthorization } from "../../factory/useSourceAuthorization";
import { useThreadBoundedQuery } from "../../factory/sourceDetailHooks";
import type { SourceLease } from "../../factory/sourceSessions";
import { SessionDraft, sessionDraftKey } from "./sessionDraft";
import styles from "./SessionActionControls.module.css";

interface Props {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly thread: FactoryThreadSummary;
  readonly lease?: SourceLease;
  readonly stale: boolean;
  readonly actions: SourceActionRegistry;
}

const controlOperations = [
  "message.dispatch",
  "run.interrupt",
  "queue.resume",
  "thread.settle",
  "thread.unsettle",
] as const;
const controlKinds = new Set<SourceActionIntent["kind"]>([
  "prompt",
  "interrupt",
  "resume",
  "settle",
  "unsettle",
]);

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

export default function SessionActionControls(props: Props) {
  return (
    <TargetSessionActionControls key={sessionDraftKey(props.factoryId, props.target)} {...props} />
  );
}

function TargetSessionActionControls({ factoryId, target, thread, lease, stale, actions }: Props) {
  const authorization = useSourceControlAuthorization(factoryId, lease, controlOperations);
  const config = useSourceConfigQuery(factoryId, target.environmentId, lease, !stale);
  const snapshot = useThreadBoundedQuery(factoryId, target, lease, !stale);
  const state = {
    online: lease?.status.phase === "online",
    synchronized: !stale,
    allowed: authorization.authorized,
  };
  const fresh =
    snapshot.data !== undefined &&
    snapshot.data.payloadBudgetExceeded !== true &&
    snapshot.sourceSynchronized &&
    !snapshot.isFetching &&
    !snapshot.isError;
  const observation = useMemo(
    () =>
      fresh && snapshot.data !== undefined
        ? threadActionObservation(snapshot.data, thread)
        : undefined,
    [fresh, snapshot.data, thread.sourceStatus, thread.settled],
  );
  const scope = {
    type: "thread",
    factoryId,
    environmentId: target.environmentId,
    threadId: target.threadId,
  } as const;
  const { records, blocking } = useSourceActions(actions, scope, observation);
  const latest = [...records].reverse().find((record) => controlKinds.has(record.intent.kind));
  const canSend = canControlSource(state) && fresh;
  const [draft] = useState(() => new SessionDraft(sessionDraftKey(factoryId, target)));
  const { prompt, error } = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  useEffect(() => {
    draft.activate();
    return () => draft.deactivate();
  }, [draft]);
  const lastThreadUpdate = useRef(thread.updatedAt);

  useEffect(() => {
    if (lastThreadUpdate.current === thread.updatedAt) return;
    lastThreadUpdate.current = thread.updatedAt;
    void snapshot.refetch();
  }, [snapshot.refetch, thread.updatedAt]);

  const runs = snapshot.data?.projection.runs ?? [];
  const activeRun = [...runs]
    .reverse()
    .find(
      (run) =>
        run.status === "preparing" ||
        run.status === "queued" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting",
    );
  const hasActiveRun = activeRun !== undefined;

  const submit = async (
    intent: SourceActionIntent,
    command: Extract<
      SourceDispatchCommand,
      {
        readonly type:
          | "message.dispatch"
          | "run.interrupt"
          | "queue.resume"
          | "thread.settle"
          | "thread.unsettle";
      }
    >,
  ) => {
    if (!lease || !canSend || snapshot.data === undefined || blocking !== undefined) return;
    if (!authorization.allowed(command.type)) return;
    const submission = draft.begin();
    try {
      await dispatchSourceCommand({
        registry: actions,
        scope,
        lease,
        command,
        intent,
        state: { ...state, allowed: authorization.allowed(command.type) },
        baseSequence: snapshot.data.snapshotSequence,
        support: { projection: snapshot.data.projection },
      });
      if (intent.kind === "prompt") draft.succeed(submission);
      if (draft.isActive()) await snapshot.refetch();
    } catch (cause) {
      const isUncertain = cause instanceof Error && cause.name === "SourceCommandUncertainError";
      if (!isUncertain) draft.fail(submission, messageOf(cause));
      if (draft.isActive()) void snapshot.refetch();
    }
  };

  const sendPrompt = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend || prompt.trim().length === 0) return;
    const command = {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: createCommandId(),
      messageId: createMessageId(),
      threadId: target.threadId,
      text: prompt.trim(),
      attachments: [],
      dispatchMode: activeRun ? { type: "queue_after_active" } : { type: "start_immediately" },
    } satisfies SourceDispatchCommand;
    void submit({ kind: "prompt", messageId: command.messageId }, command);
  };

  const configCapabilities = config.data?.environment.capabilities;
  const capabilitiesReady =
    config.data !== undefined && config.sourceSynchronized && !config.isFetching && !config.isError;
  const settlementSupported = capabilitiesReady && configCapabilities?.threadSettlement === true;
  const heldQueue = runs.some((run) => run.status === "queued" && run.queueHeld === true);
  const resumeSupported = snapshot.sourceSynchronized && heldQueue;
  const supportedRunModes = ["preparing", "queued", "starting", "running", "waiting"].includes(
    thread.sourceStatus,
  );
  const disabled = !canSend || blocking !== undefined;
  const reason = stale
    ? "Source data is not fresh. Actions are paused."
    : snapshot.data?.payloadBudgetExceeded
      ? "The bounded snapshot is incomplete. Actions are paused."
      : snapshot.isError
        ? "The source snapshot could not be refreshed. Actions are paused."
        : snapshot.isFetching
          ? "Refreshing source session details. Actions are paused."
          : !snapshot.sourceSynchronized
            ? "Confirming source session details. Actions are paused."
            : (authorization.message ??
              (lease?.status.phase !== "online" ? "Source connection is not ready." : undefined));

  return (
    <section className={styles.panel} aria-label="Source session actions">
      {reason ? <MessageBar intent="warning">{reason}</MessageBar> : null}
      {config.isError ? (
        <MessageBar intent="error">
          Unable to read source action capabilities: {messageOf(config.error)}{" "}
          <Button
            type="button"
            appearance="secondary"
            size="small"
            onClick={() => {
              void config.refetch();
            }}
          >
            Retry
          </Button>
        </MessageBar>
      ) : null}
      {error ? <MessageBar intent="error">{error}</MessageBar> : null}
      {blocking ? (
        <p className={styles.result} role="status">
          {sourceActionRecordText(blocking)}{" "}
          <Button
            type="button"
            appearance="secondary"
            size="small"
            onClick={() => {
              void snapshot.refetch();
            }}
          >
            Check source
          </Button>
        </p>
      ) : null}
      {latest && latest !== blocking ? (
        <p className={styles.result} role="status">
          {sourceActionRecordText(latest)}
        </p>
      ) : null}
      <form className={styles.promptForm} onSubmit={sendPrompt}>
        <Field label="Send a prompt" hint="This sends a source command through the factory relay.">
          <Textarea
            value={prompt}
            onChange={(_, data) => draft.edit(data.value)}
            rows={3}
            disabled={disabled}
          />
        </Field>
        <Button
          type="submit"
          appearance="primary"
          disabled={disabled || prompt.trim().length === 0}
        >
          Send prompt
        </Button>
      </form>
      <div className={styles.buttons}>
        <Button
          appearance="secondary"
          disabled={disabled || !hasActiveRun || !authorization.allowed("run.interrupt")}
          onClick={() => {
            if (!activeRun) return;
            const command: SourceDispatchCommand = {
              type: "run.interrupt",
              commandId: createCommandId(),
              threadId: target.threadId,
              runId: activeRun.id,
            };
            void submit({ kind: "interrupt", runId: activeRun.id }, command);
          }}
        >
          Stop run
        </Button>
        {resumeSupported ? (
          <Button
            appearance="secondary"
            disabled={disabled || !heldQueue || !authorization.allowed("queue.resume")}
            onClick={() => {
              const command: SourceDispatchCommand = {
                type: "queue.resume",
                commandId: createCommandId(),
                threadId: target.threadId,
              };
              void submit(
                {
                  kind: "resume",
                  heldRunIds: runs
                    .filter((run) => run.status === "queued" && run.queueHeld === true)
                    .map((run) => run.id),
                },
                command,
              );
            }}
          >
            Resume queued runs
          </Button>
        ) : (
          <span className={styles.unavailable}>
            No held queued runs are available. Queue release does not resume an interrupted agent.
          </span>
        )}
        {settlementSupported ? (
          thread.settled ? (
            <Button
              appearance="secondary"
              disabled={disabled || !authorization.allowed("thread.unsettle")}
              onClick={() => {
                const command: SourceDispatchCommand = {
                  type: "thread.unsettle",
                  commandId: createCommandId(),
                  threadId: target.threadId,
                  reason: "user",
                };
                void submit({ kind: "unsettle", previousSettled: thread.settled }, command);
              }}
            >
              Unsettle
            </Button>
          ) : (
            <Button
              appearance="secondary"
              disabled={disabled || !authorization.allowed("thread.settle")}
              onClick={() => {
                const command: SourceDispatchCommand = {
                  type: "thread.settle",
                  commandId: createCommandId(),
                  threadId: target.threadId,
                };
                void submit({ kind: "settle", previousSettled: thread.settled }, command);
              }}
            >
              Settle
            </Button>
          )
        ) : (
          <span className={styles.unavailable}>
            {config.isError
              ? "Settlement support could not be confirmed."
              : !capabilitiesReady
                ? "Checking settlement support."
                : "This source does not advertise settlement support."}
          </span>
        )}
      </div>
      {!hasActiveRun && supportedRunModes ? (
        <p className={styles.unavailable}>No active run is available to stop.</p>
      ) : null}
      {config.isSuccess && !config.isFetching && !config.isError && !settlementSupported ? (
        <p className={styles.unavailable}>
          This source does not advertise thread settlement support.
        </p>
      ) : null}
      <p className={styles.state}>
        Source status: <code>{thread.sourceStatus}</code> ·{" "}
        {thread.settled ? "Settled" : "Not settled"}
      </p>
      {snapshot.isError ? (
        <p className={styles.unavailable}>
          Run details are unavailable: {messageOf(snapshot.error)}{" "}
          <Button
            type="button"
            appearance="secondary"
            size="small"
            onClick={() => {
              void snapshot.refetch();
            }}
          >
            Retry source read
          </Button>
        </p>
      ) : null}
      {!snapshot.isError && snapshot.data === undefined ? (
        <p className={styles.unavailable}>
          Reading source run details. Prompt and stop controls remain paused.
        </p>
      ) : null}
    </section>
  );
}
