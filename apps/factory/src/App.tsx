import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useT3Store } from "./store/useT3Store";
import { Header, type MobileSection } from "./components/layout/Header";
import { FactoryAuthGate } from "./components/auth/FactoryAuthGate";
import { FavoriteProjectsGrid } from "./components/dashboard/FavoriteProjectsGrid";
import { ProjectTreeTable } from "./components/dashboard/ProjectTreeTable";
import { SessionSidePane } from "./components/session/SessionSidePane";
import { ServeNodesView } from "./components/nodes/ServeNodesView";
import { NewThreadModal } from "./components/modals/NewThreadModal";
import { Badge, Button, Toolbar } from "./design-system/actions";
import { Columns3, FolderGit2 } from "lucide-react";
import styles from "./App.module.css";
import type { ConnectionReason, FactoryConnectionApi } from "./factory/FactoryConnection";
import { createFactoryConnection } from "./factory/connectionFactory";
import { FactoryQueryBridge } from "./factory/queryBridge";
import { useFactoryConnectionStatus, useFactoryOverviewQuery } from "./factory/hooks";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5000,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <T3FactoryApp />
    </QueryClientProvider>
  );
}

function T3FactoryApp() {
  const [connection, setConnection] = useState<FactoryConnectionApi>();
  const [initializationError, setInitializationError] = useState<string>();

  React.useEffect(() => {
    let mounted = true;
    let owner: FactoryConnectionApi | undefined;
    let bridge: FactoryQueryBridge | undefined;
    void createFactoryConnection()
      .then((created) => {
        if (!mounted) {
          void created.stop();
          return;
        }
        owner = created;
        bridge = new FactoryQueryBridge(created, queryClient);
        bridge.start();
        created.start();
        setConnection(created);
      })
      .catch((error) => {
        if (!mounted) return;
        setInitializationError(
          error instanceof Error ? error.message : "The factory connection could not start.",
        );
      });

    return () => {
      mounted = false;
      bridge?.stop();
      if (owner !== undefined) void owner.stop();
    };
  }, []);

  if (initializationError !== undefined) {
    return (
      <main role="alert">
        <h1>Factory connection unavailable</h1>
        <p>{initializationError}</p>
      </main>
    );
  }
  if (connection === undefined) {
    return (
      <main aria-busy="true">
        <p>Connecting to the factory.</p>
      </main>
    );
  }
  return <FactoryAppShell connection={connection} />;
}

function FactoryAppShell({ connection }: { readonly connection: FactoryConnectionApi }) {
  const [currentView, setCurrentView] = useState<"overview" | "nodes">("overview");
  const [mobileTab, setMobileTab] = useState<MobileSection>("all");
  const [knownFactoryId, setKnownFactoryId] = useState<string>();
  const status = useFactoryConnectionStatus(connection);
  const [checkingAuthorization, setCheckingAuthorization] = useState(false);
  React.useEffect(() => {
    if (status.phase !== "connecting") setCheckingAuthorization(false);
    if (connection.factoryId !== undefined) setKnownFactoryId(connection.factoryId);
  }, [status.phase, connection]);
  const overviewQuery = useFactoryOverviewQuery(knownFactoryId ?? "");
  const snapshot = overviewQuery.data;
  const theme = useT3Store((state) => state.theme);
  const viewMode = useT3Store((state) => state.viewMode);
  const selectedTarget = useT3Store((state) => state.selectedTarget);
  const setSelectedTarget = useT3Store((state) => state.setSelectedTarget);
  const setViewMode = useT3Store((state) => state.setViewMode);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (
    status.phase === "unauthenticated" ||
    (checkingAuthorization && status.phase === "connecting")
  ) {
    return (
      <FactoryAuthGate
        onRetry={() => {
          setCheckingAuthorization(true);
          connection.retry();
        }}
        retrying={checkingAuthorization}
      />
    );
  }
  if (
    status.phase === "connecting" ||
    (status.phase === "synchronizing" && snapshot === undefined)
  ) {
    return (
      <main aria-busy="true">
        <p>Connecting to the factory and synchronizing the overview.</p>
      </main>
    );
  }
  if (status.reason === "overview-too-large") {
    return (
      <div className={styles.appShell}>
        <main className={styles.main}>
          <section role="alert">
            <h1>Factory overview exceeds its limit</h1>
            <p>
              No complete overview is available. Disable or remove a source below, then retry the
              overview. Session controls are paused.
            </p>
            <Button appearance="primary" onClick={() => connection.retry()}>
              Retry overview
            </Button>
          </section>
          <ServeNodesView
            connection={connection}
            factoryId={knownFactoryId ?? connection.factoryId ?? ""}
            onBackToOverview={() => connection.retry()}
          />
        </main>
      </div>
    );
  }
  if (status.phase === "blocked") {
    return (
      <main role="alert">
        <h1>Factory unavailable</h1>
        <p>{blockedReasonCopy(status.reason)}</p>
        <Button appearance="primary" onClick={() => connection.retry()}>
          Retry
        </Button>
      </main>
    );
  }

  if (snapshot === undefined) {
    return (
      <main role="alert">
        <h1>Factory overview unavailable</h1>
        <p>
          The complete overview is not available. The project list was not replaced with empty data.
        </p>
        <Button appearance="primary" onClick={() => connection.retry()}>
          Retry connection
        </Button>
      </main>
    );
  }

  const selectedThread =
    selectedTarget === null
      ? undefined
      : snapshot.threads.find(
          (thread) =>
            thread.key.environmentId === selectedTarget.environmentId &&
            thread.key.threadId === selectedTarget.threadId,
        );
  const selectedFreshness =
    selectedThread === undefined
      ? undefined
      : snapshot.sourceFreshness.find(
          (source) =>
            source.target.registrationId === selectedThread.target.registrationId &&
            source.target.environmentId === selectedThread.target.environmentId,
        );
  const selectedProject =
    selectedThread === undefined
      ? undefined
      : snapshot.projects.find(
          (project) =>
            project.key.environmentId === selectedThread.key.environmentId &&
            project.key.projectId === selectedThread.project.projectId,
        );
  const workspaceRoot = selectedThread?.worktreePath ?? selectedProject?.workspaceRoot;
  const selectedSourceLabel =
    selectedThread === undefined
      ? undefined
      : snapshot.environments.find(
          (environment) =>
            environment.registrationId === selectedThread.target.registrationId &&
            environment.environmentId === selectedThread.target.environmentId,
        )?.label;
  const showSelected =
    selectedTarget !== null && (viewMode === "split" || viewMode === "fullscreen");

  return (
    <div className={styles.appShell}>
      {connection.simulated ? (
        <p className={styles.fixtureNotice} role="status">
          <Badge color="warning" appearance="tint">
            Simulated development data
          </Badge>
        </p>
      ) : null}
      {status.phase === "offline" ? (
        <p className={styles.connectionNotice} role="status">
          Factory connection is offline. Showing the last complete overview.
        </p>
      ) : null}
      <Header
        currentView={currentView}
        setCurrentView={setCurrentView}
        mobileSection={mobileTab}
        setMobileSection={setMobileTab}
        snapshot={snapshot}
      />
      <main className={styles.main}>
        {currentView === "nodes" ? (
          <div className={styles.nodesView}>
            <ServeNodesView
              connection={connection}
              factoryId={knownFactoryId ?? ""}
              onBackToOverview={() => setCurrentView("overview")}
              snapshot={snapshot}
            />
          </div>
        ) : showSelected && viewMode === "fullscreen" ? (
          <div className={styles.fullscreenSession}>
            <SessionSidePane
              target={selectedTarget}
              thread={selectedThread}
              connection={connection}
              factoryId={knownFactoryId ?? ""}
              workspaceRoot={workspaceRoot}
              sourceFreshness={selectedFreshness}
              sourceLabel={selectedSourceLabel}
            />
          </div>
        ) : showSelected ? (
          <div className={styles.splitLayout}>
            <Toolbar className={styles.mobileBackBar} aria-label="Session navigation">
              <Button
                appearance="subtle"
                onClick={() => {
                  setSelectedTarget(null);
                  setViewMode("dashboard");
                }}
              >
                Back to projects
              </Button>
              <span className={styles.mobileSessionId}>{selectedTarget.threadId}</span>
            </Toolbar>
            <aside className={styles.navigatorPane}>
              <header className={styles.navigatorHeader}>
                <div className={styles.navigatorTitle}>
                  <Columns3 size={16} aria-hidden="true" />
                  <h2 className={styles.sectionHeading}>Session Navigator</h2>
                </div>
                <Badge color="neutral" appearance="tint">
                  Split mode
                </Badge>
              </header>
              <section className={styles.navigatorContent} aria-label="Projects and sessions">
                <ProjectTreeTable snapshot={snapshot} connection={connection} />
              </section>
            </aside>
            <section className={styles.sessionPane} aria-label="Selected session">
              <SessionSidePane
                target={selectedTarget}
                thread={selectedThread}
                connection={connection}
                factoryId={knownFactoryId ?? ""}
                workspaceRoot={workspaceRoot}
                sourceFreshness={selectedFreshness}
                sourceLabel={selectedSourceLabel}
              />
            </section>
          </div>
        ) : (
          <div className={styles.dashboard} data-mobile-section={mobileTab}>
            <div className={styles.favoritesContent}>
              <FavoriteProjectsGrid
                snapshot={snapshot}
                connection={connection}
                onShowAll={() => setMobileTab("all")}
              />
            </div>
            <section className={styles.projectsSection}>
              <header className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>
                  <FolderGit2 size={16} aria-hidden="true" />
                  <h2 className={styles.sectionHeading}>All projects &amp; session threads</h2>
                </div>
                <p className={styles.sectionDescription}>
                  Current, non-archived sessions from every registered source
                </p>
              </header>
              <ProjectTreeTable snapshot={snapshot} connection={connection} />
            </section>
          </div>
        )}
      </main>
      <NewThreadModal factoryId={knownFactoryId ?? ""} connection={connection} />
    </div>
  );
}

function blockedReasonCopy(reason: ConnectionReason | null): string {
  if (reason === null) return "The factory connection is blocked.";
  const messages: Record<ConnectionReason, string> = {
    "auth-required": "Authorize this browser before you continue.",
    transport: "The factory connection failed. Retry to connect again.",
    "protocol-mismatch": "Factory support is disabled or uses an incompatible protocol.",
    permission: "This browser does not have permission to read factory data.",
    "identity-mismatch": "The factory identity changed. Retry to check it again.",
    "invalid-data": "The factory returned data that this app cannot use.",
    "overview-too-large": "The complete overview exceeds its limit. Manage sources to recover.",
  };
  return messages[reason];
}
