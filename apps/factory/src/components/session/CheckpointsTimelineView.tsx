import { useEffect, useMemo, useRef, useState } from "react";
import type { FactoryFrameTarget, FactoryThreadSummary } from "@t3tools/contracts/factory";
import { Badge, Button, Card } from "../../design-system/actions";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
  MessageBar,
} from "../../design-system/forms";
import {
  canControlSource,
  createCommandId,
  dispatchSourceCommand,
  rollbackUnavailableReason,
  sourceActionRecordText,
  threadActionObservation,
} from "../../factory/actionPolicy";
import type { SourceActionRegistry, SourceDispatchCommand } from "../../factory/actionPolicy";
import { useSourceConfigQuery } from "../../factory/hooks";
import { useSourceActions } from "../../factory/useSourceActions";
import { useSourceControlAuthorization } from "../../factory/useSourceAuthorization";
import type { SourceLease } from "../../factory/sourceSessions";
import { useThreadBoundedQuery } from "../../factory/sourceDetailHooks";
import type { BoundedSnapshot } from "../../factory/sourceDetailApi";
import styles from "./CheckpointsTimelineView.module.css";

interface Props {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly lease?: SourceLease;
  readonly stale: boolean;
  readonly workspaceRoot?: string;
  readonly thread?: FactoryThreadSummary;
  readonly actions: SourceActionRegistry;
}

const rollbackOperations = ["checkpoint.rollback"] as const;

type SelectedCheckpoint = Pick<
  BoundedSnapshot["projection"]["checkpoints"][number],
  "id" | "scopeId"
>;

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

export default function CheckpointsTimelineView({
  factoryId,
  target,
  lease,
  stale,
  thread,
  actions,
}: Props) {
  const query = useThreadBoundedQuery(factoryId, target, lease, !stale);
  const config = useSourceConfigQuery(
    factoryId,
    target.environmentId,
    lease,
    !stale,
    target.registrationId,
  );
  const support =
    config.sourceSynchronized && !config.isFetching && !config.isError && query.sourceSynchronized
      ? { providers: config.data?.providers, projection: query.data?.projection }
      : undefined;
  const unsupportedRollback = rollbackUnavailableReason(support);
  const authorization = useSourceControlAuthorization(factoryId, lease, rollbackOperations);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<SelectedCheckpoint>();
  const [error, setError] = useState<string>();
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
  const rollback = [...records].reverse().find((record) => record.intent.kind === "rollback");
  const sending = blocking?.phase === "sending";
  const controlState = {
    online: lease?.status.phase === "online",
    synchronized: !stale,
    allowed: authorization.authorized,
  };
  const canControl =
    unsupportedRollback === undefined &&
    canControlSource(controlState) &&
    fresh &&
    blocking === undefined;
  const selectedReady =
    query.data?.projection.checkpoints.some(
      (checkpoint) =>
        checkpoint.id === selectedCheckpoint?.id &&
        checkpoint.scopeId === selectedCheckpoint.scopeId &&
        checkpoint.status === "ready",
    ) === true;
  const canConfirm = canControl && selectedReady && thread?.sourceStatus !== "rolled_back";

  useEffect(() => {
    if (lastThreadUpdate.current === thread?.updatedAt) return;
    lastThreadUpdate.current = thread?.updatedAt;
    void query.refetch();
  }, [query.refetch, thread?.updatedAt]);

  // The overview can report rolled_back before this snapshot shows the matching request.
  useEffect(() => {
    if (
      rollback === undefined ||
      (rollback.phase !== "accepted" && rollback.phase !== "uncertain") ||
      thread?.sourceStatus !== "rolled_back" ||
      query.data === undefined
    )
      return;
    if (
      query.data.snapshotSequence <= rollback.sequence ||
      query.data.projection.thread.rollbackRequestId !== rollback.commandId
    )
      void query.refetch();
  }, [
    rollback?.commandId,
    rollback?.phase,
    query.data?.projection.thread.rollbackRequestId,
    query.data?.snapshotSequence,
    query.refetch,
    thread?.sourceStatus,
  ]);

  const confirmRollback = async () => {
    if (!lease || !selectedCheckpoint || !thread || !canConfirm || query.data === undefined) return;
    const command: SourceDispatchCommand = {
      type: "checkpoint.rollback",
      commandId: createCommandId(),
      threadId: target.threadId,
      checkpointId: selectedCheckpoint.id,
      scopeId: selectedCheckpoint.scopeId,
      restoreFiles: false,
    };
    setError(undefined);
    try {
      await dispatchSourceCommand({
        registry: actions,
        scope,
        lease,
        state: controlState,
        command,
        support,
        intent: {
          kind: "rollback",
          checkpointId: selectedCheckpoint.id,
          previousStatus: thread.sourceStatus,
        },
        baseSequence: query.data.snapshotSequence,
      });
      setSelectedCheckpoint(undefined);
      await query.refetch();
    } catch (cause) {
      const isUncertain = cause instanceof Error && cause.name === "SourceCommandUncertainError";
      if (isUncertain) setSelectedCheckpoint(undefined);
      else setError(messageOf(cause));
      void query.refetch();
    }
  };

  if (query.data === undefined) {
    if (query.isError)
      return (
        <MessageBar intent="error">Unable to read checkpoints: {messageOf(query.error)}</MessageBar>
      );
    return (
      <p className={styles.empty}>
        {stale
          ? "No cached checkpoints are available while the source is stale."
          : "Reading the bounded checkpoint snapshot."}
      </p>
    );
  }
  const checkpoints = query.data.projection.checkpoints;

  return (
    <main className={styles.view}>
      <header className={styles.intro}>
        <h2>Checkpoints</h2>
        <p>
          Checkpoint IDs and refs are supplied by the source. Rollback changes conversation state.
          Workspace files are not restored.
        </p>
      </header>
      {stale ? (
        <MessageBar intent="warning">Source data is stale. Rollback is paused.</MessageBar>
      ) : null}
      {query.isError ? (
        <MessageBar intent="error">
          Unable to refresh checkpoints: {messageOf(query.error)} Cached checkpoints are read only.
        </MessageBar>
      ) : null}
      {query.data.payloadBudgetExceeded ? (
        <MessageBar intent="warning">
          The bounded snapshot exceeded its limit. The checkpoint list may be incomplete and
          rollback is paused.
        </MessageBar>
      ) : null}
      {authorization.message ? (
        <MessageBar intent={authorization.phase === "error" ? "error" : "warning"}>
          {authorization.message}
        </MessageBar>
      ) : null}
      {error ? <MessageBar intent="error">{error}</MessageBar> : null}
      {blocking && blocking !== rollback ? (
        <MessageBar intent="warning">{sourceActionRecordText(blocking)}</MessageBar>
      ) : null}
      {rollback && rollback.intent.kind === "rollback" ? (
        <MessageBar
          intent={
            rollback.phase === "confirmed"
              ? "success"
              : rollback.phase === "failed" || rollback.phase === "rejected"
                ? "error"
                : "info"
          }
          role="status"
        >
          Checkpoint <code>{rollback.intent.checkpointId}</code>: {sourceActionRecordText(rollback)}
          {rollback.phase === "failed" &&
          query.data.projection.thread.rollbackFailure?.requestId === rollback.commandId
            ? ` ${query.data.projection.thread.rollbackFailure.message}`
            : null}
          {rollback.phase === "uncertain" ? (
            <>
              {" "}
              <Button
                type="button"
                appearance="secondary"
                size="small"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Check source
              </Button>
            </>
          ) : null}
        </MessageBar>
      ) : null}
      {query.data.payloadBudgetExceeded ? null : checkpoints.length === 0 ? (
        <p className={styles.empty}>The source returned no checkpoints for this session.</p>
      ) : (
        <ol className={styles.timeline}>
          {checkpoints.map((checkpoint) => {
            const unsupportedReason =
              unsupportedRollback ??
              (checkpoint.status !== "ready"
                ? `This checkpoint is ${checkpoint.status} and cannot be restored.`
                : thread?.sourceStatus === "rolled_back"
                  ? "The source reports that this conversation is already rolled back."
                  : stale
                    ? "Source data is not fresh."
                    : query.isError
                      ? "Checkpoint data could not be refreshed."
                      : query.isFetching
                        ? "Refreshing source checkpoint data."
                        : !query.sourceSynchronized
                          ? "Confirming source checkpoint data."
                          : !authorization.authorized
                            ? "Control scopes have not been confirmed."
                            : blocking
                              ? "An earlier command for this session is not confirmed."
                              : undefined);
            return (
              <li key={checkpoint.id}>
                <Card appearance="outline" className={styles.checkpointCard}>
                  <header className={styles.cardHeader}>
                    <div>
                      <h3>
                        Checkpoint {checkpoint.appRunOrdinal ?? checkpoint.ordinalWithinScope}
                      </h3>
                      <Badge
                        color={
                          checkpoint.status === "ready"
                            ? "success"
                            : checkpoint.status === "missing"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {checkpoint.status}
                      </Badge>
                    </div>
                    <time>{String(checkpoint.capturedAt)}</time>
                  </header>
                  <dl className={styles.refs}>
                    <div>
                      <dt>ID</dt>
                      <dd>
                        <code>{checkpoint.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Ref</dt>
                      <dd>
                        <code>{checkpoint.ref}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Scope</dt>
                      <dd>
                        <code>{checkpoint.scopeId}</code>
                      </dd>
                    </div>
                  </dl>
                  <section className={styles.files}>
                    <h4>Recorded files</h4>
                    {checkpoint.files.length === 0 ? (
                      <p>No file changes were recorded on this checkpoint.</p>
                    ) : (
                      <ul>
                        {checkpoint.files.map((file) => (
                          <li key={`${file.path}:${file.kind}`}>
                            <code>{file.path}</code>
                            <span>{file.kind}</span>
                            <span>
                              +{file.additions} / -{file.deletions}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  {checkpoint.status === "ready" ? (
                    <div className={styles.rollbackAction}>
                      <Button
                        appearance="secondary"
                        disabled={!canControl || unsupportedReason !== undefined}
                        onClick={() =>
                          setSelectedCheckpoint({ id: checkpoint.id, scopeId: checkpoint.scopeId })
                        }
                      >
                        Roll back conversation
                      </Button>
                      {unsupportedReason ? <p>{unsupportedReason}</p> : null}
                    </div>
                  ) : (
                    <p className={styles.rollbackReason}>{unsupportedReason}</p>
                  )}
                </Card>
              </li>
            );
          })}
        </ol>
      )}
      <Dialog
        open={selectedCheckpoint !== undefined}
        onOpenChange={(_, data) => {
          if (!data.open && !sending) setSelectedCheckpoint(undefined);
        }}
      >
        <DialogSurface size="small">
          <DialogHeader>
            <DialogTitle>Confirm conversation rollback</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p>
              The source will roll back to checkpoint <code>{selectedCheckpoint?.id}</code>. This
              does not restore workspace files.
            </p>
            {selectedCheckpoint && !selectedReady ? (
              <p>The selected checkpoint is no longer ready on the source.</p>
            ) : null}
            {query.data.projection.thread.rollbackFailure?.message ? (
              <p>
                The source reports a previous rollback failure:{" "}
                {query.data.projection.thread.rollbackFailure.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogActions>
            <Button
              appearance="secondary"
              disabled={sending}
              onClick={() => setSelectedCheckpoint(undefined)}
            >
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!canConfirm}
              onClick={() => {
                void confirmRollback();
              }}
            >
              {sending ? "Waiting for source" : "Confirm rollback"}
            </Button>
          </DialogActions>
        </DialogSurface>
      </Dialog>
    </main>
  );
}
