import { useState } from "react";
import type { FactoryFrameTarget } from "@t3tools/contracts/factory";
import { Button, Card } from "../../design-system/actions";
import { MessageBar } from "../../design-system/forms";
import type { SourceLease } from "../../factory/sourceSessions";
import {
  useThreadBoundedQuery,
  useThreadEventStream,
  useThreadHistoryPageQuery,
} from "../../factory/sourceDetailHooks";
import styles from "./SessionActivityView.module.css";

interface Props {
  readonly factoryId: string;
  readonly target: FactoryFrameTarget;
  readonly lease?: SourceLease;
  readonly stale: boolean;
  readonly workspaceRoot?: string;
}

function show(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "Not available";
}

export default function SessionActivityView({ factoryId, target, lease, stale }: Props) {
  const snapshot = useThreadBoundedQuery(factoryId, target, lease);
  const targetIdentity = JSON.stringify([
    target.registrationId,
    target.environmentId,
    target.threadId,
  ]);
  const [page, setPage] = useState<{ readonly target: string; readonly cursor?: string }>(() => ({
    target: targetIdentity,
  }));
  const cursor = page.target === targetIdentity ? page.cursor : undefined;
  const historyCursor = cursor ?? snapshot.data?.historyCursor ?? undefined;
  const history = useThreadHistoryPageQuery(factoryId, target, lease, historyCursor);
  const events = useThreadEventStream(factoryId, target, lease, snapshot.data?.snapshotSequence);
  const loadOlder = () => {
    const next = history.data?.nextCursor;
    if (next) setPage({ target: targetIdentity, cursor: next });
  };

  return (
    <main className={styles.view}>
      {snapshot.data?.payloadBudgetExceeded === true ? (
        <MessageBar intent="warning">
          The source reports that this snapshot exceeded its size limit. Some history is not
          available.
        </MessageBar>
      ) : null}
      <section aria-label="Provider history">
        <h3>Provider history</h3>
        {snapshot.isError && snapshot.data === undefined ? (
          <MessageBar intent="error">
            Unable to read history metadata:{" "}
            {snapshot.error instanceof Error
              ? snapshot.error.message
              : "The source returned an error."}
          </MessageBar>
        ) : null}
        {snapshot.data !== undefined ? (
          <>
            <h4>Recent items</h4>
            {snapshot.data.projection.visibleTurnItems.length === 0 ? (
              <p>No recent provider history was returned.</p>
            ) : (
              <pre>{show(snapshot.data.projection.visibleTurnItems)}</pre>
            )}
          </>
        ) : null}
        {history.isError ? (
          <MessageBar intent="error">
            Unable to read history:{" "}
            {history.error instanceof Error
              ? history.error.message
              : "The source returned an error."}
          </MessageBar>
        ) : history.data === undefined ? (
          snapshot.data !== undefined && snapshot.data.historyCursor === null ? (
            <p>No older provider history is available.</p>
          ) : stale ? (
            <p>No cached history is available while the source is stale.</p>
          ) : (
            <p>Loading the bounded history page.</p>
          )
        ) : (
          <>
            <p>
              Snapshot sequence {history.data.snapshotSequence}. Showing {history.data.items.length}{" "}
              bounded items.
            </p>
            <ol className={styles.items}>
              {history.data.items.map((item) => (
                <li key={`${item.sourceThreadId}:${item.sourceItemId}`}>
                  <Card appearance="outline" className={styles.item}>
                    <header>
                      <span>Item {item.position}</span>
                      <span>{item.visibility}</span>
                    </header>
                    <pre>{show(item.item)}</pre>
                  </Card>
                </li>
              ))}
            </ol>
            {history.data.hasMoreHistory && history.data.nextCursor ? (
              <Button appearance="secondary" onClick={loadOlder}>
                Load older history
              </Button>
            ) : null}
            {history.data.hasMoreHistory && !history.data.nextCursor ? (
              <p role="status">
                More history exists, but the source did not return a continuation cursor.
              </p>
            ) : null}
          </>
        )}
      </section>
      <section aria-label="Provider events">
        <h3>Provider events</h3>
        {events.streamError !== undefined ? (
          <MessageBar intent="error">
            Unable to read provider events:{" "}
            {events.streamError instanceof Error
              ? events.streamError.message
              : "The source returned an error."}
          </MessageBar>
        ) : null}
        {events.data === undefined ? (
          <p>
            {stale
              ? "No cached provider events are available while the source is stale."
              : "Waiting for provider events."}
          </p>
        ) : events.data.length === 0 ? (
          <p>No provider events were received.</p>
        ) : (
          <ol className={styles.items}>
            {events.data.map((event, index) => (
              <li key={index}>
                <pre className={styles.event}>{show(event)}</pre>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
