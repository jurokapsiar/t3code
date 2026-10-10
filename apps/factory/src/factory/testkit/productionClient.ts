import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import WebSocket from "ws";
import {
  FactoryFrameMessage,
  FactoryFrameTarget,
  type FactoryOverviewSnapshot,
} from "@t3tools/contracts/factory";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { FactoryControlOperation } from "@t3tools/contracts/factoryRpc";
import { WsRpcGroup } from "@t3tools/contracts/rpc";
import { QueryClient } from "@tanstack/react-query";
import { FactoryConnection } from "../FactoryConnection";
import { createFrameHandshake } from "../frameHandshake";
import { threadDetailKey } from "../queryKeys";
import { applyOverviewEvent } from "../overviewReducer";
import {
  dispatchSourceCommand,
  sourceActionScopeKey,
  threadActionObservation,
  SourceCommandUncertainError,
  SourceCommandUnavailableError,
  rollbackUnavailableReason,
} from "../actionPolicy";
import type { SourceDispatchCommand, SourceActionIntent } from "../actionPolicy";
import {
  readThreadBoundedSnapshot,
  readThreadHistoryPage,
  readWorkspaceDirectory,
  readWorkspaceFile,
} from "../sourceDetailApi";
import { selectWorkspaceEntry } from "../workspaceFiles";
import {
  describeRuntimeRequests,
  prepareUserInputAnswers,
  makeRuntimeRequestResponse,
} from "../../components/session/runtimeRequests";
import { resolveModelOptions } from "../../components/modals/launchOptions";

const Input = Schema.Struct({
  origin: Schema.String,
  cookie: Schema.String,
  readCookie: Schema.String,
  environmentIds: Schema.Array(Schema.String),
  workspace: Schema.String,
  assetPath: Schema.String,
});
export type ProductionGateInput = typeof Input.Type;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Shared contracts and actual UI owners; the parent owns listeners and native effect drains. */
export async function runProductionClient(input: ProductionGateInput) {
  const lines = NodeReadline.createInterface({ input: process.stdin });
  const answers = new Map<number, (value: unknown) => void>();
  lines.on("line", (line) => {
    const reply = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.Number, value: Schema.Unknown }),
    )(JSON.parse(line));
    const answer = answers.get(reply.id);
    NodeAssert.ok(answer, "Unexpected parent milestone");
    answers.delete(reply.id);
    answer(reply.value);
  });
  let next = 0;
  const milestone = (name: string, data?: unknown) =>
    new Promise<unknown>((resolve) => {
      const id = ++next;
      answers.set(id, resolve);
      NodeFS.writeSync(3, JSON.stringify({ id, name, data }) + "\n");
    });
  const requests: Array<{
    transport: string;
    origin: string;
    path: string;
    method?: string;
    commandId?: string;
  }> = [];
  const requestPath = (pathname: string) =>
    pathname
      .replace(/(\/api\/assets\/)[^/]+/, "$1<asset-grant>")
      .replace(/(\/api\/attachments\/upload\/)[^/]+/, "$1<upload-grant>");
  const socketOrigin = (value: string) => {
    const url = new URL(value);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  };
  const fetchFactory = (inputUrl: string | URL, init: RequestInit = {}, cookie = input.cookie) => {
    const url = new URL(String(inputUrl), input.origin);
    NodeAssert.equal(url.origin, input.origin, "No browser request may leave the factory origin");
    requests.push({
      transport: "http",
      origin: url.origin,
      path: requestPath(url.pathname),
      method: init.method ?? "GET",
    });
    return fetch(url, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
      headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
    });
  };
  let dropNextNativeExit = false;
  let dropped = 0;
  class CookieSocket extends WebSocket {
    constructor(address: string | URL, cookie: string) {
      NodeAssert.equal(socketOrigin(String(address)), input.origin);
      requests.push({ transport: "ws", origin: input.origin, path: new URL(address).pathname });
      super(address, { headers: { cookie } });
    }
    override send(
      data: Parameters<WebSocket["send"]>[0],
      options?: Parameters<WebSocket["send"]>[1] | ((err?: Error) => void),
      cb?: (err?: Error) => void,
    ) {
      const raw = JSON.parse(String(data));
      if (raw._tag === "Request")
        requests.push({
          transport: "rpc",
          origin: socketOrigin(this.url),
          path: new URL(this.url).pathname,
          method: raw.tag,
          commandId: raw.payload?.commandId,
        });
      return typeof options === "function" || options === undefined
        ? super.send(data, options)
        : super.send(data, options, cb);
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === "message" && this.url.includes("/factory/env/") && dropNextNativeExit) {
        const frame = JSON.parse(String(args[0]));
        if (frame._tag === "Exit") {
          dropNextNativeExit = false;
          dropped++;
          this.close();
          return true;
        }
      }
      return super.emit(event, ...args);
    }
  }
  const makeConnection = (cookie: string) =>
    new FactoryConnection({
      origin: input.origin,
      retryDelayMs: 60_000,
      fetch: (path, init) => {
        NodeAssert.equal(init?.credentials, "same-origin");
        return fetchFactory(String(path), init, cookie);
      },
      webSocketConstructor: (address) => new CookieSocket(address, cookie),
    });
  const connection = makeConnection(input.cookie);
  let overview: FactoryOverviewSnapshot | undefined;
  const waits: Array<{
    predicate: (snapshot: FactoryOverviewSnapshot) => boolean;
    resolve: (snapshot: FactoryOverviewSnapshot) => void;
  }> = [];
  const waitOverview = (predicate: (snapshot: FactoryOverviewSnapshot) => boolean) => {
    if (overview !== undefined && predicate(overview)) return Promise.resolve(overview);
    return new Promise<FactoryOverviewSnapshot>((resolve) => waits.push({ predicate, resolve }));
  };
  const stream = connection.acquireStream(
    "phase2-overview",
    (client) => client["factory.overview.subscribe"]({}),
    (event) => {
      const result = applyOverviewEvent(overview, event);
      NodeAssert.notEqual(result.kind, "reset-required");
      if (result.kind !== "applied") return;
      overview = result.value;
      for (const wait of [...waits])
        if (wait.predicate(overview)) {
          waits.splice(waits.indexOf(wait), 1);
          wait.resolve(overview);
        }
    },
  );
  connection.start();
  const leases: Array<Awaited<ReturnType<FactoryConnection["acquireSource"]>>> = [];
  const makeQuery = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let query = makeQuery();
  const [environmentId, otherEnvironmentId] = input.environmentIds;
  NodeAssert.ok(environmentId && otherEnvironmentId);
  try {
    let current = await waitOverview((snapshot) => snapshot.threads.length === 2);
    NodeAssert.equal(
      new Set(
        current.threads.map((row) => JSON.stringify([row.key.environmentId, row.key.threadId])),
      ).size,
      2,
    );
    NodeAssert.ok(
      current.environments.every((environment) =>
        environment.sourceAccess?.websocketRoute.startsWith("/factory/env/"),
      ),
    );
    NodeAssert.ok(
      current.environments.every((environment) =>
        environment.sourceAccess?.httpPrefix?.startsWith("/factory/env/"),
      ),
    );
    let lease = await connection.acquireSource(environmentId);
    leases.push(lease);
    let other = await connection.acquireSource(otherEnvironmentId);
    leases.push(other);
    const config = await lease.request((client) => client["server.getConfig"]({}));
    NodeAssert.equal(config.environment.environmentId, environmentId);
    NodeAssert.equal(config.environment.orchestrationProtocolVersion, 2);
    const provider = config.providers.find((provider) => provider.instanceId === "codex");
    NodeAssert.ok(provider);
    const options = resolveModelOptions(provider.models[0].capabilities?.optionDescriptors ?? [], {
      effort: "high",
      fast: true,
    });
    NodeAssert.deepEqual(options, [
      { id: "effort", value: "high" },
      { id: "fast", value: true },
    ]);
    const factoryId = connection.factoryId;
    NodeAssert.ok(factoryId);
    const detailKey = [
      ...threadDetailKey(factoryId, environmentId, "same-thread", lease.registrationId),
      "snapshot",
    ];
    const bounded = () => readThreadBoundedSnapshot(lease, "same-thread");
    let snapshot = await query.fetchQuery({ queryKey: detailKey, queryFn: bounded });
    NodeAssert.equal(snapshot.projection.thread.title, "Source A");
    const otherDetail = await query.fetchQuery({
      queryKey: [
        ...threadDetailKey(factoryId, otherEnvironmentId, "same-thread", other.registrationId),
        "snapshot",
      ],
      queryFn: () => readThreadBoundedSnapshot(other, "same-thread"),
    });
    NodeAssert.equal(otherDetail.projection.thread.title, "Source B");
    NodeAssert.equal(
      query.getQueryData<typeof snapshot>(detailKey)?.projection.thread.title,
      "Source A",
    );
    const listing = await readWorkspaceDirectory(lease, input.workspace, "");
    const dir = listing.entries.find((entry) => entry.path === "nested");
    NodeAssert.ok(dir);
    NodeAssert.deepEqual(selectWorkspaceEntry(dir, ""), { directoryPath: "nested" });
    const nested = await readWorkspaceDirectory(lease, input.workspace, "nested");
    NodeAssert.ok(nested.entries.some((entry) => entry.path === "nested/safe.txt"));
    NodeAssert.equal(
      (await readWorkspaceFile(lease, input.workspace, "nested/safe.txt")).contents,
      "native project-relative content",
    );
    await NodeAssert.rejects(readWorkspaceFile(lease, input.workspace, "../outside.txt"));
    const assetUrl = lease.resolveAssetUrl(input.assetPath);
    NodeAssert.equal(new URL(assetUrl, input.origin).origin, input.origin);
    const asset = await fetchFactory(assetUrl, { headers: { range: "bytes=2-5" } });
    NodeAssert.equal(asset.status, 206);
    NodeAssert.equal(await asset.text(), "2345");
    NodeAssert.throws(() => lease.resolveAssetUrl("https://source.invalid/api/assets/x"));
    NodeAssert.throws(() => lease.resolveAssetUrl("/api/assets/signed/%252e%252e/outside.png"));
    NodeAssert.throws(() => lease.resolveAssetUrl("/api/attachments/upload/grant/extra"));
    await NodeAssert.rejects(lease.readHttp("/api/auth/session", Schema.Unknown));
    const sourceAuth = await fetchFactory(
      `/factory/env/${current.environments.find((environment) => environment.environmentId === environmentId)!.registrationId}/api/auth/session?environmentId=${environmentId}`,
    );
    NodeAssert.equal(sourceAuth.status, 403);
    const forbiddenMethod = await fetchFactory(
      `/factory/env/${current.environments.find((environment) => environment.environmentId === environmentId)!.registrationId}/api/projects?environmentId=${environmentId}`,
      { method: "POST" },
    );
    NodeAssert.equal(forbiddenMethod.status, 403);
    const uploadBytes = new TextEncoder().encode("native attachment payload");
    const uploadGrant = await lease.request((client) =>
      client["attachments.createUploadUrl"]({
        type: "file",
        name: "native-upload.txt",
        mimeType: "text/plain",
        sizeBytes: uploadBytes.byteLength,
      }),
    );
    const uploadUrl = lease.resolveAssetUrl(uploadGrant.relativeUrl);
    const uploadResponse = await fetchFactory(uploadUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: uploadBytes,
    });
    NodeAssert.equal(uploadResponse.status, 204);
    const uploadedAsset = await lease.request((client) =>
      client["assets.createUrl"]({
        resource: {
          _tag: "attachment",
          attachmentId: uploadGrant.attachmentId,
          fileName: "native-upload.txt",
          mimeType: "text/plain",
        },
      }),
    );
    const uploadedUrl = lease.resolveAssetUrl(uploadedAsset.relativeUrl);
    const uploadedResponse = await fetchFactory(uploadedUrl);
    NodeAssert.equal(await uploadedResponse.text(), "native attachment payload");
    const diff = await lease.request((client) =>
      client["review.getDiffPreview"]({ cwd: input.workspace }),
    );
    NodeAssert.ok(JSON.stringify(diff).includes("changed by native gate"));
    const vcs = deferred<unknown>();
    const vcsLease = lease.acquireStream(
      "vcs",
      (client) => client["subscribeVcsStatus"]({ cwd: input.workspace }),
      (event) => {
        if (JSON.stringify(event).includes("tracked.txt")) vcs.resolve(event);
      },
    );
    NodeAssert.ok(JSON.stringify(await vcs.promise).includes("tracked.txt"));
    vcsLease.release();
    const terminal = deferred<unknown>();
    const terminalLease = lease.acquireStream(
      "terminal",
      (client) => client["terminal.attach"]({ threadId: "same-thread", terminalId: "default" }),
      (event) => terminal.resolve(event),
    );
    NodeAssert.ok(JSON.stringify(await terminal.promise).includes("snapshot"));
    terminalLease.release();
    const readOnly = makeConnection(input.readCookie);
    readOnly.start();
    try {
      const roOverview = readOnly.acquireStream(
        "readonly-overview",
        (client) => client["factory.overview.subscribe"]({}),
        () => {},
      );
      await waitReady(readOnly);
      const registrationA = current.environments.find(
        (environment) => environment.environmentId === environmentId,
      );
      const registrationB = current.environments.find(
        (environment) => environment.environmentId === otherEnvironmentId,
      );
      NodeAssert.ok(registrationA && registrationB);
      const routeThreadId = Schema.decodeUnknownSync(FactoryFrameTarget)({
        registrationId: registrationA.registrationId,
        environmentId: registrationA.environmentId,
        threadId: "same-thread",
      }).threadId;
      const routeA = await readOnly.request((client) =>
        client["factory.environments.getEmbeddedRoute"]({
          target: {
            registrationId: registrationA.registrationId,
            environmentId: registrationA.environmentId,
          },
          threadId: routeThreadId,
        }),
      );
      const routeB = await readOnly.request((client) =>
        client["factory.environments.getEmbeddedRoute"]({
          target: {
            registrationId: registrationB.registrationId,
            environmentId: registrationB.environmentId,
          },
          threadId: routeThreadId,
        }),
      );
      NodeAssert.equal(new URL(routeA.href, input.origin).origin, input.origin);
      NodeAssert.equal(new URL(routeB.href, input.origin).origin, input.origin);
      const targetA = Schema.decodeUnknownSync(FactoryFrameTarget)({
        ...routeA.target,
        threadId: routeA.threadId,
      });
      const targetB = Schema.decodeUnknownSync(FactoryFrameTarget)({
        ...routeB.target,
        threadId: routeB.threadId,
      });
      NodeAssert.equal(targetA.threadId, targetB.threadId);
      NodeAssert.notEqual(targetA.registrationId, targetB.registrationId);
      NodeAssert.notEqual(targetA.environmentId, targetB.environmentId);
      const ro = await readOnly.acquireSource(environmentId);
      const roOther = await readOnly.acquireSource(otherEnvironmentId);
      const roConfig = await ro.request((client) => client["server.getConfig"]({}));
      const roOtherConfig = await roOther.request((client) => client["server.getConfig"]({}));
      NodeAssert.equal(roConfig.environment.environmentId, targetA.environmentId);
      NodeAssert.equal(roConfig.environment.orchestrationProtocolVersion, 2);
      NodeAssert.equal(roOtherConfig.environment.environmentId, targetB.environmentId);
      NodeAssert.equal(roOtherConfig.environment.orchestrationProtocolVersion, 2);
      NodeAssert.equal(
        (await readThreadBoundedSnapshot(ro, targetA.threadId)).projection.thread.title,
        "Source A",
      );
      NodeAssert.equal(
        (await readThreadBoundedSnapshot(roOther, targetB.threadId)).projection.thread.title,
        "Source B",
      );

      let frameReadyCount = 0;
      const handshakeA = createFrameHandshake({
        expectedOrigin: input.origin,
        expectedTarget: targetA,
        timeoutMs: 25_000,
        onReady: () => {
          frameReadyCount++;
        },
        onError: (code) => {
          throw new Error(`Unexpected frame error: ${code}`);
        },
      });
      const parentInits: Array<{ message: unknown; targetOrigin: string }> = [];
      const sendInit = (message: unknown, targetOrigin: string) =>
        parentInits.push({ message, targetOrigin });
      handshakeA.onFrameLoad(sendInit);
      const readyA = Schema.decodeUnknownSync(FactoryFrameMessage)(
        await milestone("frame-init", {
          href: routeA.href,
          init: parentInits[0]?.message,
        }),
      );
      NodeAssert.equal(readyA._tag, "ready");
      NodeAssert.equal(parentInits[0]?.targetOrigin, input.origin);
      NodeAssert.equal(
        handshakeA.onMessage({
          origin: "https://invalid.example",
          sourceMatches: true,
          message: readyA,
        }),
        false,
      );
      NodeAssert.equal(
        handshakeA.onMessage({ origin: input.origin, sourceMatches: false, message: readyA }),
        false,
      );
      NodeAssert.equal(
        handshakeA.onMessage({
          origin: input.origin,
          sourceMatches: true,
          message: { ...readyA, version: 2 },
        }),
        false,
      );
      const readyB = Schema.decodeUnknownSync(FactoryFrameMessage)({
        _tag: "ready",
        version: 1,
        target: targetB,
      });
      NodeAssert.equal(
        handshakeA.onMessage({ origin: input.origin, sourceMatches: true, message: readyB }),
        false,
      );
      NodeAssert.equal(
        handshakeA.onMessage({ origin: input.origin, sourceMatches: true, message: readyA }),
        true,
      );
      NodeAssert.equal(frameReadyCount, 1);

      handshakeA.onFrameLoad(sendInit);
      NodeAssert.equal(parentInits.length, 2, "A reloaded child receives a fresh init");
      const reloadedReady = Schema.decodeUnknownSync(FactoryFrameMessage)(
        await milestone("frame-init", {
          href: routeA.href,
          init: parentInits[1]?.message,
        }),
      );
      NodeAssert.equal(
        handshakeA.onMessage({ origin: input.origin, sourceMatches: true, message: reloadedReady }),
        true,
      );
      NodeAssert.equal(frameReadyCount, 2);

      const staleHandshake = createFrameHandshake({
        expectedOrigin: input.origin,
        expectedTarget: targetA,
        timeoutMs: 25_000,
        onReady: () => {
          throw new Error("Cancelled frame became ready");
        },
        onError: (code) => {
          throw new Error(`Unexpected stale frame error: ${code}`);
        },
      });
      staleHandshake.onFrameLoad(() => {});
      staleHandshake.cancel();
      NodeAssert.equal(
        staleHandshake.onMessage({ origin: input.origin, sourceMatches: true, message: readyA }),
        false,
      );
      const switchedHandshake = createFrameHandshake({
        expectedOrigin: input.origin,
        expectedTarget: targetB,
        timeoutMs: 25_000,
        onReady: () => {},
        onError: (code) => {
          throw new Error(`Unexpected switched frame error: ${code}`);
        },
      });
      switchedHandshake.onFrameLoad(() => {});
      NodeAssert.equal(
        switchedHandshake.onMessage({ origin: input.origin, sourceMatches: true, message: readyA }),
        false,
      );
      const switchedReady = Schema.decodeUnknownSync(FactoryFrameMessage)(
        await milestone("frame-init", {
          href: routeB.href,
          init: { _tag: "init", version: 1, target: targetB },
        }),
      );
      NodeAssert.equal(
        switchedHandshake.onMessage({
          origin: input.origin,
          sourceMatches: true,
          message: switchedReady,
        }),
        true,
      );

      const mismatch = Schema.decodeUnknownSync(FactoryFrameMessage)(
        await milestone("frame-target-mismatch", {
          href: routeA.href,
          init: parentInits[0]?.message,
          activeTarget: targetB,
        }),
      );
      NodeAssert.equal(mismatch._tag, "error");
      NodeAssert.equal(mismatch._tag === "error" ? mismatch.code : undefined, "target-mismatch");
      let frameError: string | undefined;
      const errorHandshake = createFrameHandshake({
        expectedOrigin: input.origin,
        expectedTarget: targetA,
        timeoutMs: 25_000,
        onReady: () => {
          throw new Error("Error frame became ready");
        },
        onError: (code) => {
          frameError = code;
        },
      });
      errorHandshake.onFrameLoad(() => {});
      const protocolError = Schema.decodeUnknownSync(FactoryFrameMessage)(
        await milestone("frame-error", {
          href: routeA.href,
          init: parentInits[0]?.message,
          target: targetA,
          code: "source-protocol",
        }),
      );
      NodeAssert.equal(
        errorHandshake.onMessage({
          origin: input.origin,
          sourceMatches: true,
          message: protocolError,
        }),
        true,
      );
      NodeAssert.equal(frameError, "source-protocol");

      NodeAssert.deepEqual(await ro.observeControl("message.dispatch"), {
        allowed: false,
        reason: "scope-required",
      });
      await NodeAssert.rejects(
        ro.request((client) =>
          client["orchestration.dispatchCommand"](
            decodeCommand({
              type: "thread.settle",
              commandId: "readonly-denied",
              threadId: "same-thread",
            }),
          ),
        ),
      );
      ro.release();
      roOther.release();
      roOverview.release();
    } finally {
      await readOnly.stop();
    }
    const registration = current.environments.find(
      (environment) => environment.environmentId === environmentId,
    );
    NodeAssert.ok(registration);
    await connection.request((client) =>
      client["factory.environments.update"]({
        registrationId: registration.registrationId,
        revision: registration.revision,
        label: "Edited source",
      }),
    );
    current = await waitOverview((snapshot) =>
      snapshot.environments.some((environment) => environment.label === "Edited source"),
    );
    NodeAssert.equal(
      new Set(
        current.threads.map((row) => JSON.stringify([row.key.environmentId, row.key.threadId])),
      ).size,
      current.threads.length,
    );
    const scope = {
      type: "thread" as const,
      factoryId: connection.factoryId!,
      environmentId,
      threadId: "same-thread",
    };
    const record = (id: string) =>
      connection.actions
        .records(sourceActionScopeKey(scope))
        .find((action) => action.commandId === id);
    const readFresh = async () => {
      snapshot = await query.fetchQuery({ queryKey: detailKey, staleTime: 0, queryFn: bounded });
      current = await waitOverview((state) =>
        state.threads.some(
          (thread) =>
            thread.key.environmentId === environmentId &&
            thread.key.threadId === "same-thread" &&
            DateTime.toEpochMillis(thread.updatedAt) >=
              DateTime.toEpochMillis(snapshot.projection.updatedAt),
        ),
      );
      const thread = current.threads.find(
        (thread) =>
          thread.key.environmentId === environmentId && thread.key.threadId === "same-thread",
      );
      NodeAssert.ok(thread);
      connection.actions.reconcile(scope, threadActionObservation(snapshot, thread));
      return snapshot;
    };
    const dispatch = async (command: SourceDispatchCommand, intent: SourceActionIntent) => {
      const admission = await lease.observeControl(
        Schema.decodeUnknownSync(FactoryControlOperation)(command.type),
      );
      NodeAssert.equal(admission.allowed, true);
      return dispatchSourceCommand({
        registry: connection.actions,
        scope,
        lease,
        state: {
          online: lease.status.phase === "online",
          synchronized: true,
          allowed: admission.allowed,
        },
        command,
        intent,
        baseSequence: snapshot.snapshotSequence,
        support: { providers: config.providers, projection: snapshot.projection },
      });
    };
    await dispatch(
      decodeCommand({ type: "thread.settle", commandId: "native-settle", threadId: "same-thread" }),
      { kind: "settle", previousSettled: false },
    );
    NodeAssert.equal(record("native-settle")?.phase, "accepted");
    await readFresh();
    NodeAssert.equal(record("native-settle")?.phase, "confirmed");
    await dispatch(
      decodeCommand({
        type: "thread.unsettle",
        reason: "user",
        commandId: "native-unsettle",
        threadId: "same-thread",
      }),
      { kind: "unsettle", previousSettled: true },
    );
    await readFresh();
    NodeAssert.equal(record("native-unsettle")?.phase, "confirmed");
    const launchScope = {
      type: "launch" as const,
      factoryId: scope.factoryId,
      environmentId,
      projectId: "same-project",
    };
    const launch = decodeLaunch({
      commandId: "native-launch",
      threadId: "launched-thread",
      projectId: "same-project",
      title: "Launched",
      generateTitle: false,
      modelSelection: { instanceId: "codex", model: "controlled-model", options },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    });
    const launchThreadId = launch.threadId;
    NodeAssert.ok(launchThreadId);
    const launched = await connection.actions.dispatch({
      scope: launchScope,
      commandId: "native-launch",
      intent: {
        kind: "launch",
        target: { environmentId: config.environment.environmentId, threadId: launchThreadId },
      },
      baseSequence: snapshot.snapshotSequence,
      state: {
        online: true,
        synchronized: true,
        allowed: (await lease.observeControl("launch")).allowed,
      },
      request: () => lease.request((client) => client["orchestration.launchThread"](launch)),
    });
    NodeAssert.equal(launched.threadId, "launched-thread");
    NodeAssert.equal(
      connection.actions.records(sourceActionScopeKey(launchScope))[0].phase,
      "accepted",
    );
    const launchOverview = await waitOverview((snapshot) =>
      snapshot.threads.some((thread) => thread.key.threadId === "launched-thread"),
    );
    connection.actions.reconcile(launchScope, {
      type: "overview",
      threadKeys: new Set(
        launchOverview.threads.map((thread) =>
          JSON.stringify([thread.key.environmentId, thread.key.threadId]),
        ),
      ),
    });
    NodeAssert.equal(
      connection.actions.records(sourceActionScopeKey(launchScope))[0].phase,
      "confirmed",
    );
    const repeated = await lease.request((client) => client["orchestration.launchThread"](launch));
    NodeAssert.equal(repeated.threadId, launched.threadId);
    NodeAssert.equal(repeated.projection.thread.id, launched.projection.thread.id);
    const launchedSnapshot = await readThreadBoundedSnapshot(lease, "launched-thread");
    NodeAssert.deepEqual(launchedSnapshot.projection.thread.modelSelection.options, options);
    const prompt = decodeCommand({
      type: "message.dispatch",
      commandId: "dropped-prompt",
      threadId: "same-thread",
      messageId: "original-message",
      text: "hold native prompt",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    });
    // Fault injection drops a real native Exit after source commit; no fake RPC success is generated.
    NodeAssert.equal((await lease.observeControl("message.dispatch")).allowed, true);
    dropNextNativeExit = true;
    await NodeAssert.rejects(
      dispatchSourceCommand({
        registry: connection.actions,
        scope,
        lease,
        state: { online: true, synchronized: true, allowed: true },
        command: prompt,
        intent: { kind: "prompt", messageId: "original-message" },
        baseSequence: snapshot.snapshotSequence,
      }),
      SourceCommandUncertainError,
    );
    NodeAssert.equal(dropped, 1);
    NodeAssert.equal(record("dropped-prompt")?.phase, "uncertain");
    lease.release();
    lease = await connection.acquireSource(environmentId);
    leases.push(lease);
    const beforeGuard = requests.filter((request) => request.commandId).length;
    await NodeAssert.rejects(
      dispatch(
        decodeCommand({ ...prompt, commandId: "new-id-forbidden", messageId: "duplicate-message" }),
        { kind: "prompt", messageId: "duplicate-message" },
      ),
      SourceCommandUncertainError,
    );
    query.removeQueries({
      queryKey: threadDetailKey(factoryId, environmentId, "same-thread", lease.registrationId),
    });
    NodeAssert.equal(query.getQueryData(detailKey), undefined);
    query.clear();
    query = makeQuery();
    connection.retry();
    await waitReady(connection);
    lease = await connection.acquireSource(environmentId);
    leases.push(lease);
    current = await waitOverview((snapshot) => snapshot.threads.length === 3);
    NodeAssert.equal(
      new Set(
        current.threads.map((row) => JSON.stringify([row.key.environmentId, row.key.threadId])),
      ).size,
      current.threads.length,
    );
    NodeAssert.equal(
      current.environments.find((environment) => environment.environmentId === environmentId)
        ?.label,
      "Edited source",
    );
    NodeAssert.equal(
      record("dropped-prompt")?.phase,
      "uncertain",
      "Guard survives tab/lease/query/connection replacement",
    );
    NodeAssert.equal(requests.filter((request) => request.commandId).length, beforeGuard);
    NodeAssert.ok(
      !requests.some(
        (request) => request.method === "terminal.open" || request.method === "terminal.write",
      ),
    );
    await milestone("drain");
    await readFresh();
    NodeAssert.equal(record("dropped-prompt")?.phase, "confirmed");
    await dispatch(
      decodeCommand({
        type: "message.dispatch",
        commandId: "native-held-message",
        threadId: "same-thread",
        messageId: "held-message",
        text: "complete released queue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      }),
      { kind: "prompt", messageId: "held-message" },
    );
    const active = snapshot.projection.runs.find((run) => run.status === "running");
    NodeAssert.ok(active);
    await dispatch(
      decodeCommand({
        type: "run.interrupt",
        commandId: "native-interrupt",
        threadId: "same-thread",
        runId: active.id,
        holdQueue: true,
      }),
      { kind: "interrupt", runId: active.id },
    );
    NodeAssert.equal(record("native-interrupt")?.phase, "accepted");
    await milestone("drain");
    await readFresh();
    NodeAssert.equal(record("native-interrupt")?.phase, "confirmed");
    const held = snapshot.projection.runs.filter((run) => run.status === "queued" && run.queueHeld);
    NodeAssert.equal(held.length, 1);
    await dispatch(
      decodeCommand({ type: "queue.resume", commandId: "native-queue", threadId: "same-thread" }),
      { kind: "resume", heldRunIds: held.map((run) => run.id) },
    );
    await milestone("drain");
    await readFresh();
    NodeAssert.equal(record("native-queue")?.phase, "confirmed");
    await milestone("seed-question");
    await readFresh();
    const details = snapshot.projection.visibleTurnItems.flatMap(({ item }) =>
      item.type === "user_input_request" || item.type === "approval_request" ? [item] : [],
    );
    const question = describeRuntimeRequests(snapshot.projection.runtimeRequests, details).find(
      (view) => view.request.id === "native-question",
    );
    NodeAssert.ok(question?.actionable && question.detail);
    const prepared = prepareUserInputAnswers(question.detail, {
      color: "blue",
      note: "typed answer",
    });
    NodeAssert.ok(prepared.ok);
    const response = makeRuntimeRequestResponse({
      commandId: decodeCommand({
        type: "thread.settle",
        commandId: "native-answer",
        threadId: "same-thread",
      }).commandId,
      threadId: snapshot.projection.thread.id,
      requestId: question.request.id,
      answers: prepared.answers,
    });
    await dispatch(response, { kind: "runtime-response", requestId: question.request.id });
    await milestone("drain");
    await readFresh();
    NodeAssert.equal(record("native-answer")?.phase, "confirmed");
    NodeAssert.deepEqual(
      snapshot.projection.runtimeRequests.find((request) => request.id === "native-question")
        ?.answers,
      { color: "blue", note: "typed answer" },
    );
    NodeAssert.ok(
      snapshot.projection.providerTurns.some(
        (turn) => turn.status === "completed" && turn.tokenUsage === undefined,
      ),
    );
    const checkpoint = snapshot.projection.checkpoints.find(
      (checkpoint) => checkpoint.status === "ready",
    );
    NodeAssert.ok(checkpoint);
    NodeAssert.ok(
      checkpoint.ref?.startsWith("refs/"),
      "Checkpoint refs are native, separate from IDs",
    );
    NodeAssert.notEqual(checkpoint.ref, checkpoint.id);
    NodeAssert.equal(
      rollbackUnavailableReason({ providers: config.providers, projection: snapshot.projection }),
      undefined,
    );
    const rollbackCommand = decodeCommand({
      type: "checkpoint.rollback",
      commandId: "native-rollback",
      threadId: "same-thread",
      checkpointId: checkpoint.id,
      scopeId: checkpoint.scopeId,
      restoreFiles: false,
    });
    const acceptedRollback = await dispatch(rollbackCommand, {
      kind: "rollback",
      checkpointId: checkpoint.id,
      previousStatus: current.threads.find(
        (thread) =>
          thread.key.environmentId === environmentId && thread.key.threadId === "same-thread",
      )!.sourceStatus,
    });
    const duplicateRollback = await lease.request((client) =>
      client["orchestration.dispatchCommand"](rollbackCommand),
    );
    NodeAssert.equal(
      duplicateRollback.sequence,
      acceptedRollback.sequence,
      "Duplicate rollback IDs reuse the native receipt",
    );
    NodeAssert.equal(record("native-rollback")?.phase, "accepted");
    await milestone("rollback-start");
    await readFresh();
    NodeAssert.equal(snapshot.projection.thread.rollbackRequestId, "native-rollback");
    NodeAssert.equal(snapshot.projection.thread.rollbackCompletedRequestId, undefined);
    NodeAssert.equal(record("native-rollback")?.phase, "accepted");
    await milestone("rollback-unrelated-update");
    await readFresh();
    NodeAssert.equal(
      record("native-rollback")?.phase,
      "accepted",
      "Unrelated provider updates cannot confirm rollback",
    );
    await milestone("drain");
    await readFresh();
    NodeAssert.equal(snapshot.projection.thread.rollbackCompletedRequestId, "native-rollback");
    NodeAssert.equal(record("native-rollback")?.phase, "confirmed");
    const repeatedRollback = await lease.request((client) =>
      client["orchestration.dispatchCommand"](rollbackCommand),
    );
    NodeAssert.equal(repeatedRollback.sequence, acceptedRollback.sequence);
    await readFresh();
    NodeAssert.equal(snapshot.projection.thread.rollbackCompletedRequestId, "native-rollback");
    other = await connection.acquireSource(otherEnvironmentId);
    leases.push(other);
    const unsupported = await readThreadBoundedSnapshot(other, "same-thread");
    const unsupportedConfig = await other.request((client) => client["server.getConfig"]({}));
    NodeAssert.ok(
      rollbackUnavailableReason({
        providers: unsupportedConfig.providers,
        projection: unsupported.projection,
      }),
    );
    const unsupportedCheckpoint = unsupported.projection.checkpoints.find(
      (checkpoint) => checkpoint.status === "ready",
    );
    NodeAssert.ok(unsupportedCheckpoint);
    const unsupportedCommand = decodeCommand({
      type: "checkpoint.rollback",
      commandId: "unsupported-rollback",
      threadId: "same-thread",
      checkpointId: unsupportedCheckpoint.id,
      scopeId: unsupportedCheckpoint.scopeId,
      restoreFiles: false,
    });
    const beforeUnsupported = requests.length;
    await NodeAssert.rejects(
      dispatchSourceCommand({
        registry: connection.actions,
        scope: { ...scope, environmentId: otherEnvironmentId },
        lease: other,
        state: { online: true, synchronized: true, allowed: true },
        command: unsupportedCommand,
        intent: {
          kind: "rollback",
          checkpointId: unsupportedCheckpoint.id,
          previousStatus: "completed",
        },
        baseSequence: unsupported.snapshotSequence,
        support: { providers: unsupportedConfig.providers, projection: unsupported.projection },
      }),
      SourceCommandUnavailableError,
    );
    NodeAssert.equal(requests.length, beforeUnsupported, "UI capability rejection sends no RPC");
    NodeAssert.deepEqual(await other.observeControl("checkpoint.rollback"), { allowed: true });
    await NodeAssert.rejects(
      other.request((client) => client["orchestration.dispatchCommand"](unsupportedCommand)),
      { _tag: "OrchestrationV2DispatchCommandError", commandId: "unsupported-rollback" },
    );
    if (snapshot.historyCursor) {
      const history = await readThreadHistoryPage(lease, "same-thread", snapshot.historyCursor);
      NodeAssert.equal(typeof history.hasMoreHistory, "boolean");
    } else {
      const cursor = await milestone("history");
      NodeAssert.equal(typeof cursor, "string");
      const history = await readThreadHistoryPage(lease, "same-thread", String(cursor));
      NodeAssert.equal(typeof history.hasMoreHistory, "boolean");
    }
    await milestone("restrict-source");
    NodeAssert.deepEqual(await lease.observeControl("message.dispatch"), {
      allowed: false,
      reason: "source-scope-required",
    });
    await NodeAssert.rejects(
      lease.request((client) =>
        client["terminal.write"]({
          threadId: "same-thread",
          terminalId: "default",
          data: "must-not-write",
        }),
      ),
    );
    await milestone("disable-source");
    NodeAssert.deepEqual(await lease.observeControl("message.dispatch"), {
      allowed: false,
      reason: "source-unavailable",
    });
    await NodeAssert.rejects(
      lease.request((client) =>
        client["orchestration.dispatchCommand"](
          decodeCommand({
            type: "thread.settle",
            commandId: "disabled-denied",
            threadId: "same-thread",
          }),
        ),
      ),
    );
    const disconnectedTarget = Schema.decodeUnknownSync(FactoryFrameTarget)({
      registrationId: current.environments.find(
        (environment) => environment.environmentId === environmentId,
      )!.registrationId,
      environmentId,
      threadId: "same-thread",
    });
    const disconnected = Schema.decodeUnknownSync(FactoryFrameMessage)(
      await milestone("frame-disconnected", { target: disconnectedTarget }),
    );
    NodeAssert.equal(disconnected._tag, "error");
    NodeAssert.equal(
      disconnected._tag === "error" ? disconnected.code : undefined,
      "source-unavailable",
    );
    let disconnectError: string | undefined;
    const disconnectedHandshake = createFrameHandshake({
      expectedOrigin: input.origin,
      expectedTarget: disconnectedTarget,
      timeoutMs: 25_000,
      onReady: () => {
        throw new Error("Disconnected source became ready");
      },
      onError: (code) => {
        disconnectError = code;
      },
    });
    disconnectedHandshake.onFrameLoad(() => {});
    NodeAssert.equal(
      disconnectedHandshake.onMessage({
        origin: input.origin,
        sourceMatches: true,
        message: disconnected,
      }),
      true,
    );
    NodeAssert.equal(disconnectError, "source-unavailable");

    const pendingReplacement = createFrameHandshake({
      expectedOrigin: input.origin,
      expectedTarget: disconnectedTarget,
      timeoutMs: 25_000,
      onReady: () => {
        throw new Error("Replaced factory connection accepted a stale child");
      },
      onError: (code) => {
        throw new Error(`Unexpected replacement error: ${code}`);
      },
    });
    pendingReplacement.onFrameLoad(() => {});
    pendingReplacement.cancel();
    await connection.stop();
    const replacement = makeConnection(input.readCookie);
    let replacementOverview: FactoryOverviewSnapshot | undefined;
    const replacementReady = deferred<FactoryOverviewSnapshot>();
    const replacementStream = replacement.acquireStream(
      "phase3-factory-replacement",
      (client) => client["factory.overview.subscribe"]({}),
      (event) => {
        const result = applyOverviewEvent(replacementOverview, event);
        NodeAssert.notEqual(result.kind, "reset-required");
        if (result.kind === "applied") {
          replacementOverview = result.value;
          replacementReady.resolve(result.value);
        }
      },
    );
    replacement.start();
    try {
      const replacedSnapshot = await replacementReady.promise;
      NodeAssert.ok(
        replacedSnapshot.environments.some(
          (environment) => environment.environmentId === otherEnvironmentId,
        ),
      );
      const replacementEnvironment = replacedSnapshot.environments.find(
        (environment) => environment.environmentId === otherEnvironmentId,
      );
      NodeAssert.ok(replacementEnvironment);
      const replacementThreadId = Schema.decodeUnknownSync(FactoryFrameTarget)({
        registrationId: replacementEnvironment.registrationId,
        environmentId: replacementEnvironment.environmentId,
        threadId: "same-thread",
      }).threadId;
      const replacementRoute = await replacement.request((client) =>
        client["factory.environments.getEmbeddedRoute"]({
          target: {
            registrationId: replacementEnvironment.registrationId,
            environmentId: replacementEnvironment.environmentId,
          },
          threadId: replacementThreadId,
        }),
      );
      NodeAssert.equal(new URL(replacementRoute.href, input.origin).origin, input.origin);
      NodeAssert.equal(
        replacementRoute.target.registrationId,
        replacementEnvironment.registrationId,
      );
      const staleReady = Schema.decodeUnknownSync(FactoryFrameMessage)({
        _tag: "ready",
        version: 1,
        target: disconnectedTarget,
      });
      NodeAssert.equal(
        pendingReplacement.onMessage({
          origin: input.origin,
          sourceMatches: true,
          message: staleReady,
        }),
        false,
      );
    } finally {
      replacementStream.release();
      await replacement.stop();
    }
    NodeAssert.ok(requests.every((request) => request.origin === input.origin));
    NodeAssert.equal(
      requests.filter((request) => request.commandId === "dropped-prompt").length,
      1,
    );
    NodeAssert.ok(
      !requests.some(
        (request) =>
          request.commandId === "new-id-forbidden" ||
          request.method === "terminal.open" ||
          request.method === "terminal.write",
      ),
    );
    await milestone("audit", { requests, dropped });
  } catch (error) {
    console.error("GATE_FAILURE", error);
    throw error;
  } finally {
    for (const lease of leases) lease.release();
    stream.release();
    await connection.stop();
    query.clear();
    lines.close();
  }
}

function decodeCommand(value: unknown): SourceDispatchCommand {
  const rpc = [...WsRpcGroup.requests.values()].find(
    (rpc) => rpc._tag === "orchestration.dispatchCommand",
  );
  NodeAssert.ok(rpc);
  return Schema.decodeUnknownSync(Schema.toCodecJson(rpc.payloadSchema))(value);
}
function decodeLaunch(value: unknown) {
  const rpc = [...WsRpcGroup.requests.values()].find(
    (rpc) => rpc._tag === "orchestration.launchThread",
  );
  NodeAssert.ok(rpc);
  return Schema.decodeUnknownSync(Schema.toCodecJson(rpc.payloadSchema))(value);
}
export function productionGateInput(value: string): ProductionGateInput {
  return Schema.decodeUnknownSync(Input)(JSON.parse(value));
}

function waitReady(connection: FactoryConnection): Promise<void> {
  if (connection.status.phase === "online") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const off = connection.subscribeStatus((status) => {
      if (status.phase === "online") {
        off();
        resolve();
      } else if (
        status.phase === "blocked" ||
        status.phase === "unauthenticated" ||
        status.phase === "offline"
      ) {
        off();
        reject(new Error(`Factory gate connection ${status.phase}: ${status.reason}`));
      }
    });
  });
}
