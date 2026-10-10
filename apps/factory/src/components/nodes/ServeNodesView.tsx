import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FactoryEnvironmentView, FactoryOverviewSnapshot } from "@t3tools/contracts/factory";
import { ArrowLeft, MoreHorizontal, Plus, Server } from "lucide-react";
import { Badge, Button, Card, MenuButton } from "../../design-system/actions";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
} from "../../design-system/forms";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import { formatTimestamp } from "../../factory/formatTimestamp";
import { factoryKeys } from "../../factory/queryKeys";
import { useFactoryConnectionStatus, useFactoryEnvironmentsQuery } from "../../factory/hooks";
import { useT3Store } from "../../store/useT3Store";
import { AddInstanceModal, type AddInstanceModalMode } from "../modals/AddInstanceModal";
import { environmentStatusMessage, renewalMessage } from "./nodesModel";
import styles from "./ServeNodesView.module.css";

interface ServeNodesViewProps {
  readonly connection: FactoryConnectionApi;
  readonly factoryId: string;
  readonly onBackToOverview: () => void;
  readonly snapshot?: FactoryOverviewSnapshot;
}

const environmentColors = {
  pending: "warning",
  online: "success",
  offline: "neutral",
  blocked: "danger",
  removing: "neutral",
} as const;

const freshnessColors = {
  synchronizing: "warning",
  fresh: "success",
  stale: "warning",
  offline: "neutral",
  blocked: "danger",
} as const;

type Notice = {
  readonly registrationId?: string;
  readonly message: string;
  readonly intent: "info" | "success" | "error";
};
type PendingAction = { readonly registrationId: string; readonly label: string };
type ManagementDialog = {
  readonly mode: AddInstanceModalMode;
  readonly environment?: FactoryEnvironmentView;
};

function sourceKey(registrationId: string, environmentId: string): string {
  return JSON.stringify([registrationId, environmentId]);
}

function storageLabel(environment: FactoryEnvironmentView): string {
  if (environment.credentialStorage === "secure-vault") return "OS credential vault";
  if (environment.credentialStorage === "protected-file")
    return "Protected file (host administrator configured)";
  return "Not available";
}

function renewalColor(
  environment: FactoryEnvironmentView,
): "success" | "warning" | "danger" | "neutral" {
  switch (environment.renewal) {
    case "ready":
      return "success";
    case "due":
      return "warning";
    case "failed":
    case "expired":
      return "danger";
    case "unsupported":
      return "neutral";
  }
}

export function ServeNodesView({
  connection,
  factoryId,
  onBackToOverview,
  snapshot,
}: ServeNodesViewProps) {
  const queryClient = useQueryClient();
  const status = useFactoryConnectionStatus(connection);
  const environmentsQuery = useFactoryEnvironmentsQuery(connection, factoryId);
  const sourceData = useMemo(() => {
    const projectCounts = new Map<string, number>();
    const threadCounts = new Map<string, number>();
    const freshnessBySource = new Map<string, FactoryOverviewSnapshot["sourceFreshness"][number]>();
    for (const project of snapshot?.projects ?? []) {
      const key = sourceKey(project.target.registrationId, project.key.environmentId);
      projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
    }
    for (const thread of snapshot?.threads ?? []) {
      const key = sourceKey(thread.target.registrationId, thread.target.environmentId);
      threadCounts.set(key, (threadCounts.get(key) ?? 0) + 1);
    }
    for (const freshness of snapshot?.sourceFreshness ?? []) {
      freshnessBySource.set(
        sourceKey(freshness.target.registrationId, freshness.target.environmentId),
        freshness,
      );
    }
    return { projectCounts, threadCounts, freshnessBySource };
  }, [snapshot]);
  const activeEnvironmentFilter = useT3Store((state) => state.activeEnvironmentFilter);
  const setActiveEnvironmentFilter = useT3Store((state) => state.setActiveEnvironmentFilter);
  const [managementDialog, setManagementDialog] = useState<ManagementDialog>();
  const [removeTarget, setRemoveTarget] = useState<FactoryEnvironmentView>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [notice, setNotice] = useState<Notice>();

  const refreshEnvironments = async () => {
    await queryClient.invalidateQueries({ queryKey: factoryKeys.environments(factoryId) });
  };

  const runAction = async (
    environment: FactoryEnvironmentView,
    label: string,
    action: () => Promise<string>,
  ) => {
    setPendingAction({ registrationId: environment.registrationId, label });
    setNotice(undefined);
    try {
      const message = await action();
      await refreshEnvironments();
      setNotice({ registrationId: environment.registrationId, message, intent: "success" });
    } catch {
      await refreshEnvironments();
      setNotice({
        registrationId: environment.registrationId,
        message:
          "The factory could not " +
          label.toLowerCase() +
          " this source. Refresh its status and try again.",
        intent: "error",
      });
    } finally {
      setPendingAction(undefined);
    }
  };

  const setEnabled = (environment: FactoryEnvironmentView, enabled: boolean) =>
    runAction(environment, enabled ? "Enable" : "Disable", async () => {
      const updated = await connection.request((client) =>
        client["factory.environments.update"]({
          registrationId: environment.registrationId,
          revision: environment.revision,
          enabled,
        }),
      );
      return updated.enabled
        ? "Source enabled. Status will update when the factory receives its next connection."
        : "Source disabled. Agents on the source are not stopped.";
    });

  const retryConnection = (environment: FactoryEnvironmentView) =>
    runAction(environment, "Retry connection", async () => {
      const result = await connection.request((client) =>
        client["factory.environments.retry"]({
          registrationId: environment.registrationId,
        }),
      );
      if (!result.requested)
        throw new Error("The factory did not accept the connection retry request.");
      return "Connection retry requested. The factory will update the source status.";
    });

  const confirmRemoval = async () => {
    const environment = removeTarget;
    if (environment === undefined) return;
    setPendingAction({ registrationId: environment.registrationId, label: "Remove" });
    setNotice(undefined);
    try {
      const result = await connection.request((client) =>
        client["factory.environments.remove"]({
          registrationId: environment.registrationId,
          revision: environment.revision,
        }),
      );
      await refreshEnvironments();
      if (result.removed && activeEnvironmentFilter === environment.environmentId) {
        setActiveEnvironmentFilter("all");
      }
      setRemoveTarget(undefined);
      setNotice({
        message: result.removed
          ? "Source removed from this factory. Agents and sessions on the source continue running."
          : "Removal is pending. The factory is still cleaning up this registration.",
        intent: result.removed ? "success" : "info",
      });
    } catch {
      await refreshEnvironments();
      setNotice({
        registrationId: environment.registrationId,
        message:
          "The factory could not remove this source. Cleanup may still be pending. Refresh its status and try again.",
        intent: "error",
      });
    } finally {
      setPendingAction(undefined);
    }
  };

  const environments = environmentsQuery.data;
  const managementReady =
    connection.factoryId === factoryId &&
    environmentsQuery.isSuccess &&
    !environmentsQuery.isFetching &&
    (status.phase === "online" || status.reason === "overview-too-large");

  return (
    <section className={styles.view}>
      <header className={styles.pageHeader}>
        <div className={styles.titleBlock}>
          <Button
            appearance="subtle"
            icon={<ArrowLeft size={16} aria-hidden="true" />}
            onClick={onBackToOverview}
          >
            Back
          </Button>
          <div>
            <h1>
              <Server size={20} aria-hidden="true" /> Serve sources
            </h1>
            <p>Manage source registrations and view factory-reported status.</p>
          </div>
        </div>
        <div className={styles.pageActions}>
          <Button
            appearance="secondary"
            disabled={environmentsQuery.isFetching}
            onClick={() => {
              void environmentsQuery.refetch();
            }}
          >
            Refresh sources
          </Button>
          <Button
            appearance="primary"
            icon={<Plus size={16} aria-hidden="true" />}
            disabled={!managementReady}
            onClick={() => setManagementDialog({ mode: "register" })}
          >
            Register source
          </Button>
        </div>
      </header>
      {notice !== undefined && notice.registrationId === undefined ? (
        <MessageBar intent={notice.intent}>{notice.message}</MessageBar>
      ) : null}
      {environmentsQuery.isPending ? (
        <p className={styles.empty} role="status">
          Loading registered sources from the factory.
        </p>
      ) : null}
      {environmentsQuery.isError ? (
        <MessageBar intent="error" role="alert">
          The source list is not available. The factory did not return an empty list. Refresh
          sources to retry.
        </MessageBar>
      ) : null}
      {environments !== undefined && environments.length === 0 ? (
        <p className={styles.empty}>No sources are registered with this factory.</p>
      ) : null}
      {environments !== undefined && environments.length > 0 ? (
        <section className={styles.nodeGrid} aria-label="Serve sources">
          {environments.map((environment) => {
            const key = sourceKey(environment.registrationId, environment.environmentId);
            const freshness = sourceData.freshnessBySource.get(key);
            const covered =
              snapshot?.environments.some(
                (source) =>
                  source.registrationId === environment.registrationId &&
                  source.environmentId === environment.environmentId,
              ) === true;
            const projects = covered ? (sourceData.projectCounts.get(key) ?? 0) : "Not available";
            const threads = covered ? (sourceData.threadCounts.get(key) ?? 0) : "Not available";
            const busy = pendingAction?.registrationId === environment.registrationId;
            const removable = environment.state !== "removing";
            const feedback =
              notice?.registrationId === environment.registrationId ? notice : undefined;
            return (
              <Card
                appearance="outline"
                className={styles.nodeCard}
                key={environment.registrationId}
              >
                <header className={styles.nodeHeader}>
                  <div className={styles.nodeName}>
                    <Badge color={environmentColors[environment.state]} dot>
                      {environment.state}
                    </Badge>
                    <h2>{environment.label}</h2>
                  </div>
                  {freshness ? (
                    <Badge color={freshnessColors[freshness.state]}>{freshness.state}</Badge>
                  ) : (
                    <Badge color="neutral">Coverage not available</Badge>
                  )}
                </header>
                <p className={styles.statusMessage} role="status">
                  {environmentStatusMessage(environment)}
                </p>
                {renewalMessage(environment) !== null ? (
                  <p className={styles.credentialWarning} role="status">
                    {renewalMessage(environment)}
                  </p>
                ) : null}
                <dl className={styles.details}>
                  <div>
                    <dt>Environment identity</dt>
                    <dd>
                      <code>{environment.environmentId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Registration</dt>
                    <dd>
                      <code>{environment.registrationId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Endpoint</dt>
                    <dd>
                      <code>{environment.endpoint}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Platform</dt>
                    <dd>
                      {environment.platform === null
                        ? "Not available"
                        : environment.platform.os + " · " + environment.platform.arch}
                    </dd>
                  </div>
                  <div>
                    <dt>Version and capabilities</dt>
                    <dd>Not reported by the factory contract</dd>
                  </div>
                  <div>
                    <dt>Projects</dt>
                    <dd>{projects}</dd>
                  </div>
                  <div>
                    <dt>Current, non-archived sessions</dt>
                    <dd>{threads}</dd>
                  </div>
                  <div>
                    <dt>Last successful contact</dt>
                    <dd>{formatTimestamp(environment.lastSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>Coverage freshness</dt>
                    <dd>
                      {freshness?.state ?? "Not available"}
                      {freshness?.reason ? " · " + freshness.reason : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>Credential storage</dt>
                    <dd>{storageLabel(environment)}</dd>
                  </div>
                  <div>
                    <dt>Credential renewal</dt>
                    <dd>
                      <Badge color={renewalColor(environment)}>{environment.renewal}</Badge>
                    </dd>
                  </div>
                  <div>
                    <dt>Credential expires</dt>
                    <dd>{formatTimestamp(environment.credentialExpiresAt)}</dd>
                  </div>
                </dl>
                <footer className={styles.nodeFooter}>
                  <div className={styles.nodeActions}>
                    <Menu positioning="below-end">
                      <MenuTrigger>
                        <MenuButton
                          appearance="secondary"
                          size="small"
                          icon={<MoreHorizontal size={16} />}
                          aria-label={"Manage " + environment.label}
                          disabled={busy || !managementReady}
                        />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem
                            disabled={busy || !managementReady || !removable}
                            onClick={() => setManagementDialog({ mode: "edit", environment })}
                          >
                            Edit registration
                          </MenuItem>
                          <MenuItem
                            disabled={
                              busy ||
                              !managementReady ||
                              !removable ||
                              (!environment.enabled && environment.state === "pending")
                            }
                            onClick={() => void setEnabled(environment, !environment.enabled)}
                          >
                            {environment.enabled ? "Disable source" : "Enable source"}
                          </MenuItem>
                          <MenuItem
                            disabled={
                              busy || !managementReady || !removable || !environment.enabled
                            }
                            onClick={() => void retryConnection(environment)}
                          >
                            Retry connection
                          </MenuItem>
                          <MenuItem
                            disabled={busy || !managementReady || !removable}
                            onClick={() => setManagementDialog({ mode: "reenroll", environment })}
                          >
                            Re-enroll credential
                          </MenuItem>
                          <MenuItem
                            disabled={busy || !managementReady || !removable}
                            onClick={() => setRemoveTarget(environment)}
                          >
                            Remove from factory
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </div>
                  {busy ? (
                    <span className={styles.pendingAction} role="status">
                      {pendingAction.label}…
                    </span>
                  ) : null}
                </footer>
                {feedback ? (
                  <p
                    className={
                      feedback.intent === "error" ? styles.actionFailure : styles.actionNotice
                    }
                    role={feedback.intent === "error" ? "alert" : "status"}
                  >
                    {feedback.message}
                  </p>
                ) : null}
              </Card>
            );
          })}
        </section>
      ) : null}
      <AddInstanceModal
        connection={connection}
        factoryId={factoryId}
        mode={managementDialog?.mode ?? "register"}
        environment={managementDialog?.environment}
        open={managementDialog !== undefined}
        onOpenChange={(open) => {
          if (!open) setManagementDialog(undefined);
        }}
        onSaved={() =>
          setNotice({ message: "The factory saved the source registration.", intent: "success" })
        }
      />
      <Dialog
        open={removeTarget !== undefined}
        onOpenChange={(_, data) => {
          if (!data.open) setRemoveTarget(undefined);
        }}
      >
        <DialogSurface size="small">
          <DialogHeader>
            <DialogTitle>Remove this source?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p>
              This removes the registration and stored credential from this factory. It does not
              stop agents or sessions on the source.
            </p>
            {notice?.intent === "error" &&
            notice.registrationId === removeTarget?.registrationId ? (
              <MessageBar intent="error" role="alert">
                {notice.message}
              </MessageBar>
            ) : null}
          </DialogBody>
          <DialogActions>
            <Button
              appearance="secondary"
              disabled={pendingAction !== undefined}
              onClick={() => setRemoveTarget(undefined)}
            >
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={pendingAction !== undefined || !managementReady}
              onClick={() => void confirmRemoval()}
            >
              {pendingAction?.label === "Remove" ? "Removing…" : "Remove source"}
            </Button>
          </DialogActions>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
