import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { OrchestrationV2ThreadDetailSnapshot } from "@t3tools/contracts";
import * as HttpRelay from "./HttpRelay.ts";
import { resolveSourceHttpUrl } from "@t3tools/contracts/factoryRelayUrl";
import * as Clock from "effect/Clock";
import { issueAssetUrl } from "../assets/AssetAccess.ts";
import { issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import { encodeThreadHistoryCursor } from "../orchestration-v2/threadHistoryPaging.ts";
import { expect, it, vi } from "@effect/vitest";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
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
import * as TerminalManager from "../terminal/Manager.ts";
import * as Stream from "effect/Stream";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Socket from "effect/unstable/socket/Socket";
import * as SessionStore from "../auth/SessionStore.ts";
import * as FactoryRuntime from "./runtimeLayer.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { factoryWebSocketRouteLayer, factorySourceHttpRouteLayer } from "./http.ts";
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
import {
  startProductionServer,
  productionEventSink,
  productionCommandReceipts,
} from "./testkit/ProductionServer.ts";
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
      const { services, fiber: sourceFiber, origin } = yield* startProductionServer(base);
      const address = new URL(origin);
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
        shell: () => Stream.never,
        checkShellCurrent: Effect.void,
        shellSynchronized: Effect.void,
      };
      const connectRelay = transport.connectRelay;
      if (connectRelay === undefined) return yield* Effect.die("No dedicated relay transport.");
      const dependencies = Layer.mergeAll(
        Config.layer({ ...base, factoryEnabled: true }),
        Layer.mock(Connections.Connections)({
          resolveTarget: () => Effect.succeed(access),
          openRelay: () => connectRelay({ environment, credential }),
          openHttp: () => transport.connectHttp!({ environment, credential }),
        }),
        Layer.mock(SourceShell.SourceShell)({ isSynchronized: () => Effect.succeed(true) }),
      );
      const relayServices = yield* Layer.build(
        Layer.mergeAll(Relay.layer, HttpRelay.layer).pipe(
          Layer.provideMerge(RelayPolicy.layer.pipe(Layer.provideMerge(dependencies))),
        ),
      );
      const browser = yield* memorySocket;
      const consumer = yield* Context.get(relayServices, Relay.Relay)
        .serve({
          socket: browser.socket,
          target,
          callerScopes: ["factory:read", "factory:control"],
        })
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
        getHttpRelay: Effect.succeed(Context.get(relayServices, HttpRelay.HttpRelay)),
      });
      const factoryServices = yield* Layer.build(
        HttpRouter.serve(
          Layer.mergeAll(factoryWebSocketRouteLayer, factorySourceHttpRouteLayer).pipe(
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
      const receipts = yield* productionCommandReceipts(services);
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
      const sink = yield* productionEventSink(services);
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
      const httpPrefix = `http://127.0.0.1:${factoryAddress.port}/factory/env/native/`;
      const httpServices = yield* Layer.build(FetchHttpClient.layer);
      const httpClient = Context.get(httpServices, HttpClient.HttpClient);
      const sourceHttp = (
        sourcePath: string,
        init?: {
          method?: "GET" | "POST" | "HEAD";
          body?: string;
          headers?: Record<string, string>;
        },
      ) => {
        let request = HttpClientRequest.make(init?.method ?? "GET")(
          resolveSourceHttpUrl(httpPrefix, sourcePath, { mode: "factory-relay", environmentId }),
        );
        if (init?.body !== undefined) request = HttpClientRequest.bodyText(request, init.body);
        request = HttpClientRequest.setHeaders(request, {
          cookie: `${sessions.cookieName}=${cookie.sessionToken}`,
          "x-t3-orchestration-protocol": "2",
          ...init?.headers,
        });
        return httpClient
          .execute(request)
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      };
      const projectsHttp = yield* sourceHttp("/api/projects");
      expect(projectsHttp.status).toBe(200);
      expect(yield* projectsHttp.json).toMatchObject({ projects: [{ id: "native-project" }] });
      for (const suffix of ["", "/bounded"]) {
        const detail = yield* sourceHttp(`/api/orchestration/threads/native-thread${suffix}`);
        expect(detail.status).toBe(200);
        const detailBody = yield* HttpClientResponse.schemaBodyJson(
          Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
        )(detail);
        expect(
          detailBody.projection.turnItems.flatMap((item) =>
            item.type === "user_input_request" ? (item.questions[0]?.options ?? []) : [],
          ),
        ).toEqual([
          { label: "Blue", description: "Use blue", value: "blue" },
          { label: "Green", description: "Use green", value: "green" },
        ]);
        expect(detailBody.projection.providerTurns[0]).not.toHaveProperty("tokenUsage");
        expect(detailBody.projection.runs[0]).toMatchObject({
          status: "completed",
          checkpointId: null,
        });
      }
      const cursor = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "native-options-item",
        position: 1,
      });
      const historyHttp = yield* sourceHttp(
        `/api/orchestration/threads/native-thread/history?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(historyHttp.status).toBe(200);
      expect(yield* historyHttp.json).toHaveProperty("hasMoreHistory");
      const missingThread = yield* sourceHttp("/api/orchestration/threads/missing/bounded");
      expect(missingThread.status).toBe(404);
      expect(yield* missingThread.json).toMatchObject({
        _tag: "EnvironmentResourceNotFoundError",
        reason: "thread_not_found",
      });
      yield* fs.writeFileString(`${workspace}/relay.mp4`, "0123456789");
      const mint = issueAssetUrl({
        resource: { _tag: "media-file", threadId, path: `${workspace}/relay.mp4` },
      });
      const assetGrant = yield* mint.pipe(
        Effect.provide(Context.add(services, Config.ServerConfig, base)),
      );
      const assetHttp = yield* sourceHttp(assetGrant.relativeUrl, {
        headers: { range: "bytes=2-5" },
      });
      expect(assetHttp.status).toBe(206);
      expect(assetHttp.headers["content-range"]).toBe("bytes 2-5/10");
      expect(yield* assetHttp.text).toBe("2345");
      const headHttp = yield* sourceHttp(assetGrant.relativeUrl, { method: "HEAD" });
      expect(headHttp.status).toBe(200);
      expect(headHttp.headers["content-length"]).toBe("10");
      expect(yield* headHttp.text).toBe("");
      for (const [fileName, contentType, body] of [
        ["relay.html", "text/html", "<script>1</script>"],
        ["relay.svg", "image/svg+xml", "<svg/>"],
      ] as const) {
        yield* fs.writeFileString(`${workspace}/${fileName}`, body);
        const grant = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId, path: `${workspace}/${fileName}` },
        }).pipe(Effect.provide(Context.add(services, Config.ServerConfig, base)));
        for (const method of ["GET", "HEAD"] as const) {
          for (const ranged of [false, true]) {
            const response = yield* sourceHttp(grant.relativeUrl, {
              method,
              headers: ranged ? { range: "bytes=0-2" } : {},
            });
            expect(response.status).toBe(200);
            expect(response.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
            expect(response.headers["content-type"]).toContain(contentType);
            expect(yield* response.text).toBe(method === "HEAD" ? "" : body);
          }
        }
      }
      const clock = yield* Clock.Clock;
      const expiredGrant = yield* mint.pipe(
        Effect.provide(Context.add(services, Config.ServerConfig, base)),
        Effect.provideService(Clock.Clock, {
          currentTimeMillis: Effect.succeed(0),
          currentTimeMillisUnsafe: () => 0,
          currentTimeNanos: clock.currentTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          sleep: (duration) => clock.sleep(duration),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        }),
      );
      expect((yield* sourceHttp(expiredGrant.relativeUrl)).status).toBe(404);
      const uploadGrant = yield* issueAttachmentUploadUrl({
        type: "file",
        name: "relay.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }).pipe(Effect.provide(Context.add(services, Config.ServerConfig, base)));
      const uploadHttp = yield* sourceHttp(uploadGrant.relativeUrl, {
        method: "POST",
        body: "abcdefghij",
        headers: { "content-type": "application/pdf" },
      });
      expect(uploadHttp.status).toBe(204);
      const uploadedAsset = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId: uploadGrant.attachmentId,
          fileName: "relay.pdf",
          mimeType: "application/pdf",
        },
      }).pipe(Effect.provide(Context.add(services, Config.ServerConfig, base)));
      expect(
        yield* sourceHttp(uploadedAsset.relativeUrl).pipe(
          Effect.flatMap((response) => response.text),
        ),
      ).toBe("abcdefghij");
      const badSize = yield* sourceHttp(uploadGrant.relativeUrl, { method: "POST", body: "short" });
      expect(badSize.status).toBe(400);
      yield* fs.remove(`${workspace}/relay.mp4`);
      expect((yield* sourceHttp(assetGrant.relativeUrl)).status).toBe(404);
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

it.live(
  "blocks read-only attach before native forwarding and any PTY mutation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-attach-boundary-workspace-",
      });
      const configServices = yield* Layer.build(
        Config.layerTest(workspace, { prefix: "t3-attach-boundary-home-" }),
      );
      const base = Context.get(configServices, Config.ServerConfig);
      const source = yield* startProductionServer(base);
      const manager = Context.get(source.services, TerminalManager.TerminalManager);
      const adapter = Context.get(source.services, PtyAdapter.PtyAdapter);
      const writes: ReturnType<typeof vi.spyOn>[] = [];
      const resizes: ReturnType<typeof vi.spyOn>[] = [];
      const originalSpawn = adapter.spawn;
      const creates = vi.spyOn(adapter, "spawn").mockImplementation((input) =>
        originalSpawn(input).pipe(
          Effect.tap((process) =>
            Effect.sync(() => {
              writes.push(vi.spyOn(process, "write"));
              resizes.push(vi.spyOn(process, "resize"));
            }),
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          creates.mockRestore();
          for (const spy of [...writes, ...resizes]) spy.mockRestore();
        }),
      );
      const env = {
        HOME: base.baseDir,
        ZDOTDIR: base.baseDir,
        HISTFILE: `${base.baseDir}/test-history`,
      };
      yield* manager.open({ threadId: "existing", terminalId: "default", cwd: workspace, env });
      yield* manager.open({ threadId: "stopped", terminalId: "default", cwd: workspace, env });
      yield* manager.close({ threadId: "stopped", terminalId: "default" });
      creates.mockClear();
      for (const spy of [...writes, ...resizes]) spy.mockClear();
      const auth = Context.get(source.services, EnvironmentAuth.EnvironmentAuth);
      const issued = yield* auth.issueSession({
        scopes: ["orchestration:read", "terminal:operate"],
      });
      const now = yield* DateTime.now;
      const environmentId = yield* Context.get(
        source.services,
        ServerEnvironment.ServerEnvironmentIdentity,
      ).getEnvironmentId;
      const target = {
        registrationId: FactoryRegistrationId.make("attach-boundary"),
        environmentId,
      };
      const environment = FactoryEnvironmentView.make({
        ...target,
        endpoint: source.origin,
        label: "Native",
        platform: null,
        enabled: true,
        state: "online",
        credentialStorage: "secure-vault",
        credentialExpiresAt: issued.expiresAt,
        renewal: "unsupported",
        lastSeenAt: null,
        revision: 1,
      });
      const credential = {
        token: issued.token,
        sourceSessionId: issued.sessionId,
        scopes: issued.scopes,
        issuedAt: now,
        expiresAt: issued.expiresAt,
      };
      const transportServices = yield* Layer.build(NodeSource.nodeLayer);
      const transport = Context.get(transportServices, Connections.SourceTransport);
      const session = yield* transport.connect({ environment, credential });
      const configEvent = yield* session.configs.pipe(
        Stream.filter((event) => event.type === "snapshot"),
        Stream.runHead,
      );
      if (configEvent._tag === "None" || configEvent.value.type !== "snapshot")
        return yield* Effect.die("Missing source config.");
      const access: Connections.SourceAccess = {
        target,
        connectionId: session,
        config: configEvent.value.config,
        sourceScopes: issued.scopes,
        checkCurrent: Effect.void,
        closed: Effect.never,
        shell: () => Stream.never,
        checkShellCurrent: Effect.void,
        shellSynchronized: Effect.void,
      };
      const forwarded: string[] = [];
      const dependencies = Layer.mergeAll(
        Config.layer({ ...base, factoryEnabled: true }),
        Layer.mock(SourceShell.SourceShell)({ isSynchronized: () => Effect.succeed(true) }),
        Layer.mock(Connections.Connections)({
          resolveTarget: () => Effect.succeed(access),
          openRelay: () =>
            transport.connectRelay!({ environment, credential }).pipe(
              Effect.map((socket) =>
                Socket.make({
                  reader: socket.reader,
                  writer: socket.writer.pipe(
                    Effect.map((writer) => ({
                      ...writer,
                      write: (frame) => {
                        if (!Socket.isCloseEvent(frame))
                          forwarded.push(
                            typeof frame === "string" ? frame : new TextDecoder().decode(frame),
                          );
                        return writer.write(frame);
                      },
                    })),
                  ),
                }),
              ),
            ),
        }),
      );
      const relayServices = yield* Layer.build(
        Relay.layer.pipe(
          Layer.provideMerge(RelayPolicy.layer.pipe(Layer.provideMerge(dependencies))),
        ),
      );
      const relay = Context.get(relayServices, Relay.Relay);
      for (const [threadId, fields] of [
        ["missing", { cwd: workspace }],
        ["existing", { env: { FACTORY_TEST: "value" } }],
        ["existing", { cols: 81 }],
        ["existing", { rows: 25 }],
        ["stopped", { restartIfNotRunning: true }],
        ["stopped", { cwd: workspace, env, restartIfNotRunning: true }],
        ["missing", { cwd: workspace, env }],
        ["existing", {}],
      ] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* memorySocket;
            const consumer = yield* relay
              .serve({ socket: browser.socket, target, callerScopes: ["factory:read"] })
              .pipe(Effect.forkScoped);
            yield* Queue.offer(
              browser.incoming,
              encode({
                _tag: "Request",
                id: 1,
                tag: "terminal.attach",
                payload: { threadId, terminalId: "default", ...fields },
                headers: [],
              }),
            );
            const outcome = yield* Effect.raceFirst(
              Fiber.join(consumer).pipe(Effect.result),
              Queue.take(browser.outgoing).pipe(Effect.as("source-replied" as const)),
            );
            yield* browser.close;
            expect(forwarded.filter((frame) => frame.includes('"terminal.attach"'))).toEqual([]);
            expect(creates).not.toHaveBeenCalled();
            for (const spy of [...writes, ...resizes]) expect(spy).not.toHaveBeenCalled();
            expect(outcome).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "RelayDenied", reason: "scope-required" },
            });
          }),
        );
      }
      const browser = yield* memorySocket;
      const consumer = yield* relay
        .serve({
          socket: browser.socket,
          target,
          callerScopes: ["factory:read", "factory:control"],
        })
        .pipe(Effect.forkScoped);
      yield* Queue.offer(
        browser.incoming,
        encode({
          _tag: "Request",
          id: 2,
          tag: "terminal.attach",
          payload: { threadId: "existing", terminalId: "default", cols: 82, rows: 26 },
          headers: [],
        }),
      );
      const reply = yield* Queue.take(browser.outgoing).pipe(Effect.flatMap(decode));
      const event = yield* decodeTerminalStream(reply.values?.[0]);
      expect(event).toMatchObject({ type: "snapshot", snapshot: { status: "running" } });
      expect(forwarded.filter((frame) => frame.includes('"terminal.attach"'))).toHaveLength(1);
      expect(resizes[0]).toHaveBeenCalledWith(82, 26);
      yield* browser.close;
      yield* Fiber.await(consumer);
      yield* manager.close({ threadId: "existing", terminalId: "default" });
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
