import { useEffect, useMemo, useRef, useState } from "react";
import type * as Effect from "effect/Effect";
import { Button } from "../../design-system/actions";
import {
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  Select,
  Textarea,
} from "../../design-system/forms";
import {
  createCommandId,
  createThreadId,
  sourceActionRecordText,
} from "../../factory/actionPolicy";
import {
  useFactoryConnectionStatus,
  useFactoryOverviewQuery,
  useSourceConfigQuery,
} from "../../factory/hooks";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import { useSourceLease } from "../../factory/useSourceLease";
import { useSourceActions } from "../../factory/useSourceActions";
import { targetKey } from "../../factory/queryKeys";
import { useSourceControlAuthorization } from "../../factory/useSourceAuthorization";
import type { SourceLease, SourceRpcClient } from "../../factory/sourceSessions";
import { defaultModelOptionValue, projectIdentity, resolveModelOptions } from "./launchOptions";
import type { ModelOptionDescriptor } from "./launchOptions";
import { useT3Store } from "../../store/useT3Store";
import styles from "./NewThreadModal.module.css";

interface NewThreadModalProps {
  readonly factoryId: string;
  readonly connection: FactoryConnectionApi;
}

type SourceConfig = Effect.Success<ReturnType<SourceRpcClient["server.getConfig"]>>;
type SourceProvider = SourceConfig["providers"][number];
type SourceModel = SourceProvider["models"][number];
type LaunchInput = Parameters<SourceRpcClient["orchestration.launchThread"]>[0];
type RuntimeMode = LaunchInput["runtimeMode"];
type InteractionMode = LaunchInput["interactionMode"];
type ModelOption = ModelOptionDescriptor;
type OptionValues = Record<string, string | boolean>;

const launchOperations = ["launch"] as const;

function eligibleProviders(config: SourceConfig | undefined): readonly SourceProvider[] {
  return (
    config?.providers.filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status !== "disabled" &&
        provider.status !== "error" &&
        provider.availability !== "unavailable" &&
        provider.auth.status === "authenticated" &&
        provider.supportsTextGeneration !== false &&
        provider.models.length > 0,
    ) ?? []
  );
}

function defaultModel(provider: SourceProvider | undefined): SourceModel | undefined {
  return provider?.models.find((model) => model.isDefault) ?? provider?.models[0];
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "The source did not return a result.";
}

export function NewThreadModal({ factoryId, connection }: NewThreadModalProps) {
  const open = useT3Store((state) => state.showNewThreadModal);
  const setOpen = useT3Store((state) => state.setShowNewThreadModal);
  const setSelectedTarget = useT3Store((state) => state.setSelectedTarget);
  const overview = useFactoryOverviewQuery(factoryId);
  const factoryStatus = useFactoryConnectionStatus(connection);
  const [projectId, setProjectId] = useState("");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [modelSlug, setModelSlug] = useState("");
  const [optionValues, setOptionValues] = useState<OptionValues>({});
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>();
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("default");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [launchError, setLaunchError] = useState<string>();
  const awaitingNavigation = useRef(new Set<string>());

  useEffect(() => {
    if (!open || overview.data === undefined) return;
    if (!overview.data.projects.some((project) => projectIdentity(project.key) === projectId)) {
      const firstProject = overview.data.projects[0];
      setProjectId(firstProject ? projectIdentity(firstProject.key) : "");
    }
  }, [open, overview.data, projectId]);

  const project = overview.data?.projects.find((item) => projectIdentity(item.key) === projectId);
  const environmentId = project?.key.environmentId ?? "";
  const sourceFresh =
    project !== undefined &&
    overview.data?.sourceFreshness.some(
      (source) =>
        source.target.registrationId === project.target.registrationId &&
        source.target.environmentId === project.key.environmentId &&
        source.state === "fresh",
    ) === true;
  const canAcquire =
    open && project !== undefined && sourceFresh && factoryStatus.phase === "online";
  const source = useSourceLease(connection, environmentId, canAcquire);
  const lease: SourceLease | undefined =
    source.status.phase === "online" ? source.lease : undefined;
  const authorization = useSourceControlAuthorization(factoryId, lease, launchOperations);
  const configQuery = useSourceConfigQuery(
    factoryId,
    environmentId,
    lease,
    canAcquire,
    project?.target.registrationId ?? "",
  );
  const providers = eligibleProviders(configQuery.data);
  const provider = providers.find((item) => item.instanceId === providerInstanceId) ?? providers[0];
  const model = provider?.models.find((item) => item.slug === modelSlug) ?? defaultModel(provider);
  const optionDescriptors = model?.capabilities?.optionDescriptors ?? [];
  const supportedModes = provider?.supportedRuntimeModes ?? [];
  const selectedRuntimeMode =
    supportedModes.find((mode) => mode === runtimeMode) ?? supportedModes[0];
  const interactionModes: readonly InteractionMode[] = provider?.showInteractionModeToggle
    ? ["default", "plan"]
    : ["default"];
  const selectedInteractionMode =
    interactionModes.find((mode) => mode === interactionMode) ?? "default";
  const overviewObservation = useMemo(
    () =>
      overview.data === undefined
        ? undefined
        : {
            type: "overview" as const,
            threadKeys: new Set(overview.data.threads.map((thread) => targetKey(thread.key))),
          },
    [overview.data],
  );
  const launchScope = {
    type: "launch",
    factoryId,
    environmentId,
    projectId: project?.key.projectId ?? "",
  } as const;
  const launchActions = useSourceActions(connection.actions, launchScope, overviewObservation);
  const latestLaunch = launchActions.records.at(-1);
  const pendingLaunch = launchActions.blocking;
  const submitting = pendingLaunch?.phase === "sending";

  useEffect(() => {
    if (providerInstanceId !== provider?.instanceId)
      setProviderInstanceId(provider?.instanceId ?? "");
    const nextModel = defaultModel(provider);
    if (
      modelSlug !==
      (provider?.models.some((item) => item.slug === modelSlug)
        ? modelSlug
        : (nextModel?.slug ?? ""))
    ) {
      setModelSlug(nextModel?.slug ?? "");
      setOptionValues({});
    }
    if (!supportedModes.some((mode) => mode === runtimeMode)) setRuntimeMode(supportedModes[0]);
    if (!interactionModes.some((mode) => mode === interactionMode)) setInteractionMode("default");
  }, [
    interactionMode,
    interactionModes,
    modelSlug,
    provider,
    providerInstanceId,
    runtimeMode,
    supportedModes,
  ]);

  useEffect(() => {
    const confirmed = latestLaunch?.phase === "confirmed" ? latestLaunch : undefined;
    if (
      !open ||
      confirmed === undefined ||
      confirmed.intent.kind !== "launch" ||
      !awaitingNavigation.current.delete(confirmed.commandId)
    )
      return;
    setSelectedTarget(confirmed.intent.target, "split");
    setOpen(false);
  }, [latestLaunch, open, setOpen, setSelectedTarget]);

  const canLaunch =
    open &&
    lease !== undefined &&
    factoryStatus.phase === "online" &&
    sourceFresh &&
    authorization.authorized &&
    configQuery.sourceSynchronized &&
    !configQuery.isFetching &&
    !configQuery.isError &&
    provider !== undefined &&
    model !== undefined &&
    selectedRuntimeMode !== undefined &&
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    pendingLaunch === undefined;

  const launch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !canLaunch ||
      project === undefined ||
      provider === undefined ||
      model === undefined ||
      selectedRuntimeMode === undefined ||
      lease === undefined
    )
      return;

    const commandId = createCommandId();
    const targetThreadId = createThreadId();
    const values = resolveModelOptions(optionDescriptors, optionValues);
    const request: LaunchInput = {
      commandId,
      creationSource: "web",
      threadId: targetThreadId,
      projectId: project.key.projectId,
      title: title.trim(),
      modelSelection: {
        instanceId: provider.instanceId,
        model: model.slug,
        ...(values.length === 0 ? {} : { options: values }),
      },
      runtimeMode: selectedRuntimeMode,
      interactionMode: selectedInteractionMode,
      workspaceStrategy: { type: "root" },
      initialMessage: { text: prompt.trim(), attachments: [] },
    };

    setLaunchError(undefined);
    const launchTarget = { environmentId: project.key.environmentId, threadId: targetThreadId };
    awaitingNavigation.current.add(commandId);
    try {
      await connection.actions.dispatch({
        scope: launchScope,
        commandId,
        intent: { kind: "launch", target: launchTarget },
        baseSequence: 0,
        state: {
          online: factoryStatus.phase === "online" && source.status.phase === "online",
          synchronized: sourceFresh,
          allowed: authorization.authorized,
        },
        request: (sentCommandId) => {
          if (sentCommandId !== request.commandId)
            throw new Error("The command ID changed before dispatch.");
          return lease.request((client) => client["orchestration.launchThread"](request));
        },
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "SourceCommandUncertainError")) {
        awaitingNavigation.current.delete(commandId);
        setLaunchError(errorText(error));
      }
    }
  };

  const sourceLabel = overview.data?.environments.find(
    (environment) =>
      environment.registrationId === project?.target.registrationId &&
      environment.environmentId === project?.key.environmentId,
  )?.label;

  if (!open) return null;

  return (
    <Dialog
      open
      onOpenChange={(_, data) => {
        if (!data.open) setOpen(false);
      }}
    >
      <DialogSurface size="medium">
        <form className={styles.form} onSubmit={launch}>
          <DialogHeader>
            <DialogTitle>Start a session</DialogTitle>
          </DialogHeader>
          <DialogBody className={styles.dialogBody}>
            <div className={styles.fields}>
              {launchError ? (
                <MessageBar intent="error" role="status">
                  {launchError}
                </MessageBar>
              ) : null}
              {latestLaunch ? (
                <MessageBar
                  intent={
                    latestLaunch.phase === "uncertain" || latestLaunch.phase === "rejected"
                      ? "error"
                      : "info"
                  }
                  role="status"
                >
                  {sourceActionRecordText(latestLaunch)}
                  {latestLaunch.phase === "uncertain"
                    ? " Check the factory overview before starting another session for this project."
                    : ""}
                </MessageBar>
              ) : null}
              {overview.data ? (
                overview.data.projects.length > 0 ? (
                  <Field label="Local project" required>
                    <Select
                      value={projectId}
                      onChange={(_, data) => setProjectId(data.value)}
                      required
                    >
                      {overview.data.projects.map((item) => {
                        const environment = overview.data?.environments.find(
                          (sourceItem) =>
                            sourceItem.registrationId === item.target.registrationId &&
                            sourceItem.environmentId === item.key.environmentId,
                        );
                        return (
                          <option key={projectIdentity(item.key)} value={projectIdentity(item.key)}>
                            {item.title} · {environment?.label ?? item.key.environmentId}
                          </option>
                        );
                      })}
                    </Select>
                  </Field>
                ) : (
                  <MessageBar intent="info">
                    No local projects are available in the complete factory overview.
                  </MessageBar>
                )
              ) : (
                <MessageBar intent="warning">
                  The local project list is unavailable until the factory overview synchronizes.
                </MessageBar>
              )}
              {project ? (
                <p className={styles.projectPath}>
                  <code>{project.workspaceRoot}</code>
                  {sourceLabel ? ` · ${sourceLabel}` : ""}
                </p>
              ) : null}
              {!sourceFresh && project ? (
                <MessageBar intent="warning">
                  This source is not fresh. Session launch is paused until it synchronizes.
                </MessageBar>
              ) : null}
              {source.error ? (
                <MessageBar intent="error">Source connection: {source.error}</MessageBar>
              ) : null}
              {configQuery.isError ? (
                <MessageBar intent="error">
                  Unable to read source provider capabilities: {errorText(configQuery.error)}{" "}
                  <Button
                    type="button"
                    appearance="secondary"
                    size="small"
                    onClick={() => {
                      void configQuery.refetch();
                    }}
                  >
                    Retry
                  </Button>
                </MessageBar>
              ) : null}
              {authorization.message ? (
                <MessageBar intent={authorization.phase === "error" ? "error" : "warning"}>
                  {authorization.message}
                </MessageBar>
              ) : null}
              {lease &&
              (configQuery.isFetching ||
                (!configQuery.sourceSynchronized && !configQuery.isError)) ? (
                <p role="status">
                  Reading provider and model capabilities from the source. Launch is paused until
                  this read completes.
                </p>
              ) : null}
              {configQuery.data && providers.length === 0 ? (
                <MessageBar intent="warning">
                  The source has no installed, authenticated provider with an available model.
                </MessageBar>
              ) : null}
              {provider ? (
                <>
                  <Field label="Provider" required>
                    <Select
                      value={provider.instanceId}
                      onChange={(_, data) => {
                        const next = providers.find((item) => item.instanceId === data.value);
                        if (!next) return;
                        setProviderInstanceId(next.instanceId);
                        setModelSlug(defaultModel(next)?.slug ?? "");
                        setOptionValues({});
                      }}
                    >
                      {providers.map((item) => (
                        <option key={item.instanceId} value={item.instanceId}>
                          {item.displayName ?? item.driver}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {model ? (
                    <Field label="Model" required>
                      <Select
                        value={model.slug}
                        onChange={(_, data) => {
                          const next = provider.models.find((item) => item.slug === data.value);
                          if (!next) return;
                          setModelSlug(next.slug);
                          setOptionValues({});
                        }}
                      >
                        {provider.models.map((item) => (
                          <option key={item.slug} value={item.slug}>
                            {item.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                  {optionDescriptors.map((option) =>
                    option.type === "boolean" ? (
                      <Checkbox
                        key={option.id}
                        checked={Boolean(
                          optionValues[option.id] ?? defaultModelOptionValue(option),
                        )}
                        onChange={(_, data) =>
                          setOptionValues((values) => ({
                            ...values,
                            [option.id]: Boolean(data.checked),
                          }))
                        }
                        label={option.label}
                      />
                    ) : option.options.length === 0 ? null : (
                      <Field key={option.id} label={option.label} hint={option.description}>
                        <Select
                          value={String(optionValues[option.id] ?? defaultModelOptionValue(option))}
                          onChange={(_, data) => {
                            if (option.options.some((item) => item.id === data.value)) {
                              setOptionValues((values) => ({ ...values, [option.id]: data.value }));
                            }
                          }}
                        >
                          {option.options.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ),
                  )}
                  {supportedModes.length > 0 ? (
                    <Field label="Runtime mode" required>
                      <Select
                        value={selectedRuntimeMode ?? ""}
                        onChange={(_, data) => {
                          const next = supportedModes.find((mode) => mode === data.value);
                          if (next) setRuntimeMode(next);
                        }}
                      >
                        {supportedModes.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <MessageBar intent="warning">
                      The source did not advertise a supported runtime mode. Launch is disabled.
                    </MessageBar>
                  )}
                  {interactionModes.length > 1 ? (
                    <Field label="Interaction mode">
                      <Select
                        value={selectedInteractionMode}
                        onChange={(_, data) => {
                          const next = interactionModes.find((mode) => mode === data.value);
                          if (next) setInteractionMode(next);
                        }}
                      >
                        {interactionModes.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                </>
              ) : null}
              <Field label="Session title" required>
                <Input
                  value={title}
                  onChange={(_, data) => setTitle(data.value)}
                  maxLength={120}
                  required
                />
              </Field>
              <Field
                label="Prompt"
                required
                hint="The source starts the selected provider with this prompt."
              >
                <Textarea
                  value={prompt}
                  onChange={(_, data) => setPrompt(data.value)}
                  rows={5}
                  required
                />
              </Field>
            </div>
          </DialogBody>
          <DialogActions className={styles.dialogActions}>
            <Button type="button" appearance="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button type="submit" appearance="primary" disabled={!canLaunch}>
              {pendingLaunch?.phase === "uncertain"
                ? "Waiting to reconcile"
                : pendingLaunch?.phase === "accepted"
                  ? "Waiting for source overview"
                  : submitting
                    ? "Waiting for source"
                    : "Start session"}
            </Button>
          </DialogActions>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
