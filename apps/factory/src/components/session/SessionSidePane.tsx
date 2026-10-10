import { lazy, Suspense, useState } from "react";
import type {
  FactoryFrameTarget,
  FactorySourceFreshness,
  FactoryThreadKey,
  FactoryThreadSummary,
} from "@t3tools/contracts/factory";
import {
  Files,
  GitCompareArrows,
  History,
  LayoutDashboard,
  ListTree,
  Maximize2,
  MessageSquare,
  Minimize2,
  Terminal,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  MenuButton,
  Tab,
  TabList,
  Toolbar,
  ToolbarButton,
  Tooltip,
} from "../../design-system/actions";
import {
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
} from "../../design-system/forms";
import { useFactoryConnectionStatus } from "../../factory/hooks";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import { useSourceLease } from "../../factory/useSourceLease";
import { useT3Store } from "../../store/useT3Store";
import { getSessionStatePresentation } from "../dashboard/sessionState";
import { frameTargetKey } from "../../factory/queryKeys";
import styles from "./SessionSidePane.module.css";
import SessionActionControls from "./SessionActionControls";

const SessionOverviewView = lazy(() => import("./SessionOverviewView"));
const WorkspaceFilesView = lazy(() => import("./WorkspaceFilesView"));
const DiffInspectorView = lazy(() => import("./DiffInspectorView"));
const CheckpointsTimelineView = lazy(() => import("./CheckpointsTimelineView"));
const SessionActivityView = lazy(() => import("./SessionActivityView"));
const PtyTerminalView = lazy(() => import("./PtyTerminalView"));
const ChatIframeView = lazy(() => import("./ChatIframeView"));

type DetailTab = "overview" | "files" | "diffs" | "checkpoints" | "history" | "terminal" | "chat";
const detailViews = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "files", label: "Files", icon: Files },
  { value: "diffs", label: "Diffs", icon: GitCompareArrows },
  { value: "checkpoints", label: "Checkpoints", icon: History },
  { value: "history", label: "History and events", icon: ListTree },
  { value: "terminal", label: "Terminal output", icon: Terminal },
  { value: "chat", label: "Chat", icon: MessageSquare },
] as const;

interface SessionSidePaneProps {
  readonly target: FactoryThreadKey;
  readonly thread: FactoryThreadSummary | undefined;
  readonly connection: FactoryConnectionApi;
  readonly factoryId: string;
  readonly workspaceRoot?: string;
  readonly sourceLabel?: string;
  readonly sourceFreshness?: FactorySourceFreshness;
}

const freshnessLabels: Record<FactorySourceFreshness["state"], string> = {
  synchronizing: "Synchronizing",
  fresh: "Fresh",
  stale: "Stale",
  offline: "Offline",
  blocked: "Blocked",
};

const freshnessColors: Record<
  FactorySourceFreshness["state"],
  "success" | "warning" | "neutral" | "danger"
> = {
  synchronizing: "warning",
  fresh: "success",
  stale: "warning",
  offline: "neutral",
  blocked: "danger",
};

function isDetailTab(value: string): value is DetailTab {
  return ["overview", "files", "diffs", "checkpoints", "history", "terminal", "chat"].includes(
    value,
  );
}

export function SessionSidePane(props: SessionSidePaneProps) {
  const identity = JSON.stringify([
    props.factoryId,
    props.thread?.target.registrationId,
    props.target.environmentId,
    props.target.threadId,
    props.workspaceRoot,
  ]);
  return <TargetSessionSidePane key={identity} {...props} />;
}

function TargetSessionSidePane({
  target,
  thread,
  connection,
  factoryId,
  workspaceRoot,
  sourceLabel,
  sourceFreshness,
}: SessionSidePaneProps) {
  const viewMode = useT3Store((state) => state.viewMode);
  const setViewMode = useT3Store((state) => state.setViewMode);
  const setSelectedTarget = useT3Store((state) => state.setSelectedTarget);
  const factoryStatus = useFactoryConnectionStatus(connection);
  const [retryError, setRetryError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const [tab, setTab] = useState<DetailTab>("overview");
  const canAcquire =
    thread !== undefined && factoryStatus.phase === "online" && sourceFreshness?.state === "fresh";
  const source = useSourceLease(connection, target.environmentId, canAcquire);
  const identityChanged =
    source.lease !== undefined && source.lease.registrationId !== thread?.target.registrationId;
  const accessBlocked =
    sourceFreshness?.state === "blocked" || source.status.phase === "blocked" || identityChanged;
  const lease =
    canAcquire && !accessBlocked && source.status.phase === "online" ? source.lease : undefined;
  const close = () => setSelectedTarget(null);
  const state = thread ? getSessionStatePresentation(thread.classification) : undefined;
  const sourceIsStale = !canAcquire || lease === undefined;
  const currentView = detailViews.find((view) => view.value === tab)!;
  const frameTarget: FactoryFrameTarget | undefined =
    thread === undefined ||
    thread.key.environmentId !== target.environmentId ||
    thread.key.threadId !== target.threadId
      ? undefined
      : {
          registrationId: thread.target.registrationId,
          environmentId: target.environmentId,
          threadId: target.threadId,
        };
  const chatReady =
    frameTarget !== undefined && !connection.simulated && !sourceIsStale && lease !== undefined;
  const chatUnavailableReason = (() => {
    if (connection.simulated) return "Chat is not available in the development fixture.";
    if (factoryStatus.phase === "unauthenticated")
      return "Sign in to the factory before opening chat.";
    if (factoryStatus.phase === "offline") return "The factory is offline. Chat is not available.";
    if (factoryStatus.phase === "blocked")
      return "The factory connection is blocked. Chat is not available.";
    if (factoryStatus.phase === "connecting" || factoryStatus.phase === "synchronizing") {
      return "The factory is connecting. Chat will be available when it is ready.";
    }
    if (sourceFreshness?.state === "blocked" || source.status.phase === "blocked") {
      return "Access to the source is blocked. Chat is not available.";
    }
    if (sourceFreshness?.state === "offline" || source.status.phase === "offline") {
      return "The source is offline. Chat is not available.";
    }
    if (sourceFreshness?.state === "stale") return "Source data is stale. Chat is not available.";
    if (sourceFreshness?.state === "synchronizing" || source.status.phase === "connecting") {
      return "The source is connecting. Chat will be available when it is ready.";
    }
    return source.error ?? "The source is not ready. Chat is not available.";
  })();

  const activeView = (() => {
    if (accessBlocked)
      return (
        <MessageBar intent="error">
          {identityChanged
            ? "The source registration changed. Re-select this session from the current overview."
            : "Access to the source is blocked. Re-enroll or repair access in Nodes. Protected details are unavailable."}
        </MessageBar>
      );
    if (frameTarget === undefined)
      return <MessageBar intent="error">The selected session identity is not complete.</MessageBar>;
    const viewProps = {
      factoryId,
      target: frameTarget,
      lease,
      workspaceRoot,
      stale: sourceIsStale,
    };
    switch (tab) {
      case "overview":
        return <SessionOverviewView {...viewProps} thread={thread} actions={connection.actions} />;
      case "files":
        return <WorkspaceFilesView {...viewProps} />;
      case "diffs":
        return <DiffInspectorView {...viewProps} />;
      case "checkpoints":
        return (
          <CheckpointsTimelineView {...viewProps} thread={thread} actions={connection.actions} />
        );
      case "history":
        return <SessionActivityView {...viewProps} />;
      case "terminal":
        return <PtyTerminalView {...viewProps} />;
      case "chat":
        return frameTarget === undefined ? (
          <MessageBar intent="error">
            The selected session identity is not complete. Re-select the session before opening
            chat.
          </MessageBar>
        ) : (
          <ChatIframeView
            key={frameTargetKey(frameTarget)}
            factoryId={factoryId}
            target={frameTarget}
            connection={connection}
            sourceReady={chatReady}
            unavailableReason={chatUnavailableReason}
          />
        );
    }
  })();

  return (
    <section
      className={styles.pane}
      aria-label={thread ? `Session ${thread.title}` : "Session summary"}
    >
      <header className={styles.header}>
        <Tooltip
          content={thread?.title ?? "Session is no longer available"}
          relationship="description"
        >
          <h2 className={`${styles.title} ${thread !== undefined ? styles.desktopTitle : ""}`}>
            {thread?.title ?? "Session is no longer available"}
          </h2>
        </Tooltip>
        {thread !== undefined ? (
          <>
            <div className={styles.viewMenu}>
              <Menu
                positioning="below-start"
                checkedValues={{ view: [tab] }}
                onCheckedValueChange={(_, data) => {
                  const value = data.checkedItems[0];
                  if (data.name === "view" && value !== undefined && isDetailTab(value))
                    setTab(value);
                }}
              >
                <Tooltip
                  content={`${currentView.label} - ${thread.title}`}
                  relationship="description"
                >
                  <MenuTrigger>
                    <MenuButton
                      appearance="subtle"
                      size="small"
                      className={styles.menuButton}
                      icon={<currentView.icon size={16} aria-hidden="true" />}
                    >
                      <span className={styles.menuLabel}>
                        {currentView.label} - {thread.title}
                      </span>
                    </MenuButton>
                  </MenuTrigger>
                </Tooltip>
                <MenuPopover>
                  <MenuList>
                    {detailViews.map((view) => (
                      <MenuItemRadio
                        key={view.value}
                        name="view"
                        value={view.value}
                        persistOnClick={false}
                        icon={<view.icon size={16} aria-hidden="true" />}
                      >
                        {view.label}
                      </MenuItemRadio>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </div>
            <div className={styles.wideNavigation}>
              <TabList
                selectedValue={tab}
                size="small"
                onTabSelect={(_, data) => {
                  if (typeof data.value === "string" && isDetailTab(data.value)) setTab(data.value);
                }}
                aria-label="Session detail views"
              >
                {detailViews.map((view) => (
                  <Tab key={view.value} value={view.value}>
                    {view.label}
                  </Tab>
                ))}
              </TabList>
            </div>
          </>
        ) : null}
        <Toolbar className={styles.actions} aria-label="Session pane actions">
          <Tooltip
            content={viewMode === "fullscreen" ? "Switch to split view" : "Expand to fullscreen"}
            relationship="label"
          >
            <ToolbarButton
              icon={viewMode === "fullscreen" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              aria-label={
                viewMode === "fullscreen" ? "Switch to split view" : "Expand to fullscreen"
              }
              onClick={() => setViewMode(viewMode === "fullscreen" ? "split" : "fullscreen")}
            />
          </Tooltip>
          <Tooltip content="Close session pane" relationship="label">
            <ToolbarButton icon={<X size={16} />} aria-label="Close session pane" onClick={close} />
          </Tooltip>
        </Toolbar>
      </header>
      {thread === undefined ? (
        <p className={styles.deleted} role="status">
          This thread is not in the current overview. Close this pane to return to the project list.
        </p>
      ) : (
        <>
          {sourceIsStale ? (
            <MessageBar intent="warning" className={styles.detailNotice}>
              {source.error ??
                (source.status.phase === "connecting"
                  ? "Connecting to the source. New detail reads are paused until it is ready."
                  : "Source data is not fresh. New detail reads are paused. Cached details remain available as stale data.")}
              {canAcquire && source.status.phase === "offline" && !accessBlocked ? (
                <Button
                  appearance="secondary"
                  size="small"
                  disabled={retrying}
                  onClick={async () => {
                    setRetryError(undefined);
                    setRetrying(true);
                    try {
                      await connection.retrySource(target.environmentId);
                    } catch (error) {
                      setRetryError(
                        error instanceof Error
                          ? error.message
                          : "The source connection could not be retried.",
                      );
                    } finally {
                      setRetrying(false);
                    }
                  }}
                >
                  Retry source connection
                </Button>
              ) : null}
            </MessageBar>
          ) : null}
          {retryError ? <MessageBar intent="error">{retryError}</MessageBar> : null}
          <div className={styles.tabPanel} role="tabpanel" aria-label={tab}>
            {tab === "overview" ? (
              <>
                <div className={styles.metadata} aria-label="Session identity and status">
                  <Badge mono appearance="outline" title="Environment ID">
                    {target.environmentId}
                  </Badge>
                  <Badge mono appearance="outline" title="Thread ID">
                    {target.threadId}
                  </Badge>
                  {sourceFreshness ? (
                    <Badge color={freshnessColors[sourceFreshness.state]} dot>
                      {freshnessLabels[sourceFreshness.state]}
                    </Badge>
                  ) : null}
                  {state ? (
                    <Badge color={state.color} dot pulse={state.pulse}>
                      {state.label}
                    </Badge>
                  ) : null}
                  {sourceLabel ? <Badge appearance="ghost">{sourceLabel}</Badge> : null}
                </div>
                {!accessBlocked && frameTarget !== undefined ? (
                  <SessionActionControls
                    factoryId={factoryId}
                    target={frameTarget}
                    thread={thread}
                    lease={lease}
                    stale={sourceIsStale}
                    actions={connection.actions}
                  />
                ) : null}
              </>
            ) : null}
            <Suspense
              fallback={
                <p className={styles.loading} aria-busy="true">
                  Loading session detail.
                </p>
              }
            >
              {activeView}
            </Suspense>
          </div>
        </>
      )}
    </section>
  );
}
