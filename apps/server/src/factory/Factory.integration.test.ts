import { vi } from "vite-plus/test";
import { phase2Gate } from "./testkit/Phase2Gate.ts";
vi.mock("../provider/builtInDrivers.ts", async () => {
  const { controlledProviderDriver } = await import("./testkit/ControlledProvider.ts");
  return {
    BUILT_IN_DRIVERS: [
      controlledProviderDriver("codex", true),
      controlledProviderDriver("cursor", false),
    ],
  };
});
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthFactoryControlScope,
  AuthFactoryReadScope,
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  EnvironmentId,
  EnvironmentAuthorizationError,
  FactoryEnvironmentEnrollInput,
  FactoryEnvironmentView,
  FactoryGroupsCreateRpc,
  FactoryControlAuthorizationRpc,
  FactoryEnvironmentsGetEmbeddedRouteRpc,
  type FactoryRemoteTarget,
  FactoryRpcMethods,
  FactoryOverviewEvent,
  FactoryOverviewSnapshot,
  FactoryRegistrationId,
  FactorySourceFreshness,
  NonNegativeInt,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationProjectShell,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
  ProjectId,
  ProviderInstanceId,
  ServerConfigStreamEvent,
  ThreadId,
  WS_METHODS,
  WsSubscribeServerConfigRpc,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Socket from "effect/unstable/socket/Socket";
import { resolveSessionCookieName } from "../auth/utils.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as FactoryRuntime from "./runtimeLayer.ts";
import * as SourceShell from "./SourceShell.ts";
import { makeFactoryRpcHandlers } from "./rpcHandlers.ts";
import { config as sourceConfig } from "./testkit/sourceConfig.ts";

const date = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
const factoryRpcBoundaryGroup = RpcGroup.make(
  FactoryGroupsCreateRpc,
  FactoryControlAuthorizationRpc,
  FactoryEnvironmentsGetEmbeddedRouteRpc,
);
const decodeShellItem = Schema.decodeEffect(OrchestrationV2ShellStreamItem);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sourceShellRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
  payload: OrchestrationV2SubscribeShellInput,
  success: OrchestrationV2ShellStreamItem,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});
const sourceRpcGroup = RpcGroup.make(WsSubscribeServerConfigRpc, sourceShellRpc);

type SourceShellControl = {
  readonly input: OrchestrationV2SubscribeShellInput;
  readonly snapshot: (item: OrchestrationV2ShellStreamItem) => Effect.Effect<void>;
  readonly emit: (item: OrchestrationV2ShellStreamItem) => Effect.Effect<void>;
};

type SourceConfigFeed = Queue.Queue<ServerConfigStreamEvent>;

type ControlledSource = {
  readonly home: string;
  readonly endpoint: string;
  readonly environmentId: string;
  readonly bootstrapCredential: string;
  readonly accessToken: string;
  readonly configFeeds: Queue.Queue<SourceConfigFeed>;
  readonly shellSubscriptions: Queue.Queue<SourceShellControl>;
  readonly stats: { tickets: number; exchangedScopes: string[] };
  readonly nextConfigFeed: Effect.Effect<SourceConfigFeed>;
};

const makeControlledSource = (
  name: string,
  environmentId: string,
  scopes: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: `t3-factory-source-${name}-` });
    const bootstrapCredential = `bootstrap-secret-${name}`;
    const claims = Buffer.from(`{"sid":"source-session-${name}"}`).toString("base64url");
    const accessToken = `${claims}.fixture-signature-${name}`;
    const validTickets = new Set<string>();
    const stats = { tickets: 0, exchangedScopes: [] as string[] };
    const configFeeds = yield* Queue.unbounded<SourceConfigFeed>();
    const shellSubscriptions = yield* Queue.unbounded<SourceShellControl>();
    const config = sourceConfig(environmentId);
    const descriptor = {
      environmentId,
      platform: null,
      capabilities: { factoryRenewal: false },
    };
    const authDescriptor = {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    };

    const sourceHandlers = sourceRpcGroup.toLayer({
      [WS_METHODS.subscribeServerConfig]: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const feed = yield* Queue.unbounded<ServerConfigStreamEvent>();
            yield* Queue.offer(configFeeds, feed);
            return Stream.concat(
              Stream.make({ version: 1 as const, type: "snapshot" as const, config }),
              Stream.fromQueue(feed),
            );
          }),
        ),
      [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
            yield* Queue.offer(shellSubscriptions, {
              input,
              snapshot: (item) => Queue.offer(items, item).pipe(Effect.asVoid),
              emit: (item) => Queue.offer(items, item).pipe(Effect.asVoid),
            });
            return Stream.fromQueue(items);
          }),
        ),
    });
    const sourceRoutes = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add(
          "GET",
          "/.well-known/t3/environment",
          HttpServerResponse.jsonUnsafe(descriptor),
        );
        yield* router.add("POST", "/oauth/token", (request) =>
          Effect.gen(function* () {
            const body = yield* request.urlParamsBody;
            const scope = Option.getOrUndefined(UrlParams.getFirst("scope")(body)) ?? "";
            stats.exchangedScopes.push(scope);
            if (
              Option.getOrUndefined(UrlParams.getFirst("subject_token")(body)) !==
                bootstrapCredential ||
              Option.getOrUndefined(UrlParams.getFirst("subject_token_type")(body)) !==
                AuthEnvironmentBootstrapTokenType
            ) {
              return HttpServerResponse.jsonUnsafe({ error: "invalid_grant" }, { status: 401 });
            }
            return HttpServerResponse.jsonUnsafe({
              access_token: accessToken,
              issued_token_type: AuthAccessTokenType,
              token_type: "Bearer",
              expires_in: 3600,
              scope: scopes.join(" "),
            });
          }),
        );
        yield* router.add("GET", "/api/auth/session", (request) => {
          const authorized = request.headers.authorization === `Bearer ${accessToken}`;
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              request.headers.authorization === `Bearer ${accessToken}`
                ? {
                    authenticated: true,
                    auth: authDescriptor,
                    scopes,
                    sessionMethod: "bearer-access-token",
                    expiresAt: "2099-01-01T00:00:00.000Z",
                  }
                : { authenticated: false, auth: authDescriptor },
              { status: authorized ? 200 : 401 },
            ),
          );
        });
        yield* router.add("POST", "/api/auth/websocket-ticket", (request) =>
          Effect.suspend(() => {
            if (request.headers.authorization !== `Bearer ${accessToken}`) {
              return Effect.succeed(
                HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 401 }),
              );
            }
            stats.tickets++;
            const ticket = `fixture-ticket-${name}-${stats.tickets}`;
            validTickets.add(ticket);
            return Effect.succeed(
              HttpServerResponse.jsonUnsafe({ ticket, expiresAt: "2099-01-01T00:00:00.000Z" }),
            );
          }),
        );
      }),
    );
    const websocketProtocol = RpcServer.layerProtocolWebsocket({ path: "/ws" }).pipe(
      Layer.provide(HttpRouter.layer),
    );
    const sourceRpcServer = RpcServer.layer(sourceRpcGroup).pipe(Layer.provide(sourceHandlers));
    const sourceApplication = Layer.mergeAll(websocketProtocol, sourceRoutes);
    const sourceHttpServer = sourceRpcServer.pipe(
      Layer.provideMerge(websocketProtocol),
      Layer.provide(
        HttpRouter.serve(sourceApplication, {
          disableLogger: true,
          disableListenLog: true,
        }),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpServer.layerTest, RpcSerialization.layerJson)),
    );
    const sourceScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(sourceScope, Exit.void));
    const services = yield* Layer.buildWithScope(sourceHttpServer, sourceScope);
    const httpServer = Context.get(services, HttpServer.HttpServer);
    const address = httpServer.address;
    if (!NetAddress.isInetAddress(address))
      throw new Error("Source did not bind to an internet address.");
    const endpoint = `http://127.0.0.1:${address.port}`;

    return {
      home,
      endpoint,
      environmentId,
      bootstrapCredential,
      accessToken,
      configFeeds,
      shellSubscriptions,
      stats,
      nextConfigFeed: Queue.take(configFeeds),
    } satisfies ControlledSource;
  });

const makeProject = (
  id: string,
  title: string,
  workspaceRoot: string,
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
});

const makeThread = (title: string): OrchestrationV2ThreadShell =>
  Schema.decodeSync(OrchestrationV2ThreadShell)({
    id: ThreadId.make("same-thread"),
    projectId: ProjectId.make("same-project"),
    title,
    providerInstanceId: ProviderInstanceId.make("fixture-provider"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("fixture-provider"),
      model: "fixture-model",
    },
    createdBy: "user",
    creationSource: "web",
    runtimeMode: "full-access",
    interactionMode: "default",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make("same-thread"),
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "running",
    branch: null,
    worktreePath: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    settledAt: null,
    settledOverride: null,
    latestRunCompletedAt: null,
    createdAt: date,
    updatedAt: date,
    archivedAt: null,
    deletedAt: null,
  });

const shellSnapshot = (input: {
  readonly environmentId: string;
  readonly sequence: number;
  readonly threadTitle: string | null;
  readonly projectTitle?: string;
  readonly resetReason?: "invalid-cursor";
}): OrchestrationV2ShellStreamItem => ({
  kind: "snapshot",
  ...(input.resetReason === undefined ? {} : { resetReason: input.resetReason }),
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: NonNegativeInt.make(input.sequence),
    projects: [
      makeProject(
        "same-project",
        input.projectTitle ?? `${input.environmentId} project`,
        `/work/${input.environmentId}/same-project`,
      ),
      makeProject(
        "empty-project",
        `${input.environmentId} empty`,
        `/work/${input.environmentId}/empty`,
      ),
    ],
    threads: input.threadTitle === null ? [] : [makeThread(input.threadTitle)],
    archivedThreads: [],
  },
});

const makeFactoryConfig = (baseDir: string, enabled: boolean) =>
  Effect.gen(function* () {
    const base = yield* Effect.provide(
      ServerConfig.ServerConfig,
      ServerConfig.layerTest(process.cwd(), baseDir),
    );
    return ServerConfig.layer({
      ...base,
      factoryEnabled: enabled,
      factoryCredentialStore: "protected-file",
    });
  });

const startFactory = (baseDir: string, enabled = true) =>
  Effect.gen(function* () {
    const configLayer = yield* makeFactoryConfig(baseDir, enabled);
    const config = yield* Effect.provide(ServerConfig.ServerConfig, configLayer);
    const dependencies = Layer.mergeAll(
      SqlitePersistence.layerConfig.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(configLayer),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
    ).pipe(Layer.provideMerge(configLayer));
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const services = yield* Layer.buildWithScope(
      FactoryRuntime.layer().pipe(Layer.provideMerge(dependencies)),
      scope,
    );
    return {
      config,
      scope,
      runtime: Context.get(services, FactoryRuntime.FactoryRuntime),
    };
  });

const startFactoryRpcBoundaryServer = <HandlersOut, HandlersError, HandlersIn>(
  serverAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  handlersForSession: (
    session: EnvironmentAuth.AuthenticatedSession,
  ) => Layer.Layer<HandlersOut, HandlersError, HandlersIn>,
) =>
  Effect.gen(function* () {
    const routes = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/ws", (request) =>
          Effect.gen(function* () {
            const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
            const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
            yield* RpcServer.make(factoryRpcBoundaryGroup, { disableTracing: true }).pipe(
              Effect.provideService(RpcServer.Protocol, protocol),
              Effect.provide(handlersForSession(session)),
              Effect.forkScoped,
            );
            return yield* httpEffect;
          }),
        );
      }),
    );
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const services = yield* Layer.buildWithScope(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeHttpServer.layerTest, RpcSerialization.layerJson)),
      ),
      scope,
    );
    const address = Context.get(services, HttpServer.HttpServer).address;
    if (!NetAddress.isInetAddress(address))
      throw new Error("Factory RPC test server did not bind to an internet address.");
    return "http://127.0.0.1:" + address.port;
  });

const sourceUpdateWaiter = <E>(updates: Queue.Dequeue<SourceShell.SourceShellUpdate, E>) => {
  const pending: SourceShell.SourceShellUpdate[] = [];
  const takeMatching = (matches: (update: SourceShell.SourceShellUpdate) => boolean) =>
    Effect.gen(function* () {
      const pendingIndex = pending.findIndex(matches);
      if (pendingIndex >= 0) return pending.splice(pendingIndex, 1)[0]!;
      while (true) {
        const update = yield* Queue.take(updates);
        if (matches(update)) return update;
        pending.push(update);
      }
    });

  return {
    state: (environmentId: string, state: FactorySourceFreshness["state"]) =>
      takeMatching(
        (update) =>
          update.kind === "source" &&
          update.source.target.environmentId === environmentId &&
          update.source.freshness.state === state,
      ),
    frame: (environmentId: string, kind: SourceShell.SourceShellFrame["kind"]) =>
      takeMatching(
        (update) =>
          update.kind === "frame" &&
          update.frame.target.environmentId === environmentId &&
          update.frame.kind === kind,
      ),
  };
};

it.layer(NodeServices.layer)("factory authenticated RPC boundary", (it) => {
  it.effect("denies read-only factory RPCs without side effects and permits control scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-rpc-boundary-" });
      const configLayer = yield* makeFactoryConfig(home, true);
      const authScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(authScope, Exit.void));
      const authServices = yield* Layer.buildWithScope(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistence.SqlitePersistenceMemory),
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(ServerEnvironment.identityLayer),
          Layer.provide(configLayer),
        ),
        authScope,
      );
      const serverAuth = Context.get(authServices, EnvironmentAuth.EnvironmentAuth);
      const sourceA = yield* makeControlledSource("rpc-a", "rpc-env-a");
      const sourceB = yield* makeControlledSource("rpc-b", "rpc-env-b", ["orchestration:read"]);
      const factory = yield* startFactory(home);
      const enrollment = yield* factory.runtime.getEnrollment;
      const environmentA = yield* enrollment.enroll({
        endpoint: sourceA.endpoint,
        label: "RPC Source A",
        sourceCredential: sourceA.bootstrapCredential,
      });
      const environmentB = yield* enrollment.enroll({
        endpoint: sourceB.endpoint,
        label: "RPC Source B",
        sourceCredential: sourceB.bootstrapCredential,
      });
      yield* sourceA.nextConfigFeed;
      yield* sourceB.nextConfigFeed;
      const shellA = yield* Queue.take(sourceA.shellSubscriptions);
      const shellB = yield* Queue.take(sourceB.shellSubscriptions);
      const sourceShellService = yield* factory.runtime.getSourceShell;
      const changes = yield* Stream.toQueue(sourceShellService.subscribe, { capacity: 128 });
      const waiter = sourceUpdateWaiter(changes);
      for (const [source, shell] of [
        [sourceA, shellA],
        [sourceB, shellB],
      ] as const) {
        yield* shell.snapshot(
          yield* decodeShellItem(
            shellSnapshot({
              environmentId: source.environmentId,
              sequence: 1,
              threadTitle: "Observed source",
            }),
          ),
        );
        yield* shell.emit({ kind: "synchronized" });
        yield* waiter.frame(source.environmentId, "synchronized");
      }
      const metadata = yield* factory.runtime.getMetadata;
      const sourceShell = yield* factory.runtime.getSourceShell;
      const connections = yield* factory.runtime.getConnections;
      const before = yield* metadata.getSnapshot;
      const sourceStatesBefore = yield* sourceShell.getStates;
      const ticketsBefore = sourceA.stats.tickets + sourceB.stats.tickets;
      const handlersForSession = (session: EnvironmentAuth.AuthenticatedSession) => {
        const productionHandlers = makeFactoryRpcHandlers(session, factory.runtime);
        return factoryRpcBoundaryGroup.toLayer({
          [FactoryRpcMethods.groupsCreate]: productionHandlers[FactoryRpcMethods.groupsCreate],
          [FactoryRpcMethods.controlAuthorization]:
            productionHandlers[FactoryRpcMethods.controlAuthorization],
          [FactoryRpcMethods.environmentsGetEmbeddedRoute]:
            productionHandlers[FactoryRpcMethods.environmentsGetEmbeddedRoute],
        });
      };
      const callGroupsCreate = (scopes: ReadonlyArray<AuthEnvironmentScope>, name: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const issued = yield* serverAuth.issueSession({ scopes });
            const ticket = yield* serverAuth.issueWebSocketTicket(issued);
            const endpoint = yield* startFactoryRpcBoundaryServer(serverAuth, handlersForSession);
            const socketUrl = new URL("/ws", endpoint);
            socketUrl.protocol = "ws:";
            socketUrl.searchParams.set("wsTicket", ticket.ticket);
            const socketLayer = Socket.layerWebSocket(socketUrl.toString(), {
              openTimeout: "15 seconds",
            }).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS));
            const protocolLayer = Layer.effect(
              RpcClient.Protocol,
              RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
            ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
            const protocolServices = yield* Layer.build(protocolLayer);
            const client = yield* RpcClient.make(factoryRpcBoundaryGroup).pipe(
              Effect.provide(protocolServices),
            );
            return yield* client[FactoryRpcMethods.groupsCreate]({ name });
          }),
        );

      const callEmbeddedRoute = (
        scopes: ReadonlyArray<AuthEnvironmentScope>,
        target: FactoryRemoteTarget,
        threadId: ThreadId,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const pairing = yield* serverAuth.issuePairingCredential({ scopes });
            const cookie = yield* serverAuth.createBrowserSession(pairing.credential, {
              label: "Embedded route",
              ipAddress: "127.0.0.1",
              userAgent: "test",
              deviceType: "unknown",
              os: "test",
              browser: "test",
            });
            const identity = Context.get(authServices, ServerEnvironment.ServerEnvironmentIdentity);
            const authConfig = yield* Effect.provide(ServerConfig.ServerConfig, configLayer);
            const cookieName = resolveSessionCookieName({
              mode: authConfig.mode,
              port: authConfig.port,
              host: authConfig.host,
              instanceKey: authConfig.stateDir,
              environmentId: yield* identity.getEnvironmentId,
              development: authConfig.devUrl !== undefined,
            });
            const endpoint = yield* startFactoryRpcBoundaryServer(serverAuth, handlersForSession);
            const socket = yield* Socket.makeWebSocket(
              endpoint.replace("http:", "ws:") + "/ws",
            ).pipe(
              Effect.provideService(
                Socket.WebSocketConstructor,
                (url) =>
                  new NodeSocket.NodeWS.WebSocket(url, {
                    headers: { cookie: cookieName + "=" + cookie.sessionToken },
                  }),
              ),
            );
            const protocol = yield* RpcClient.makeProtocolSocket({
              retryTransientErrors: false,
            }).pipe(
              Effect.provideService(Socket.Socket, socket),
              Effect.provide(RpcSerialization.layerJson),
            );
            const client = yield* RpcClient.make(factoryRpcBoundaryGroup).pipe(
              Effect.provideService(RpcClient.Protocol, protocol),
            );
            return yield* client[FactoryRpcMethods.environmentsGetEmbeddedRoute]({
              target,
              threadId,
            });
          }),
        );

      const callControl = (
        scopes: ReadonlyArray<AuthEnvironmentScope>,
        target: FactoryRemoteTarget,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const pairing = yield* serverAuth.issuePairingCredential({ scopes });
            const cookie = yield* serverAuth.createBrowserSession(pairing.credential, {
              label: "Control observation",
              ipAddress: "127.0.0.1",
              userAgent: "test",
              deviceType: "unknown",
              os: "test",
              browser: "test",
            });
            const identity = Context.get(authServices, ServerEnvironment.ServerEnvironmentIdentity);
            const authConfig = yield* Effect.provide(ServerConfig.ServerConfig, configLayer);
            const cookieName = resolveSessionCookieName({
              mode: authConfig.mode,
              port: authConfig.port,
              host: authConfig.host,
              instanceKey: authConfig.stateDir,
              environmentId: yield* identity.getEnvironmentId,
              development: authConfig.devUrl !== undefined,
            });
            const endpoint = yield* startFactoryRpcBoundaryServer(serverAuth, handlersForSession);
            const socket = yield* Socket.makeWebSocket(
              endpoint.replace("http:", "ws:") + "/ws",
            ).pipe(
              Effect.provideService(
                Socket.WebSocketConstructor,
                (url) =>
                  new NodeSocket.NodeWS.WebSocket(url, {
                    headers: { cookie: `${cookieName}=${cookie.sessionToken}` },
                  }),
              ),
            );
            const protocol = yield* RpcClient.makeProtocolSocket({
              retryTransientErrors: false,
            }).pipe(
              Effect.provideService(Socket.Socket, socket),
              Effect.provide(RpcSerialization.layerJson),
            );
            const client = yield* RpcClient.make(factoryRpcBoundaryGroup).pipe(
              Effect.provideService(RpcClient.Protocol, protocol),
            );
            return yield* client[FactoryRpcMethods.controlAuthorization]({
              target,
              operation: "message.dispatch",
            });
          }),
        );
      const targetA = {
        registrationId: environmentA.registrationId,
        environmentId: environmentA.environmentId,
      };
      const targetB = {
        registrationId: environmentB.registrationId,
        environmentId: environmentB.environmentId,
      };
      const embeddedA = yield* callEmbeddedRoute(
        ["factory:read"],
        targetA,
        ThreadId.make("same-thread"),
      );
      const embeddedB = yield* callEmbeddedRoute(
        ["factory:read"],
        targetB,
        ThreadId.make("same-thread"),
      );
      expect(embeddedA).toMatchObject({
        target: targetA,
        threadId: "same-thread",
        href: `/rpc-env-a/same-thread?factoryEmbedded=1&factoryRegistrationId=${environmentA.registrationId}`,
        sourceAccess: {
          websocketRoute: `/factory/env/${environmentA.registrationId}/ws`,
          httpPrefix: `/factory/env/${environmentA.registrationId}/`,
          capabilities: { websocket: true, http: true },
        },
      });
      expect(embeddedB.href).toBe(
        `/rpc-env-b/same-thread?factoryEmbedded=1&factoryRegistrationId=${environmentB.registrationId}`,
      );
      expect(encodeJson(embeddedA)).not.toMatch(
        /bootstrapCredential|accessToken|sourceCredential|secret/i,
      );
      expect(
        yield* Effect.flip(
          callEmbeddedRoute(["factory:control"], targetA, ThreadId.make("same-thread")),
        ),
      ).toBeInstanceOf(EnvironmentAuthorizationError);
      const mismatched = yield* Effect.flip(
        callEmbeddedRoute(
          ["factory:read"],
          { ...targetA, environmentId: targetB.environmentId },
          ThreadId.make("same-thread"),
        ),
      );
      expect(mismatched).toMatchObject({ _tag: "FactoryError", code: "target-mismatch" });
      const missingThread = yield* Effect.flip(
        callEmbeddedRoute(["factory:read"], targetA, ThreadId.make("missing-thread")),
      );
      expect(missingThread).toMatchObject({ _tag: "FactoryError", code: "not-found" });

      expect(yield* callControl(["factory:read", "factory:control"], targetA)).toEqual({
        allowed: true,
      });
      expect(yield* callControl(["factory:read"], targetA)).toEqual({
        allowed: false,
        reason: "scope-required",
      });
      expect(yield* callControl(["factory:read", "factory:control"], targetB)).toEqual({
        allowed: false,
        reason: "source-scope-required",
      });
      expect(yield* Effect.flip(callControl(["factory:control"], targetA))).toBeInstanceOf(
        EnvironmentAuthorizationError,
      );
      expect(sourceA.stats.exchangedScopes).toEqual([AuthStandardClientScopes.join(" ")]);
      expect(sourceB.stats.exchangedScopes).toEqual([AuthStandardClientScopes.join(" ")]);
      expect(yield* metadata.getSnapshot).toEqual(before);
      expect(yield* sourceShell.getStates).toEqual(sourceStatesBefore);

      const denied = yield* Effect.flip(
        callGroupsCreate([AuthFactoryReadScope], "Denied read-only mutation"),
      );
      expect(denied).toBeInstanceOf(EnvironmentAuthorizationError);
      expect(yield* metadata.getSnapshot).toEqual(before);
      expect(yield* sourceShell.getStates).toEqual(sourceStatesBefore);
      expect(sourceA.stats.tickets + sourceB.stats.tickets).toBe(ticketsBefore);

      const created = yield* callGroupsCreate(
        [AuthFactoryControlScope],
        "Authorized control mutation",
      );
      expect(created.name).toBe("Authorized control mutation");
      expect((yield* metadata.getSnapshot).groups).toHaveLength(before.groups.length + 1);
      expect(yield* sourceShell.getStates).toEqual(sourceStatesBefore);
      expect(sourceA.stats.tickets + sourceB.stats.tickets).toBe(ticketsBefore);

      yield* connections.disable(environmentA.registrationId);
      const disconnectedRoute = yield* Effect.flip(
        callEmbeddedRoute(["factory:read"], targetA, ThreadId.make("same-thread")),
      );
      expect(disconnectedRoute).toMatchObject({ _tag: "FactoryError", code: "source-unavailable" });
    }),
  );
});

it.layer(NodeServices.layer)("factory phase 1 integration", (it) => {
  it.effect(
    "enrolls two isolated sources, streams complete state, and restarts from metadata only",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-phase1-home-" });
        const sourceA = yield* makeControlledSource("a", "source-env-a");
        const sourceB = yield* makeControlledSource("b", "source-env-b");
        const factory = yield* startFactory(home);
        expect(factory.runtime.enabled).toBe(true);
        const metadata = yield* factory.runtime.getMetadata;
        const connections = yield* factory.runtime.getConnections;
        const sourceShell = yield* factory.runtime.getSourceShell;
        const overview = yield* factory.runtime.getOverview;
        const overviewEvents = yield* Stream.toQueue(overview.subscribe, { capacity: 128 });
        const sourceEvents = yield* Stream.toQueue(sourceShell.subscribe, { capacity: 128 });
        const sourceWaiter = sourceUpdateWaiter(sourceEvents);
        const initialOverview = yield* Queue.take(overviewEvents);
        expect(initialOverview.type).toBe("snapshot");
        const initialSources = yield* Queue.take(sourceEvents);
        expect(initialSources.kind).toBe("snapshot");
        expect(sourceA.stats.tickets + sourceB.stats.tickets).toBe(0);

        const enrollment = yield* factory.runtime.getEnrollment;
        const environmentA = yield* enrollment.enroll({
          endpoint: sourceA.endpoint,
          label: "Source A",
          sourceCredential: sourceA.bootstrapCredential,
        } satisfies FactoryEnvironmentEnrollInput);
        const environmentB = yield* enrollment.enroll({
          endpoint: sourceB.endpoint,
          label: "Source B",
          sourceCredential: sourceB.bootstrapCredential,
        } satisfies FactoryEnvironmentEnrollInput);
        yield* sourceA.nextConfigFeed;
        yield* sourceB.nextConfigFeed;
        const shellA = yield* Queue.take(sourceA.shellSubscriptions);
        const shellB = yield* Queue.take(sourceB.shellSubscriptions);
        expect(shellA.input).toMatchObject({ batchedReplay: true, requestCompletionMarker: true });
        expect(shellB.input).toMatchObject({ batchedReplay: true, requestCompletionMarker: true });
        const snapshotA = yield* Schema.decodeEffect(OrchestrationV2ShellStreamItem)(
          shellSnapshot({
            environmentId: sourceA.environmentId,
            sequence: 1,
            threadTitle: "A initial",
          }),
        );
        const snapshotB = yield* Schema.decodeEffect(OrchestrationV2ShellStreamItem)(
          shellSnapshot({
            environmentId: sourceB.environmentId,
            sequence: 1,
            threadTitle: "B initial",
          }),
        );
        yield* shellA.snapshot(snapshotA);
        yield* shellA.emit({ kind: "synchronized" });
        yield* shellB.snapshot(snapshotB);
        yield* shellB.emit({ kind: "synchronized" });
        yield* sourceWaiter.frame(sourceA.environmentId, "snapshot");
        yield* sourceWaiter.frame(sourceA.environmentId, "synchronized");
        yield* sourceWaiter.frame(sourceB.environmentId, "snapshot");
        yield* sourceWaiter.frame(sourceB.environmentId, "synchronized");
        const initialSourceStates = yield* sourceShell.getStates;
        expect(initialSourceStates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              target: expect.objectContaining({ environmentId: sourceA.environmentId }),
              appliedCursor: 1,
              freshness: expect.objectContaining({ state: "fresh" }),
            }),
            expect.objectContaining({
              target: expect.objectContaining({ environmentId: sourceB.environmentId }),
              appliedCursor: 1,
              freshness: expect.objectContaining({ state: "fresh" }),
            }),
          ]),
        );

        let snapshot = yield* overview.getSnapshot;
        expect(Schema.is(FactoryOverviewSnapshot)(snapshot)).toBe(true);
        expect(
          snapshot.projects.filter((project) => project.key.projectId === "empty-project"),
        ).toHaveLength(2);
        expect(
          snapshot.projects.filter((project) => project.key.projectId === "same-project"),
        ).toHaveLength(2);
        expect(snapshot.threads.map((thread) => thread.title).toSorted()).toEqual([
          "A initial",
          "B initial",
        ]);
        let rows = snapshot.threads.map((thread) => ({
          environmentId: thread.key.environmentId,
          threadId: thread.key.threadId,
        }));
        expect(
          new Set(rows.map((row) => JSON.stringify([row.environmentId, row.threadId]))).size,
        ).toBe(rows.length);

        yield* shellA.emit({
          kind: "thread.updated",
          location: "active",
          sequence: NonNegativeInt.make(2),
          thread: makeThread("A after delta"),
        });
        yield* sourceWaiter.frame(sourceA.environmentId, "thread.updated");
        snapshot = yield* overview.getSnapshot;
        expect(
          snapshot.threads.find((thread) => thread.key.environmentId === sourceA.environmentId)
            ?.title,
        ).toBe("A after delta");

        const contiguousEvents = yield* Stream.toQueue(overview.subscribe, { capacity: 8 });
        const contiguousBase = yield* Queue.take(contiguousEvents);
        expect(contiguousBase.type).toBe("snapshot");
        if (contiguousBase.type !== "snapshot") throw new Error("Expected overview snapshot.");
        const group = yield* metadata.createGroup({ name: "Phase 1" });
        const metadataPatchRevision = yield* Stream.fromQueue(contiguousEvents).pipe(
          Stream.filterMap((event) =>
            event.type === "patch" && event.patch.kind === "metadata"
              ? Result.succeed(event.revision)
              : Result.failVoid,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(metadataPatchRevision).toBe(contiguousBase.snapshot.revision + 1);
        yield* metadata.setFavorite({
          target: { kind: "group", groupId: group.id },
          favorite: true,
        });

        expect(sourceA.stats.exchangedScopes).toEqual([AuthStandardClientScopes.join(" ")]);
        expect(sourceB.stats.exchangedScopes).toEqual([AuthStandardClientScopes.join(" ")]);
        expect(sourceA.stats.tickets).toBe(1);
        expect(sourceB.stats.tickets).toBe(1);

        const metadataSnapshot = yield* metadata.getSnapshot;
        const metadataJson = encodeJson(metadataSnapshot);
        expect(metadataJson).not.toContain(sourceA.bootstrapCredential);
        expect(metadataJson).not.toContain(sourceA.accessToken);
        expect(metadataJson).not.toContain(sourceB.bootstrapCredential);
        expect(metadataJson).not.toContain(sourceB.accessToken);
        const rawDatabase = new TextDecoder().decode(yield* fs.readFile(factory.config.dbPath));
        expect(rawDatabase).not.toContain(sourceA.bootstrapCredential);
        expect(rawDatabase).not.toContain(sourceA.accessToken);
        expect(rawDatabase).not.toContain(sourceB.bootstrapCredential);
        expect(rawDatabase).not.toContain(sourceB.accessToken);
        const walPath = `${factory.config.dbPath}-wal`;
        if (yield* fs.exists(walPath)) {
          const wal = new TextDecoder().decode(yield* fs.readFile(walPath));
          expect(wal).not.toContain(sourceA.bootstrapCredential);
          expect(wal).not.toContain(sourceA.accessToken);
          expect(wal).not.toContain(sourceB.bootstrapCredential);
          expect(wal).not.toContain(sourceB.accessToken);
        }

        yield* connections.retry(environmentA.registrationId);
        yield* sourceWaiter.state(sourceA.environmentId, "stale");
        yield* sourceA.nextConfigFeed;
        const reconnectedShellA = yield* Queue.take(sourceA.shellSubscriptions);
        yield* reconnectedShellA.snapshot(
          shellSnapshot({
            environmentId: sourceA.environmentId,
            sequence: 3,
            projectTitle: "A reset project",
            threadTitle: null,
            resetReason: "invalid-cursor",
          }),
        );
        yield* reconnectedShellA.emit({ kind: "synchronized" });
        yield* sourceWaiter.frame(sourceA.environmentId, "snapshot");
        yield* sourceWaiter.frame(sourceA.environmentId, "synchronized");
        expect(
          (yield* sourceShell.getStates).find(
            (source) => source.target.environmentId === sourceA.environmentId,
          )?.freshness.state,
        ).toBe("fresh");
        snapshot = yield* overview.getSnapshot;
        expect(snapshot.threads.map((thread) => thread.title)).toEqual(["B initial"]);
        expect(
          snapshot.projects.find(
            (project) =>
              project.key.environmentId === sourceA.environmentId &&
              project.key.projectId === "same-project",
          ),
        ).toMatchObject({ title: "A reset project" });
        expect(
          snapshot.projects.filter((project) => project.key.projectId === "empty-project"),
        ).toHaveLength(2);
        rows = snapshot.threads.map((thread) => ({
          environmentId: thread.key.environmentId,
          threadId: thread.key.threadId,
        }));
        expect(
          new Set(rows.map((row) => JSON.stringify([row.environmentId, row.threadId]))).size,
        ).toBe(rows.length);

        const savedGroups = snapshot.groups;
        const savedFavorites = snapshot.favorites;
        yield* Scope.close(factory.scope, Exit.void);
        const restarted = yield* startFactory(home);
        const restartedOverview = yield* restarted.runtime.getOverview;
        const restartedSourceShell = yield* restarted.runtime.getSourceShell;
        const restartEvents = yield* Stream.toQueue(restartedSourceShell.subscribe, {
          capacity: 64,
        });
        const restartWaiter = sourceUpdateWaiter(restartEvents);
        yield* Queue.take(restartEvents);
        yield* sourceA.nextConfigFeed;
        yield* sourceB.nextConfigFeed;
        const restartShellA = yield* Queue.take(sourceA.shellSubscriptions);
        const restartShellB = yield* Queue.take(sourceB.shellSubscriptions);
        const emptyAfterRestart = yield* restartedOverview.getSnapshot;
        expect(emptyAfterRestart.groups).toEqual(savedGroups);
        expect(emptyAfterRestart.favorites).toEqual(savedFavorites);
        expect(emptyAfterRestart.threads).toEqual([]);
        expect(emptyAfterRestart.projects).toEqual([]);
        expect(emptyAfterRestart.sourceFreshness.map((item) => item.state)).toContain(
          "synchronizing",
        );
        yield* restartShellA.snapshot(
          shellSnapshot({
            environmentId: sourceA.environmentId,
            sequence: 4,
            threadTitle: "A restored",
          }),
        );
        yield* restartShellA.emit({ kind: "synchronized" });
        yield* restartShellB.snapshot(
          shellSnapshot({
            environmentId: sourceB.environmentId,
            sequence: 2,
            threadTitle: "B restored",
          }),
        );
        yield* restartShellB.emit({ kind: "synchronized" });
        yield* restartWaiter.frame(sourceA.environmentId, "snapshot");
        yield* restartWaiter.frame(sourceA.environmentId, "synchronized");
        yield* restartWaiter.frame(sourceB.environmentId, "snapshot");
        yield* restartWaiter.frame(sourceB.environmentId, "synchronized");
        expect(
          (yield* restartedSourceShell.getStates).map((source) => source.freshness.state),
        ).toEqual(["fresh", "fresh"]);
        const restored = yield* restartedOverview.getSnapshot;
        expect(restored.threads.map((thread) => thread.title).toSorted()).toEqual([
          "A restored",
          "B restored",
        ]);
        const wireEvent = yield* Schema.decodeEffect(FactoryOverviewEvent)({
          type: "snapshot",
          snapshot: restored,
        });
        expect(wireEvent.type).toBe("snapshot");

        yield* Scope.close(restarted.scope, Exit.void);
        const ticketsBeforePassiveStartup = sourceA.stats.tickets + sourceB.stats.tickets;
        const passive = yield* startFactory(home, false);
        expect(passive.runtime.enabled).toBe(false);
        expect(sourceA.stats.tickets + sourceB.stats.tickets).toBe(ticketsBeforePassiveStartup);
        expect(savedGroups).toHaveLength(1);
        expect(savedFavorites).toHaveLength(1);
      }),
  );
});

it.live.skipIf(process.env.T3_FACTORY_UI_CHECKOUT === undefined)(
  "phase2 connects production source/factory services to actual UI owners",
  () => phase2Gate,
  { timeout: 90_000 },
);
