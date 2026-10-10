import { useEffect, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Stream from "effect/Stream";
import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { Badge, Button } from "../../design-system/actions";
import { MessageBar, Select } from "../../design-system/forms";
import { threadDetailKey } from "../../factory/queryKeys";
import type { SourceLease, SourceRpcClient } from "../../factory/sourceSessions";
import { sourceLeaseForTarget } from "../../factory/useSourceLease";
import {
  createTerminalAttachIntent,
  isTerminalAttachRequested,
  syncTerminalAttachIntent,
  terminalAttachIdentity,
  toggleTerminalAttachIntent,
} from "./terminalAttachIntent";
import {
  appendTerminalOutput,
  beginTerminalOutput,
  terminalOutputPresentation,
  type TerminalOutputState,
} from "./terminalOutput";
import styles from "./PtyTerminalView.module.css";

interface Props {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly lease?: SourceLease;
  readonly stale: boolean;
  readonly workspaceRoot?: string;
}

function subscribeMetadata(client: SourceRpcClient) {
  return client["subscribeTerminalMetadata"]({}, { asQueue: false });
}
function attachExistingTerminal(client: SourceRpcClient, threadId: string, terminalId: string) {
  return client["terminal.attach"](
    { threadId, terminalId, restartIfNotRunning: false },
    { asQueue: false },
  );
}
type TerminalMetadataEvent = Stream.Success<ReturnType<typeof subscribeMetadata>>;
type ExtractTerminal<E> = E extends {
  readonly type: "snapshot";
  readonly terminals: ReadonlyArray<infer T>;
}
  ? T
  : E extends { readonly type: "upsert"; readonly terminal: infer T }
    ? T
    : never;
type TerminalMetadata = ExtractTerminal<TerminalMetadataEvent>;
export type TerminalAttachEvent = Stream.Success<ReturnType<typeof attachExistingTerminal>>;

export default function PtyTerminalView({ factoryId, target, lease, stale }: Props) {
  lease = sourceLeaseForTarget(lease, target);
  const queryClient = useQueryClient();
  const metadataKey = [
    ...threadDetailKey(factoryId, target.environmentId, target.threadId, target.registrationId),
    "terminal-metadata",
  ] as const;
  const metadataErrorKey = [...metadataKey, "error"] as const;
  const metadata = useQuery<ReadonlyArray<TerminalMetadata>>({
    queryKey: metadataKey,
    queryFn: skipToken,
    staleTime: Infinity,
  });
  const metadataError = useQuery<unknown>({
    queryKey: metadataErrorKey,
    queryFn: skipToken,
    staleTime: Infinity,
  });
  const targetIdentity = JSON.stringify([
    target.registrationId,
    target.environmentId,
    target.threadId,
  ]);
  const [terminalSelection, setTerminalSelection] = useState({ target: targetIdentity, id: "" });
  const selectedId = terminalSelection.target === targetIdentity ? terminalSelection.id : "";
  const setSelectedId = (id: string) => setTerminalSelection({ target: targetIdentity, id });
  useEffect(() => {
    if (lease === undefined) return;
    const stream = lease.acquireStream(
      `terminal-metadata:${JSON.stringify([target.registrationId, target.environmentId, target.threadId])}`,
      (client) => subscribeMetadata(client),
      (event) => {
        queryClient.removeQueries({ queryKey: metadataErrorKey, exact: true });
        queryClient.setQueryData<ReadonlyArray<TerminalMetadata>>(metadataKey, (current) => {
          if (event.type === "snapshot")
            return event.terminals.filter((item) => item.threadId === target.threadId);
          if (event.type === "upsert") {
            const remaining = (current ?? []).filter(
              (item) => item.terminalId !== event.terminal.terminalId,
            );
            return event.terminal.threadId === target.threadId
              ? [...remaining, event.terminal]
              : remaining;
          }
          return (current ?? []).filter((item) => item.terminalId !== event.terminalId);
        });
      },
      (error) => queryClient.setQueryData([...metadataKey, "error"], error),
    );
    return () => stream.release();
  }, [factoryId, lease, queryClient, target.registrationId, target.environmentId, target.threadId]);
  const threadTerminals = metadata.data?.filter((item) => item.threadId === target.threadId) ?? [];
  const terminalId = threadTerminals.some((item) => item.terminalId === selectedId)
    ? selectedId
    : (threadTerminals[0]?.terminalId ?? "");
  const bufferKey = [
    ...threadDetailKey(factoryId, target.environmentId, target.threadId, target.registrationId),
    "terminal-output",
    terminalId,
  ] as const;
  const buffer = useQuery<TerminalOutputState>({
    queryKey: bufferKey,
    queryFn: skipToken,
    staleTime: Infinity,
  });
  const attachIdentity = terminalAttachIdentity(targetIdentity, terminalId, lease?.sessionId);
  const [attachIntent, setAttachIntent] = useState(() =>
    createTerminalAttachIntent(attachIdentity),
  );
  const currentAttachIntent = syncTerminalAttachIntent(attachIntent, attachIdentity);
  if (currentAttachIntent !== attachIntent) setAttachIntent(currentAttachIntent);
  const attachRequested = isTerminalAttachRequested(currentAttachIntent);
  useEffect(() => {
    if (lease === undefined || terminalId === "" || stale || !attachRequested) return;
    const streamKey = [
      ...threadDetailKey(factoryId, target.environmentId, target.threadId, target.registrationId),
      "terminal-output",
      terminalId,
    ] as const;
    queryClient.setQueryData<TerminalOutputState>(streamKey, (current) =>
      beginTerminalOutput(current),
    );
    const stream = lease.acquireStream(
      `terminal-attach:${JSON.stringify([target.registrationId, target.environmentId, target.threadId, terminalId])}`,
      (client) => attachExistingTerminal(client, target.threadId, terminalId),
      (event) => {
        queryClient.removeQueries({ queryKey: [...streamKey, "error"], exact: true });
        queryClient.setQueryData<TerminalOutputState>(streamKey, (current) =>
          appendTerminalOutput(current, event),
        );
      },
      (error) => queryClient.setQueryData([...streamKey, "error"], error),
    );
    return () => stream.release();
  }, [
    factoryId,
    lease,
    queryClient,
    target.registrationId,
    target.environmentId,
    target.threadId,
    terminalId,
    stale,
    attachRequested,
  ]);
  const attachError = useQuery<unknown>({ queryKey: [...bufferKey, "error"], queryFn: skipToken });
  const output = terminalOutputPresentation(buffer.data);

  return (
    <section className={styles.terminal} aria-label="PTY terminal output">
      <header className={styles.toolbar}>
        <div className={styles.terminalTitle}>
          <h3>Existing PTY output</h3>
          <Badge appearance="outline">Control required</Badge>
        </div>
        {threadTerminals.length > 1 ? (
          <Select
            size="small"
            value={terminalId}
            onChange={(event) => setSelectedId(event.currentTarget.value)}
            aria-label="Select an existing terminal"
          >
            {threadTerminals.map((item) => (
              <option key={item.terminalId} value={item.terminalId}>
                {item.label} · {item.status}
              </option>
            ))}
          </Select>
        ) : null}
      </header>
      <p className={styles.terminalMeta}>
        Attaching requires factory:control and source terminal:operate access on a fresh source.
        This view does not send input or request process creation, restart, or resize.
      </p>
      {terminalId !== "" ? (
        <Button
          appearance="secondary"
          size="small"
          disabled={lease === undefined || stale}
          onClick={() =>
            setAttachIntent((current) => toggleTerminalAttachIntent(current, attachIdentity))
          }
        >
          {attachRequested ? "Detach terminal output" : "Attach terminal output"}
        </Button>
      ) : null}
      {metadataError.data !== undefined ? (
        <MessageBar intent="error">
          Unable to read terminal metadata:{" "}
          {metadataError.data instanceof Error
            ? metadataError.data.message
            : "The source returned an error."}
        </MessageBar>
      ) : null}
      {threadTerminals.length === 0 ? (
        metadataError.data !== undefined ? null : (
          <MessageBar intent={stale ? "warning" : "info"}>
            {stale
              ? "No cached PTY output is available while the source is stale."
              : "No existing terminal was reported for this thread. Viewing does not start a process."}
          </MessageBar>
        )
      ) : attachError.data !== undefined ? (
        <MessageBar intent="error">
          Terminal attach failed. Check factory:control, source terminal:operate access, and source
          freshness:{" "}
          {attachError.data instanceof Error
            ? attachError.data.message
            : "The source denied or ended this terminal stream."}
        </MessageBar>
      ) : (
        <>
          <p className={styles.terminalMeta}>
            {stale
              ? "Cached output from an existing terminal. No new attachment was opened while the source is stale."
              : attachRequested
                ? !output.ready
                  ? "Requesting terminal output. The source checks factory:control and terminal:operate access."
                  : "Attached to an existing terminal for output only. The source enforces factory:control and terminal:operate access."
                : "Terminal output is detached. Attach explicitly to receive output."}
          </p>
          {attachRequested && !output.ready ? (
            <p className={styles.terminalMeta}>Waiting for the terminal snapshot.</p>
          ) : null}
          {output.truncated ? (
            <MessageBar intent="warning">
              Older streamed output was discarded. Showing the retained snapshot history and latest
              100 output events; there may be a gap between them.
            </MessageBar>
          ) : null}
          {output.status === "exited" || output.status === "closed" ? (
            <MessageBar intent="info">
              The source reported this terminal as {output.status}. Retained output remains
              available.
            </MessageBar>
          ) : null}
          {output.error ? (
            <MessageBar intent="error">Terminal output error: {output.error}</MessageBar>
          ) : null}
          <pre className={styles.output} aria-live="off">
            {output.text}
          </pre>
        </>
      )}
    </section>
  );
}
