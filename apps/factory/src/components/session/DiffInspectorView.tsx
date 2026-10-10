import { useQuery, skipToken } from "@tanstack/react-query";
import { useState } from "react";
import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { Badge, Button, Tab, TabList } from "../../design-system/actions";
import { MessageBar, Select } from "../../design-system/forms";
import {
  useThreadBoundedQuery,
  useVcsStatusStream,
  useWorkingDiffQuery,
} from "../../factory/sourceDetailHooks";
import { threadDetailKey } from "../../factory/queryKeys";
import type { SourceLease } from "../../factory/sourceSessions";
import { sourceLeaseForTarget } from "../../factory/useSourceLease";
import styles from "./DiffInspectorView.module.css";

interface Props {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly lease?: SourceLease;
  readonly workspaceRoot?: string;
  readonly stale: boolean;
}

type DiffMode = "working-tree" | "thread" | "checkpoint";
function stringify(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "Not available";
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The source returned an error.";
}

export default function DiffInspectorView({
  factoryId,
  target,
  lease,
  workspaceRoot,
  stale,
}: Props) {
  lease = stale ? undefined : sourceLeaseForTarget(lease, target);
  const [mode, setMode] = useState<DiffMode>("working-tree");
  const targetIdentity = JSON.stringify([
    factoryId,
    target.registrationId,
    target.environmentId,
    target.threadId,
    workspaceRoot,
  ]);
  const [checkpointSelection, setCheckpointSelection] = useState({
    target: targetIdentity,
    id: "",
  });
  const checkpointId = checkpointSelection.target === targetIdentity ? checkpointSelection.id : "";
  const setCheckpointId = (id: string) => setCheckpointSelection({ target: targetIdentity, id });
  const snapshot = useThreadBoundedQuery(factoryId, target, lease, mode !== "working-tree");
  const working = useWorkingDiffQuery(
    factoryId,
    target,
    lease,
    workspaceRoot,
    mode === "working-tree",
  );
  const vcs = useVcsStatusStream(factoryId, target, lease, workspaceRoot, mode === "working-tree");
  const checkpoints = snapshot.data?.projection.checkpoints ?? [];
  const checkpoint = checkpoints.find((item) => item.id === checkpointId);
  const ordinal = checkpoint?.appRunOrdinal;
  const threadDiff = useQuery({
    queryKey: [
      ...threadDetailKey(factoryId, target.environmentId, target.threadId, target.registrationId),
      "diff",
      "thread",
      snapshot.data?.latestLocalTurnOrdinal ?? -1,
    ],
    queryFn:
      mode !== "thread" || lease === undefined || snapshot.data?.latestLocalTurnOrdinal == null
        ? skipToken
        : ({ signal }) =>
            lease.request(
              (client) =>
                client["orchestration.getFullThreadDiff"]({
                  threadId: target.threadId,
                  toTurnCount: snapshot.data!.latestLocalTurnOrdinal!,
                }),
              { signal },
            ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const turnDiff = useQuery({
    queryKey: [
      ...threadDetailKey(factoryId, target.environmentId, target.threadId, target.registrationId),
      "diff",
      "checkpoint",
      checkpointId,
    ],
    queryFn:
      mode !== "checkpoint" || lease === undefined || ordinal == null || ordinal < 1
        ? skipToken
        : ({ signal }) =>
            lease.request(
              (client) =>
                client["orchestration.getTurnDiff"]({
                  threadId: target.threadId,
                  fromTurnCount: ordinal - 1,
                  toTurnCount: ordinal,
                }),
              { signal },
            ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return (
    <main className={styles.view}>
      <header className={styles.header}>
        <div className={styles.modeNavigation}>
          <TabList
            selectedValue={mode}
            onTabSelect={(_, data) => {
              if (
                data.value === "working-tree" ||
                data.value === "thread" ||
                data.value === "checkpoint"
              )
                setMode(data.value);
            }}
            aria-label="Diff source"
          >
            <Tab value="working-tree">Working tree</Tab>
            <Tab value="thread">Thread history</Tab>
            <Tab value="checkpoint">Checkpoint turn</Tab>
          </TabList>
        </div>
        {mode === "working-tree" ? (
          <div className={styles.refresh}>
            <Button
              appearance="secondary"
              disabled={
                stale || lease === undefined || workspaceRoot === undefined || working.isFetching
              }
              onClick={() => {
                void working.refetch();
              }}
            >
              Refresh working diff
            </Button>
          </div>
        ) : null}
      </header>
      {mode === "working-tree" ? (
        <section className={styles.diffPane} aria-label="Working tree diff">
          {workspaceRoot === undefined ? (
            <MessageBar intent="warning">
              The source did not provide a workspace path. A working-tree diff is unavailable.
            </MessageBar>
          ) : working.isError ? (
            <MessageBar intent="error">
              Unable to read the working-tree diff: {errorText(working.error)}
            </MessageBar>
          ) : working.data === undefined ? (
            <p className={styles.emptyDiff}>
              {stale
                ? "No cached working-tree diff is available while the source is stale."
                : "Reading the current working-tree diff."}
            </p>
          ) : (
            <>
              {working.data.sources.length === 0 ? (
                <p>No working-tree diff was returned.</p>
              ) : (
                working.data.sources.map((source) => (
                  <section className={styles.diffSection} key={source.id}>
                    <header>
                      <h3>{source.title}</h3>
                      <Badge appearance="outline">{source.kind}</Badge>
                    </header>
                    <p>
                      {source.baseRef ?? "No base ref"} → {source.headRef ?? "Current worktree"}
                    </p>
                    {source.truncated ? (
                      <MessageBar intent="warning">
                        The source truncated this diff. The result is partial.
                      </MessageBar>
                    ) : null}
                    <pre>{source.diff}</pre>
                  </section>
                ))
              )}
              {vcs.streamError !== undefined ? (
                <MessageBar intent="error">
                  Unable to read version-control status: {errorText(vcs.streamError)}
                </MessageBar>
              ) : vcs.data === undefined ? (
                <p>Waiting for live version-control status.</p>
              ) : (
                <details>
                  <summary>Version-control status</summary>
                  <pre>{stringify(vcs.data)}</pre>
                </details>
              )}
            </>
          )}
        </section>
      ) : mode === "thread" ? (
        <section className={styles.diffPane} aria-label="Thread diff">
          {threadDiff.isError ? (
            <MessageBar intent="error">
              Unable to read the thread diff: {errorText(threadDiff.error)}
            </MessageBar>
          ) : threadDiff.data === undefined ? (
            <p className={styles.emptyDiff}>
              {stale
                ? "No cached thread diff is available while the source is stale."
                : "Reading the thread diff."}
            </p>
          ) : (
            <pre>{threadDiff.data.diff}</pre>
          )}
        </section>
      ) : (
        <section className={styles.diffPane} aria-label="Checkpoint turn diff">
          <Select
            id="checkpoint-diff-select"
            size="small"
            value={checkpointId}
            onChange={(event) => setCheckpointId(event.currentTarget.value)}
            aria-label="Select a checkpoint"
          >
            <option value="">Select a checkpoint</option>
            {checkpoints.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.ref}
              </option>
            ))}
          </Select>
          {checkpoint === undefined && checkpointId !== "" ? (
            <MessageBar intent="warning">
              This checkpoint is not in the current bounded snapshot.
            </MessageBar>
          ) : null}
          {checkpoint !== undefined ? (
            <p>
              Turn ordinal {checkpoint.appRunOrdinal ?? "Not available"} · ref{" "}
              <code>{checkpoint.ref}</code>
            </p>
          ) : null}
          {turnDiff.isError ? (
            <MessageBar intent="error">
              Unable to read this checkpoint diff: {errorText(turnDiff.error)}
            </MessageBar>
          ) : checkpointId !== "" && turnDiff.data === undefined ? (
            <p>
              {stale
                ? "No cached checkpoint diff is available while the source is stale."
                : "Reading the checkpoint turn diff."}
            </p>
          ) : turnDiff.data !== undefined ? (
            <pre>{turnDiff.data.diff}</pre>
          ) : (
            <p>Select a checkpoint to read its turn diff.</p>
          )}
        </section>
      )}
    </main>
  );
}
