import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ApplicationEvents from "../persistence/Services/OrchestrationEventStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Socket from "effect/unstable/socket/Socket";
import * as SessionStore from "../auth/SessionStore.ts";
import * as FactoryRuntime from "./runtimeLayer.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import { factoryWebSocketRouteLayer } from "./http.ts";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CheckpointId,
  MessageId,
  ProviderInstanceId,
  RunId,
  DEFAULT_TERMINAL_ID,
  TerminalSessionSnapshot,
  TerminalAttachStreamEvent,
  CommandId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
  OrchestrationV2ThreadStreamItem,
  FactoryEnvironmentView,
  FactoryRegistrationId,
  ThreadId,
} from "@t3tools/contracts";
import * as Server from "../server.ts";
import * as Config from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Connections from "./Connections.ts";
import * as SourceShell from "./SourceShell.ts";
import * as RelayPolicy from "./RelayPolicy.ts";
import * as Relay from "./Relay.ts";
import * as NodeSource from "./NodeSource.ts";
import { memorySocket } from "./testkit/RelaySocket.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeTerminalSnapshot = Schema.decodeUnknownEffect(
  Schema.toCodecJson(TerminalSessionSnapshot),
);
const decodeThreadStream = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
);
const decodeTerminalStream = Schema.decodeUnknownEffect(
  Schema.toCodecJson(TerminalAttachStreamEvent),
);
const Reply = Schema.Struct({
  _tag: Schema.String,
  requestId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  values: Schema.optional(Schema.Array(Schema.Unknown)),
  exit: Schema.optional(
    Schema.Struct({
      _tag: Schema.String,
      value: Schema.optional(Schema.Unknown),
      cause: Schema.optional(
        Schema.Array(
          Schema.Struct({
            _tag: Schema.String,
            error: Schema.optional(Schema.Struct({ _tag: Schema.String })),
          }),
        ),
      ),
    }),
  ),
});
const decode = Schema.decodeEffect(Schema.fromJsonString(Reply));

it.live(
  "passes real source scope and native workspace failures through the relay",
  (context) =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") context.skip();
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-native-workspace-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-native-outside-" });
      yield* fs.writeFileString(`${workspace}/safe.txt`, "native source content");
      yield* fs.writeFileString(`${outside}/outside.txt`, "existing out-of-workspace content");
      const path = yield* Path.Path;
      const traversal = path.relative(workspace, `${outside}/outside.txt`);
      expect(traversal).toMatch(/^\.\.\//);
      const configServices = yield* Layer.build(
        Config.layerTest(workspace, { prefix: "t3-relay-native-home-" }),
      );
      const base = Context.get(configServices, Config.ServerConfig);
      const ready = yield* Deferred.make<Context.Context<Layer.Success<typeof Server.layer>>>();
      const sourceFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(
            Server.layer.pipe(
              Layer.provide(
                Config.layer({
                  ...base,
                  host: "127.0.0.1",
                  noBrowser: true,
                  startupPresentation: "browser",
                }),
              ),
            ),
          );
          yield* Deferred.succeed(ready, services);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkScoped);
      const services = yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(sourceFiber));
      const address = Context.get(services, HttpServer.HttpServer).address;
      if (typeof address === "string" || !("port" in address))
        return yield* Effect.die("No source address.");
      const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
      const issued = yield* auth.issueSession({ scopes: ["orchestration:read"] });
      const transportServices = yield* Layer.build(NodeSource.nodeLayer);
      const transport = Context.get(transportServices, Connections.SourceTransport);
      const now = yield* DateTime.now;
      const environmentId = yield* Context.get(
        services,
        ServerEnvironment.ServerEnvironmentIdentity,
      ).getEnvironmentId;
      const target = { registrationId: FactoryRegistrationId.make("native"), environmentId };
      const environment = FactoryEnvironmentView.make({
        ...target,
        endpoint: `http://127.0.0.1:${address.port}`,
        label: "Native",
        platform: null,
        enabled: true,
        state: "online",
        credentialStorage: "secure-vault",
        credentialExpiresAt: issued.expiresAt,
        cleanupPending: false,
        renewal: "unsupported",
        lastSeenAt: null,
        revision: 1,
      });
      let credential = {
        token: issued.token,
        sourceSessionId: issued.sessionId,
        scopes: issued.scopes,
        issuedAt: now,
        expiresAt: issued.expiresAt,
      };
      const sourceSession = yield* transport.connect({ environment, credential });
      const firstConfig = yield* sourceSession.configs.pipe(
        Stream.filter((event) => event.type === "snapshot"),
        Stream.runHead,
      );
      if (firstConfig._tag === "None" || firstConfig.value.type !== "snapshot")
        return yield* Effect.die("No native configuration.");
      const access: Connections.SourceAccess = {
        connectionId: sourceSession,
        target,
        config: firstConfig.value.config,
        // Deliberately overstate the transport fixture grants to prove native source
        // authorization is still enforced, independently of the Factory policy.
        sourceScopes: ["orchestration:read", "orchestration:operate", "terminal:operate"],
        checkCurrent: Effect.void,
        closed: Effect.never,
        shell: Stream.never,
        acknowledgeShell: () => Effect.void,
      };
      const connectRelay = transport.connectRelay;
      if (connectRelay === undefined) return yield* Effect.die("No dedicated relay transport.");
      const dependencies = Layer.mergeAll(
        Config.layer({ ...base, factoryEnabled: true }),
        Layer.mock(Connections.Connections)({
          resolveTarget: () => Effect.succeed(access),
          openRelay: () => connectRelay({ environment, credential }),
        }),
        Layer.mock(SourceShell.SourceShell)({ isSynchronized: () => Effect.succeed(true) }),
      );
      const relayServices = yield* Layer.build(
        Relay.layer.pipe(
          Layer.provideMerge(RelayPolicy.layer.pipe(Layer.provideMerge(dependencies))),
        ),
      );
      const browser = yield* memorySocket;
      const consumer = yield* Context.get(relayServices, Relay.Relay)
        .serve({ socket: browser.socket, target, callerScopes: ["factory:read"] })
        .pipe(Effect.forkScoped);
      const send = (id: number, tag: string, payload: unknown) =>
        Queue.offer(browser.incoming, encode({ _tag: "Request", id, tag, payload, headers: [] }));
      const response = () =>
        Effect.raceFirst(
          Queue.take(browser.outgoing).pipe(Effect.flatMap(decode)),
          Fiber.join(consumer).pipe(Effect.andThen(Effect.die("Relay ended before reply."))),
        );
      yield* send(1, "projects.readFile", { cwd: workspace, relativePath: "safe.txt" });
      expect((yield* response()).exit).toMatchObject({
        _tag: "Success",
        value: { contents: "native source content" },
      });
      yield* send(2, "projects.readFile", { cwd: workspace, relativePath: traversal });
      expect((yield* response()).exit).toMatchObject({
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { _tag: "ProjectReadFileError" } }],
      });
      yield* send(3, "terminal.attach", {
        threadId: "native-thread",
        terminalId: "native-terminal",
      });
      expect((yield* response()).exit).toMatchObject({
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { _tag: "EnvironmentAuthorizationError" } }],
      });
      yield* browser.close;
      yield* Fiber.await(consumer);
      const controller = yield* auth.issueSession({
        scopes: ["orchestration:read", "orchestration:operate", "terminal:operate"],
      });
      credential = {
        token: controller.token,
        sourceSessionId: controller.sessionId,
        scopes: controller.scopes,
        issuedAt: now,
        expiresAt: controller.expiresAt,
      };
      const pairing = yield* auth.issuePairingCredential({
        scopes: ["factory:read", "factory:control"],
      });
      const cookie = yield* auth.createBrowserSession(pairing.credential, {
        label: "Factory test",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "unknown",
        os: "test",
        browser: "test",
      });
      const sessions = Context.get(services, SessionStore.SessionStore);
      const runtime = Layer.mock(FactoryRuntime.FactoryRuntime)({
        enabled: true,
        getRelayPolicy: Effect.succeed(Context.get(relayServices, RelayPolicy.RelayPolicy)),
        getRelay: Effect.succeed(Context.get(relayServices, Relay.Relay)),
      });
      const factoryServices = yield* Layer.build(
        HttpRouter.serve(
          factoryWebSocketRouteLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                runtime,
                Config.layer({ ...base, factoryEnabled: true }),
                Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth),
              ),
            ),
          ),
          { disableLogger: true, disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const factoryAddress = Context.get(factoryServices, HttpServer.HttpServer).address;
      if (typeof factoryAddress === "string" || !("port" in factoryAddress))
        return yield* Effect.die("No Factory address.");
      const relayUrl = `ws://127.0.0.1:${factoryAddress.port}/factory/env/native/ws?orchestrationProtocol=2&environmentId=${encodeURIComponent(environmentId)}`;
      const connectBrowser = Effect.gen(function* () {
        const socket = yield* Socket.makeWebSocket(relayUrl).pipe(
          Effect.provideService(
            Socket.WebSocketConstructor,
            (url) =>
              new NodeSocket.NodeWS.WebSocket(url, {
                headers: { cookie: `${sessions.cookieName}=${cookie.sessionToken}` },
              }),
          ),
        );
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const replies = yield* Queue.unbounded<string>();
        const pump = yield* Effect.gen(function* () {
          while (true)
            for (const raw of yield* reader.pull)
              yield* Queue.offer(
                replies,
                typeof raw === "string" ? raw : new TextDecoder().decode(raw),
              );
        }).pipe(Effect.forkScoped);
        const receive = () =>
          Effect.raceFirst(
            Queue.take(replies).pipe(Effect.flatMap(decode)),
            Fiber.join(pump).pipe(Effect.andThen(Effect.die("Browser ended before reply."))),
          );
        return {
          writer,
          receive,
          send: (id: number, tag: string, payload: unknown) =>
            writer.write(encode({ _tag: "Request", id, tag, payload, headers: [] })),
        };
      });
      const routed = yield* connectBrowser;
      yield* routed.send(1, "projects.mutate", {
        type: "project.create",
        commandId: "native-project-create",
        projectId: "native-project",
        title: "Native relay",
        workspaceRoot: workspace,
      });
      expect((yield* routed.receive()).exit?._tag).toBe("Success");
      const command = {
        type: "thread.create",
        commandId: "unchanged-command-id",
        threadId: "native-thread",
        projectId: "native-project",
        title: "Native relay thread",
        createdBy: "user",
        creationSource: "web",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      };
      const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
      const committed = yield* Deferred.make<void>();
      yield* orchestrator.streamStoredEvents.pipe(
        Stream.filter((stored) => stored.commandId === command.commandId),
        Stream.take(1),
        Stream.runForEach(() => Deferred.succeed(committed, undefined)),
        Effect.forkScoped,
      );
      yield* routed.send(2, "orchestration.dispatchCommand", command);
      yield* Deferred.await(committed);
      // Drop the consumer before reading its reply. Recovery belongs to the UI owner.
      yield* routed.writer.write(new Socket.CloseEvent());
      const receiptServices = yield* Layer.build(
        CommandReceipts.layer.pipe(
          Layer.provide(
            Layer.succeed(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient)),
          ),
        ),
      );
      const receipts = Context.get(receiptServices, CommandReceipts.CommandReceiptStoreV2);
      const accepted = yield* receipts.getByCommandId(CommandId.make(command.commandId));
      expect(accepted._tag).toBe("Some");
      if (accepted._tag === "None") return yield* Effect.die("No native receipt.");
      expect(accepted.value.status).toBe("accepted");
      const recovered = yield* connectBrowser;
      yield* recovered.send(2, "orchestration.dispatchCommand", command);
      expect((yield* recovered.receive()).exit).toMatchObject({
        _tag: "Success",
        value: { sequence: accepted.value.resultSequence },
      });
      const after = yield* receipts.getByCommandId(CommandId.make(command.commandId));
      expect(after).toEqual(accepted);
      const replay = yield* orchestrator
        .streamStoredEventsFrom({
          threadId: ThreadId.make(command.threadId),
          afterSequence: accepted.value.resultSequence - 1,
        })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(replay[0]).toMatchObject({
        commandId: "unchanged-command-id",
        sequence: accepted.value.resultSequence,
        event: { type: "thread.created" },
      });
      const sqlLayer = Layer.succeed(
        SqlClient.SqlClient,
        Context.get(services, SqlClient.SqlClient),
      );
      const sinkServices = yield* Layer.build(
        EventSink.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              EventStore.layerFromOrchestrationEventStore.pipe(
                Layer.provide(
                  Layer.succeed(
                    ApplicationEvents.OrchestrationEventStore,
                    Context.get(services, ApplicationEvents.OrchestrationEventStore),
                  ),
                ),
              ),
              ProjectionStore.layer,
            ),
          ),
          Layer.provide(sqlLayer),
        ),
      );
      const sink = Context.get(sinkServices, EventSink.EventSinkV2);
      const threadId = ThreadId.make(command.threadId);
      const nodeId = NodeId.make("native-question-node");
      const requestId = RuntimeRequestId.make("native-question");
      const runId = RunId.make("native-run");
      const completedRun = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: ProviderThreadId.make("native-provider-thread"),
        userMessageId: MessageId.make("native-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("native-user-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: MessageId.make("native-message"),
              threadId,
              runId,
              nodeId: null,
              role: "user",
              text: "Fixture work",
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("native-completed-run"),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: completedRun,
          },
          {
            id: EventId.make("native-node"),
            type: "node.updated",
            threadId,
            nodeId,
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
            id: EventId.make("native-request"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
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
            id: EventId.make("native-options"),
            type: "turn-item.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("native-options-item"),
              type: "user_input_request",
              threadId,
              runId,
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
                  options: [
                    { label: "Blue", description: "Use blue", value: "blue" },
                    { label: "Green", description: "Use green", value: "green" },
                  ],
                },
              ],
            },
          },
          {
            id: EventId.make("native-unknown-usage"),
            type: "provider-turn.updated",
            threadId,
            nodeId,
            driver: ProviderDriverKind.make("codex"),
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make("native-provider-turn"),
              providerThreadId: ProviderThreadId.make("native-provider-thread"),
              nodeId,
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          },
        ],
      });
      yield* recovered.send(9, "orchestration.subscribeThread", {
        threadId,
        acceptBoundedSnapshot: true,
      });
      const snapshotFrame = yield* recovered.receive();
      expect(snapshotFrame._tag).toBe("Chunk");
      const snapshot = yield* decodeThreadStream(snapshotFrame.values?.[0]);
      expect(snapshot.kind).toBe("snapshot");
      if (snapshot.kind !== "snapshot") return yield* Effect.die("No source snapshot.");
      const question = snapshot.projection.turnItems.find(
        (item) => item.type === "user_input_request",
      );
      expect(
        question?.type === "user_input_request" ? question.questions[0]?.options : undefined,
      ).toEqual([
        { label: "Blue", description: "Use blue", value: "blue" },
        { label: "Green", description: "Use green", value: "green" },
      ]);
      expect(snapshot.projection.providerTurns[0]?.status).toBe("completed");
      expect(snapshot.projection.providerTurns[0]?.tokenUsage).toBeUndefined();
      expect(snapshot.projection.runs[0]).toMatchObject({
        status: "completed",
        checkpointId: null,
      });
      const finalize = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();
      yield* Deferred.await(finalize).pipe(
        Effect.andThen(
          sink.write({
            events: [
              {
                id: EventId.make("native-run-finalized"),
                type: "run.updated",
                threadId,
                runId,
                occurredAt: now,
                payload: { ...completedRun, checkpointId: CheckpointId.make("native-checkpoint") },
              },
            ],
          }),
        ),
        Effect.andThen(Deferred.succeed(finalized, undefined)),
        Effect.forkScoped,
      );
      expect(yield* Deferred.isDone(finalized)).toBe(false);
      yield* recovered.writer.write(encode({ _tag: "Ack", requestId: 9 }));
      yield* Deferred.succeed(finalize, undefined);
      yield* Deferred.await(finalized);
      while (true) {
        const frame = yield* recovered.receive();
        const item = yield* decodeThreadStream(frame.values?.[0]);
        if (frame._tag === "Chunk")
          yield* recovered.writer.write(encode({ _tag: "Ack", requestId: 9 }));
        if (item.kind === "event" && item.event.type === "run.updated") {
          expect(item.event.payload).toMatchObject({
            status: "completed",
            checkpointId: "native-checkpoint",
          });
          break;
        }
      }
      yield* recovered.writer.write(encode({ _tag: "Interrupt", requestId: 9 }));
      const cancelled = yield* recovered.receive();
      expect(cancelled).toMatchObject({
        _tag: "Exit",
        requestId: 9,
        exit: {
          _tag: "Failure",
          cause: expect.arrayContaining([expect.objectContaining({ _tag: "Interrupt" })]),
        },
      });
      yield* recovered.writer.write(new Socket.CloseEvent());
      const terminalThreadId = "native-terminal-thread";
      const history = Array.from({ length: 5001 }, (_, i) => `native-line-${i}\n`).join("");
      yield* fs.writeFileString(
        `${base.terminalLogsDir}/terminal_${Encoding.encodeBase64Url(terminalThreadId)}.log`,
        history,
      );
      const terminalBrowser = yield* connectBrowser;
      yield* terminalBrowser.send(10, "terminal.open", {
        threadId: terminalThreadId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: workspace,
        env: {
          HOME: base.baseDir,
          ZDOTDIR: base.baseDir,
          HISTFILE: `${base.baseDir}/test-history`,
        },
      });
      const opened = yield* terminalBrowser.receive();
      const terminal = yield* decodeTerminalSnapshot(opened.exit?.value);
      expect(terminal.history).not.toContain("native-line-0\n");
      expect(terminal.history).toContain("native-line-5000\n");
      expect(terminal.history.split("\n").length - 1).toBeLessThanOrEqual(5000);
      expect(terminal.status).toBe("running");
      const writeCompleted = yield* Deferred.make<void>();
      let tail = "";
      const manager = Context.get(services, TerminalManager.TerminalManager);
      yield* Effect.acquireRelease(
        manager.subscribe((event) =>
          Effect.gen(function* () {
            if (event.threadId === terminalThreadId && event.type === "output") {
              tail = (tail + event.data).slice(-4096);
              if (tail.includes("\r\nFACTORY-WRITE-DONE\r\n"))
                yield* Deferred.succeed(writeCompleted, undefined);
            }
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      yield* terminalBrowser.send(13, "terminal.write", {
        threadId: terminalThreadId,
        terminalId: DEFAULT_TERMINAL_ID,
        data: `printf 'once\\n' >> '${workspace}/terminal-once.txt'; printf '\\nFACTORY-WRITE-DONE\\n'\r`,
      });
      yield* Deferred.await(writeCompleted);
      // The terminal write reply is intentionally not consumed, and the relay must
      // never repeat this non-idempotent input while the consumer reconnects.
      yield* terminalBrowser.writer.write(new Socket.CloseEvent());
      expect(yield* fs.readFileString(`${workspace}/terminal-once.txt`)).toBe("once\n");
      const attachedBrowser = yield* connectBrowser;
      yield* attachedBrowser.send(11, "terminal.attach", {
        threadId: terminalThreadId,
        terminalId: DEFAULT_TERMINAL_ID,
      });
      const attachedFrame = yield* attachedBrowser.receive();
      const attached = yield* decodeTerminalStream(attachedFrame.values?.[0]);
      expect(attached.type).toBe("snapshot");
      if (attached.type !== "snapshot") return yield* Effect.die("No attached terminal snapshot.");
      expect(attached.snapshot.status).toBe("running");
      expect(attached.snapshot.history).toContain("native-line-5000");
      expect(attached.snapshot.history).not.toContain("native-line-0\n");
      yield* attachedBrowser.writer.write(encode({ _tag: "Ack", requestId: 11 }));
      yield* attachedBrowser.send(12, "terminal.close", {
        threadId: terminalThreadId,
        terminalId: DEFAULT_TERMINAL_ID,
      });
      // The source emits lifecycle chunks before the close reply. Drain by the
      // source request ID, not a sleep or an assumed transport order.
      while (true) {
        const reply = yield* attachedBrowser.receive();
        if (reply.requestId === 12) break;
        if (reply._tag === "Chunk")
          yield* attachedBrowser.writer.write(encode({ _tag: "Ack", requestId: reply.requestId }));
      }
      yield* attachedBrowser.writer.write(new Socket.CloseEvent());
      yield* Fiber.interrupt(sourceFiber);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          NodeSocket.layerWebSocketConstructorWS,
        ),
      ),
    ),
  { timeout: 60_000 },
);
