// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Node child pipe is the browserless UI test boundary, not a production transport.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  ThreadId,
  WsRpcGroup,
  AuthStandardClientScopes,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Config from "../../config.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import { encodeThreadHistoryCursor } from "../../orchestration-v2/threadHistoryPaging.ts";
import * as FactoryRuntime from "../runtimeLayer.ts";
import * as CredentialStore from "../CredentialStore.ts";
import {
  startProductionServer,
  productionEventSink,
  productionCommandReceipts,
} from "./ProductionServer.ts";

import { controlledRollbackBarriers } from "./ControlledProvider.ts";

const Message = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
const decodeMessage = Schema.decodeUnknownSync(Message);
class GateFailure extends Schema.TaggedError<GateFailure>()("GateFailure", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const phase2Gate = Effect.gen(function* () {
  const uiCheckout = process.env.T3_FACTORY_UI_CHECKOUT;
  if (!uiCheckout)
    return yield* new GateFailure({
      detail: "Set T3_FACTORY_UI_CHECKOUT to run the cross-repository production gate.",
    });
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-phase2-workspace-" });
  yield* fs.makeDirectory(`${workspace}/nested`);
  yield* fs.writeFileString(`${workspace}/nested/safe.txt`, "native project-relative content");
  yield* fs.writeFileString(`${workspace}/tracked.txt`, "before\n");
  yield* Effect.sync(() => {
    NodeChildProcess.execFileSync("git", ["init", "--quiet", workspace]);
    NodeChildProcess.execFileSync("git", ["-C", workspace, "add", "."]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Phase2",
      "-c",
      "user.email=phase2@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
  });
  const makeServer = (name: string, factoryEnabled = false) =>
    Effect.gen(function* () {
      const configServices = yield* Layer.build(
        Config.layerTest(workspace, { prefix: `t3-phase2-${name}-` }),
      );
      const config = {
        ...Context.get(configServices, Config.ServerConfig),
        factoryEnabled,
        factoryCredentialStore: "protected-file" as const,
      };
      return yield* startProductionServer(config);
    });
  const sourceA = yield* makeServer("source-a");
  const sourceB = yield* makeServer("source-b");
  expect(sourceA.config.baseDir).not.toBe(sourceB.config.baseDir);
  for (const source of [sourceA, sourceB]) {
    expect(Context.get(source.services, FactoryRuntime.FactoryRuntime).enabled).toBe(false);
  }
  const factory = yield* makeServer("factory", true);
  const runtime = Context.get(factory.services, FactoryRuntime.FactoryRuntime);
  const sourceAuthA = Context.get(sourceA.services, EnvironmentAuth.EnvironmentAuth);
  const sourceAuthB = Context.get(sourceB.services, EnvironmentAuth.EnvironmentAuth);
  const auth = Context.get(factory.services, EnvironmentAuth.EnvironmentAuth);
  const cookieName = Context.get(factory.services, SessionStore.SessionStore).cookieName;
  const cookie = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    Effect.gen(function* () {
      const pairing = yield* auth.issuePairingCredential({ scopes });
      const session = yield* auth.createBrowserSession(pairing.credential, {
        label: "Phase2 gate",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "unknown",
        os: "test",
        browser: "test",
      });
      return `${cookieName}=${session.sessionToken}`;
    });
  const controlCookie = yield* cookie([
    ...AuthStandardClientScopes,
    "factory:read",
    "factory:control",
    "factory:admin",
  ]);
  const readCookie = yield* cookie(["orchestration:read", "factory:read"]);
  const worker = Context.get(sourceA.services, EffectWorker.OrchestrationEffectWorkerV2);
  const orchestrator = Context.get(sourceA.services, Orchestrator.OrchestratorV2);
  const sink = yield* productionEventSink(sourceA.services);
  const sourceEvents = yield* Stream.toQueue(orchestrator.streamStoredEvents, {
    capacity: "unbounded",
  });
  const threadId = ThreadId.make("same-thread");
  const awaitProjection = (
    predicate: (
      projection: Effect.Success<ReturnType<typeof orchestrator.getThreadProjection>>,
    ) => boolean,
  ) =>
    Effect.gen(function* () {
      let projection = yield* orchestrator.getThreadProjection(threadId);
      while (!predicate(projection)) {
        yield* Queue.take(sourceEvents);
        projection = yield* orchestrator.getThreadProjection(threadId);
      }
      return projection;
    });
  const sourceClient = (source: typeof sourceA) =>
    Effect.gen(function* () {
      const sourceAuth = Context.get(source.services, EnvironmentAuth.EnvironmentAuth);
      const issued = yield* sourceAuth.issueSession({ scopes: AuthStandardClientScopes });
      const ticket = yield* sourceAuth.issueWebSocketTicket(issued);
      const socket = yield* Socket.makeWebSocket(
        `${source.origin.replace("http:", "ws:")}/ws?orchestrationProtocol=2&wsTicket=${ticket.ticket}`,
      );
      const protocol = yield* RpcClient.makeProtocolSocket({ retryTransientErrors: false }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerJson),
      );
      return yield* RpcClient.make(WsRpcGroup).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
    });
  const clientA = yield* sourceClient(sourceA);
  const clientB = yield* sourceClient(sourceB);
  for (const [source, client, title, provider] of [
    [sourceA, clientA, "Source A", "codex"],
    [sourceB, clientB, "Source B", "cursor"],
  ] as const) {
    yield* client["projects.mutate"]({
      type: "project.create",
      commandId: CommandId.make("same-project-create"),
      projectId: ProjectId.make("same-project"),
      title: "Shared local ID",
      workspaceRoot: workspace,
    });
    yield* client["orchestration.dispatchCommand"]({
      type: "thread.create",
      commandId: CommandId.make("same-thread-create"),
      threadId,
      projectId: ProjectId.make("same-project"),
      title,
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId: ProviderInstanceId.make(provider), model: "controlled-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    // Start through the native intake and worker, not by fabricating provider/session grants.
    yield* client["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      commandId: CommandId.make("seed-message"),
      threadId,
      messageId: MessageId.make("seed-message"),
      text: "complete seed",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    });
    yield* Context.get(source.services, EffectWorker.OrchestrationEffectWorkerV2).drain();
  }
  yield* awaitProjection((projection) =>
    projection.runs.some((run) => run.status === "completed" && run.checkpointId !== null),
  );
  const enrollment = yield* runtime.getEnrollment;
  const pairingA = yield* sourceAuthA.issuePairingCredential({ scopes: AuthStandardClientScopes });
  const pairingB = yield* sourceAuthB.issuePairingCredential({ scopes: AuthStandardClientScopes });
  const envA = yield* enrollment.enroll({
    endpoint: sourceA.origin,
    label: "A",
    sourceCredential: pairingA.credential,
  });
  const envB = yield* enrollment.enroll({
    endpoint: sourceB.origin,
    label: "B",
    sourceCredential: pairingB.credential,
  });
  const overview = yield* runtime.getOverview;
  const online = yield* overview.subscribe.pipe(
    Stream.filter((event) =>
      event.type === "snapshot"
        ? event.snapshot.threads.length === 2
        : event.patch.kind === "threads",
    ),
    Stream.runHead,
  );
  expect(online._tag).toBe("Some");
  const connections = yield* runtime.getConnections;
  const sourceShell = yield* runtime.getSourceShell;
  const states = yield* Stream.toQueue(sourceShell.subscribe, { capacity: "unbounded" });
  // Subscribe before inspecting, then consume source synchronization milestones without polling.
  while (
    !(yield* sourceShell.isSynchronized(
      yield* connections.resolveTarget({
        registrationId: envA.registrationId,
        environmentId: envA.environmentId,
      }),
    )) ||
    !(yield* sourceShell.isSynchronized(
      yield* connections.resolveTarget({
        registrationId: envB.registrationId,
        environmentId: envB.environmentId,
      }),
    ))
  )
    yield* Queue.take(states);
  const rows = (yield* overview.getSnapshot).threads.map((row) => ({
    environmentId: row.key.environmentId,
    threadId: row.key.threadId,
  }));
  expect(new Set(rows.map((row) => JSON.stringify([row.environmentId, row.threadId]))).size).toBe(
    rows.length,
  );
  expect(rows.length).toBe(2);
  yield* fs.writeFileString(`${workspace}/tracked.txt`, "changed by native gate\n");
  yield* fs.writeFileString(`${workspace}/relay.mp4`, "0123456789");
  const grant = yield* issueAssetUrl({
    resource: { _tag: "media-file", threadId, path: `${workspace}/relay.mp4` },
  }).pipe(Effect.provide(sourceA.services), Effect.provide(Config.layer(sourceA.config)));
  const terminals = Context.get(sourceA.services, TerminalManager.TerminalManager);
  yield* terminals.open({
    threadId,
    terminalId: "default",
    cwd: workspace,
    env: {
      HOME: sourceA.config.baseDir,
      ZDOTDIR: sourceA.config.baseDir,
      HISTFILE: `${sourceA.config.baseDir}/test-history`,
    },
  });
  const rollbackStarted = yield* Deferred.make<void>();
  const rollbackRelease = yield* Deferred.make<void>();
  controlledRollbackBarriers.set(
    threadId,
    Deferred.succeed(rollbackStarted, undefined).pipe(
      Effect.andThen(Deferred.await(rollbackRelease)),
    ),
  );
  let rollbackCheckpoint: { readonly id: string; readonly ref: string | null } | undefined;
  let rollbackDrain: Fiber.Fiber<number, EffectWorker.OrchestrationEffectWorkerError> | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => controlledRollbackBarriers.delete(threadId)));
  let drains = 0;
  let audit: unknown;
  const metadata = yield* runtime.getMetadata;
  const store = yield* CredentialStore.CredentialStore.pipe(
    Effect.provide(
      CredentialStore.layer.pipe(
        Layer.provide(CredentialStore.keyringLayer),
        Layer.provide(Config.layer(factory.config)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  const sourceTokens: string[] = [];
  for (const environment of [envA, envB]) {
    const reference = yield* metadata.getCredentialReference(environment.registrationId);
    if (!reference) return yield* Effect.die("No enrolled credential reference");
    const stored = yield* store.get(reference.itemKey);
    if (stored._tag === "None") return yield* Effect.die("No enrolled credential");
    sourceTokens.push(stored.value.token);
  }
  const handle = (message: typeof Message.Type) =>
    Effect.gen(function* () {
      switch (message.name) {
        case "drain": {
          if (rollbackDrain) {
            yield* Deferred.succeed(rollbackRelease, undefined);
            yield* Fiber.join(rollbackDrain);
            rollbackDrain = undefined;
          } else yield* worker.drain();
          drains++;
          if (drains === 1)
            yield* awaitProjection((p) =>
              p.runs.some(
                (run) => run.status === "running" && run.userMessageId === "original-message",
              ),
            );
          if (drains === 2)
            yield* awaitProjection((p) =>
              p.runs.some(
                (run) => run.status === "interrupted" && run.userMessageId === "original-message",
              ),
            );
          if (drains === 3)
            yield* awaitProjection((p) =>
              p.runs.some(
                (run) =>
                  run.userMessageId === "held-message" &&
                  run.status === "completed" &&
                  run.checkpointId !== null,
              ),
            );
          if (drains === 5) {
            const completed = yield* awaitProjection(
              (p) => p.thread.rollbackCompletedRequestId === "native-rollback",
            );
            expect(completed.thread.rollbackCompletedRequestId).toBe("native-rollback");
            expect(rollbackCheckpoint?.ref?.startsWith("refs/")).toBe(true);
            expect(
              completed.checkpoints.find((checkpoint) => checkpoint.id === rollbackCheckpoint?.id)
                ?.ref,
            ).toBe(rollbackCheckpoint?.ref);
            expect(completed.runs.some((run) => run.status === "rolled_back")).toBe(true);
            yield* Effect.log(
              "PHASE2_ROLLBACK_SUCCESS",
              JSON.stringify({
                accepted: completed.thread.rollbackRequestId,
                completed: completed.thread.rollbackCompletedRequestId,
              }),
            );
          }
          return null;
        }
        case "rollback-start": {
          rollbackDrain = yield* worker.drain().pipe(Effect.forkScoped);
          yield* Deferred.await(rollbackStarted);
          const pending = yield* orchestrator.getThreadProjection(threadId);
          rollbackCheckpoint = pending.checkpoints.find(
            (checkpoint) => checkpoint.status === "ready",
          );
          expect(pending.thread.rollbackRequestId).toBe("native-rollback");
          expect(pending.thread.rollbackCompletedRequestId).toBeUndefined();
          return null;
        }
        case "rollback-unrelated-update": {
          const pending = yield* orchestrator.getThreadProjection(threadId);
          const providerThread = pending.providerThreads.find(
            (thread) => thread.id === pending.thread.activeProviderThreadId,
          )!;
          const checkpoint = pending.checkpoints.find(
            (checkpoint) => checkpoint.status === "ready",
          )!;
          const now = DateTime.add(providerThread.updatedAt, { milliseconds: 1 });
          yield* sink.write({
            events: [
              {
                id: EventId.make("unrelated-provider-update"),
                type: "provider-thread.updated",
                threadId,
                providerInstanceId: providerThread.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...providerThread,
                  lastRunOrdinal: checkpoint.appRunOrdinal || null,
                  updatedAt: now,
                },
              },
            ],
          });
          const unrelated = yield* orchestrator.getThreadProjection(threadId);
          expect(unrelated.thread.rollbackCompletedRequestId).toBeUndefined();
          const updatedProvider = unrelated.providerThreads.find(
            (thread) => thread.id === providerThread.id,
          )!;
          expect(updatedProvider.lastRunOrdinal).toBe(checkpoint.appRunOrdinal || null);
          expect(DateTime.toEpochMillis(updatedProvider.updatedAt)).toBeGreaterThan(
            DateTime.toEpochMillis(providerThread.updatedAt),
          );
          yield* Effect.log(
            "PHASE2_ROLLBACK_PENDING",
            JSON.stringify({
              accepted: unrelated.thread.rollbackRequestId,
              completed: null,
              sameOrdinal: unrelated.providerThreads.find(
                (thread) => thread.id === providerThread.id,
              )?.lastRunOrdinal,
              providerUpdatedAtNewer: true,
              effectBlockedInProvider: true,
            }),
          );
          return null;
        }
        case "seed-question": {
          const now = yield* DateTime.now;
          const nodeId = NodeId.make("native-question-node");
          const requestId = RuntimeRequestId.make("native-question");
          yield* sink.write({
            events: [
              {
                id: EventId.make("gate-question-node"),
                type: "node.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: nodeId,
                  threadId,
                  runId: null,
                  parentNodeId: null,
                  rootNodeId: nodeId,
                  kind: "user_input_request",
                  status: "waiting",
                  countsForRun: false,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  runtimeRequestId: requestId,
                  checkpointScopeId: null,
                  startedAt: now,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("gate-question"),
                type: "runtime-request.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: requestId,
                  nodeId,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "message" },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
              {
                id: EventId.make("gate-question-item"),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("native-options-item"),
                  type: "user_input_request",
                  threadId,
                  runId: null,
                  nodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  status: "waiting",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  requestId,
                  responseMode: "message",
                  questions: [
                    {
                      id: "color",
                      header: "Color",
                      question: "Which color?",
                      required: true,
                      options: [
                        { label: "Blue", description: "Use blue", value: "blue" },
                        { label: "Green", description: "Use green", value: "green" },
                      ],
                    },
                    { id: "note", header: "Note", question: "Note?", required: true, options: [] },
                  ],
                },
              },
            ],
          });
          return null;
        }
        case "history": {
          const p = yield* orchestrator.getThreadSnapshot(threadId);
          return encodeThreadHistoryCursor({
            snapshotSequence: p.snapshotSequence,
            sourceThreadId: threadId,
            sourceItemId: "native-options-item",
            position: 1,
          });
        }
        case "restrict-source": {
          const issued = yield* sourceAuthA.issueSession({
            scopes: ["orchestration:read", "relay:read"],
          });
          const reference = yield* metadata.getCredentialReference(envA.registrationId);
          if (!reference) return yield* Effect.die("No actual credential reference");
          sourceTokens.push(issued.token);
          yield* store.set(reference.itemKey, {
            token: issued.token,
            sourceSessionId: issued.sessionId,
            scopes: issued.scopes,
            issuedAt: yield* DateTime.now,
            expiresAt: issued.expiresAt,
          });
          yield* connections.retry(envA.registrationId);
          yield* connections.subscribeStates.pipe(
            Stream.filter((states) =>
              states.some(
                (state) =>
                  state.target.registrationId === envA.registrationId && state.phase === "online",
              ),
            ),
            Stream.runHead,
          );
          while (
            !(yield* sourceShell.isSynchronized(
              yield* connections.resolveTarget({
                registrationId: envA.registrationId,
                environmentId: envA.environmentId,
              }),
            ))
          )
            yield* Queue.take(states);
          return null;
        }
        case "disable-source":
          yield* connections.disable(envA.registrationId);
          return null;
        case "audit":
          audit = message.data;
          return null;
        default:
          return yield* Effect.die(`Unexpected UI milestone ${message.name}`);
      }
    });
  const gateScope = yield* Scope.Scope;
  let output = "";
  const run = Effect.callback<void, GateFailure>((resume) => {
    const cancellation = new AbortController();
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--import", "tsx", "src/factory/testkit/runProductionGate.ts"],
      {
        cwd: uiCheckout,
        env: {
          ...process.env,
          T3_FACTORY_GATE_INPUT: JSON.stringify({
            origin: factory.origin,
            cookie: controlCookie,
            readCookie,
            environmentIds: [envA.environmentId, envB.environmentId],
            workspace,
            assetPath: grant.relativeUrl,
          }),
          VITE_FACTORY_FIXTURE: "0",
        },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
      process.stderr.write(chunk);
    });
    const milestones = child.stdio[3];
    if (!(milestones instanceof NodeStream.Readable)) {
      resume(Effect.fail(new GateFailure({ detail: "No UI milestone pipe" })));
      child.kill();
      return;
    }
    const lines = NodeReadline.createInterface({ input: milestones });
    lines.on("line", (line) => {
      let message: typeof Message.Type;
      try {
        message = decodeMessage(JSON.parse(line));
      } catch (error) {
        resume(Effect.fail(new GateFailure({ detail: "Invalid UI milestone", cause: error })));
        child.kill();
        return;
      }
      void Effect.runPromise(
        handle(message).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Scope.Scope, gateScope),
        ),
        { signal: cancellation.signal },
      ).then(
        (value) => child.stdin.write(JSON.stringify({ id: message.id, value }) + "\n"),
        (error) => {
          resume(
            Effect.fail(new GateFailure({ detail: "Production milestone failed", cause: error })),
          );
          child.kill();
        },
      );
    });
    child.on("error", (error) =>
      resume(Effect.fail(new GateFailure({ detail: "UI child failed", cause: error }))),
    );
    child.on("close", (code) => {
      lines.close();
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(
              new GateFailure({ detail: `UI production gate failed (${code}): ${output}` }),
            ),
      );
    });
    return Effect.sync(() => {
      cancellation.abort();
      lines.close();
      if (child.exitCode === null) child.kill();
    });
  });
  yield* run;
  expect(audit).toBeDefined();
  const receipts = yield* productionCommandReceipts(sourceA.services);
  const original = yield* receipts.getByCommandId(CommandId.make("dropped-prompt"));
  expect(original._tag).toBe("Some");
  expect(yield* receipts.getByCommandId(CommandId.make("new-id-forbidden"))).toMatchObject({
    _tag: "None",
  });
  expect(yield* receipts.getByCommandId(CommandId.make("readonly-denied"))).toMatchObject({
    _tag: "None",
  });
  const sql = Context.get(sourceA.services, SqlClient.SqlClient);
  // Durable event count catches duplicates independently of the UI transport audit.
  const committed =
    yield* sql`SELECT COUNT(*) AS count FROM orchestration_events WHERE command_id = ${"dropped-prompt"}`;
  expect(committed[0]?.count).toBeGreaterThan(0);
  expect(
    yield* sql`SELECT COUNT(*) AS count FROM orchestration_events WHERE command_id = ${"dropped-prompt"} AND event_type = ${"message.updated"}`,
  ).toEqual([{ count: 1 }]);
  expect(yield* receipts.getByCommandId(CommandId.make("disabled-denied"))).toMatchObject({
    _tag: "None",
  });
  expect(
    yield* sql`SELECT COUNT(*) AS count FROM orchestration_events WHERE command_id = ${"native-launch"} AND event_type = ${"thread.created"}`,
  ).toEqual([{ count: 1 }]);
  const p = yield* orchestrator.getThreadProjection(threadId);
  expect(p.messages.filter((message) => message.id === "original-message")).toHaveLength(1);
  const factorySql = Context.get(factory.services, SqlClient.SqlClient);
  const metadataRows = yield* factorySql`SELECT environment_id FROM factory_environments`;
  expect(metadataRows).toHaveLength(2);
  expect(yield* factorySql`SELECT COUNT(*) AS count FROM orchestration_events`).toEqual([
    { count: 0 },
  ]);
  const factoryTables =
    yield* factorySql`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'factory_%' ORDER BY name`;
  expect(factoryTables.map((row) => row.name)).toEqual([
    "factory_environments",
    "factory_favorites",
    "factory_project_groups",
    "factory_project_memberships",
  ]);
  for (const file of [factory.config.dbPath, `${factory.config.dbPath}-wal`]) {
    if (!(yield* fs.exists(file))) continue;
    const bytes = Buffer.from(yield* fs.readFile(file)).toString("utf8");
    for (const token of [...sourceTokens, pairingA.credential, pairingB.credential])
      expect(bytes.includes(token)).toBe(false);
    expect(bytes).not.toContain("native project-relative content");
  }
  for (const token of sourceTokens) {
    expect(output.includes(token)).toBe(false);
    expect(JSON.stringify(audit).includes(token)).toBe(false);
    expect(JSON.stringify(yield* overview.getSnapshot).includes(token)).toBe(false);
  }
  yield* Effect.logInfo(
    "PHASE2_PRODUCTION_GATE",
    JSON.stringify({ milestones: drains, sources: 2, factoryMetadataOnly: true, audit }),
  );
}).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeSocket.layerWebSocketConstructorWS)));
