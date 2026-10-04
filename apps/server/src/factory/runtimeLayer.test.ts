import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import { FactoryRuntime, layer } from "./runtimeLayer.ts";
import {
  AuthSessionId,
  EnvironmentId,
  FactoryEnvironmentView,
  FactoryRegistrationId,
  OrchestrationV2ShellStreamItem,
  ServerConfig as importedServerConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as CredentialStore from "./CredentialStore.ts";
import * as Metadata from "./Metadata.ts";
import * as FakeSource from "./testkit/FakeSource.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSource from "./NodeSource.ts";
import * as FakeSocket from "./testkit/FakeSocket.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Connections from "./Connections.ts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { config as sourceConfig } from "./testkit/sourceConfig.ts";

const encodeShellStreamItem = Schema.encodeEffect(OrchestrationV2ShellStreamItem);

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-runtime-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
)("factory runtime", (it) => {
  it.effect(
    "runs the production HTTP, socket, protocol, and config path from runtime startup",
    () =>
      Effect.gen(function* () {
        const base = yield* ServerConfig.ServerConfig;
        const configLayer = ServerConfig.layer({
          ...base,
          factoryEnabled: true,
          factoryCredentialStore: "protected-file",
        });
        const dependencies = yield* Layer.build(
          Layer.mergeAll(
            Metadata.layer,
            CredentialStore.layer.pipe(Layer.provide(CredentialStore.keyringLayer)),
          ).pipe(Layer.provide(configLayer)),
        );
        const metadata = Context.get(dependencies, Metadata.Metadata);
        const store = Context.get(dependencies, CredentialStore.CredentialStore);
        const now = yield* DateTime.now;
        const registrationId = FactoryRegistrationId.make("node-source");
        yield* metadata.createEnvironment(
          FactoryEnvironmentView.make({
            registrationId,
            environmentId: EnvironmentId.make("node-env"),
            endpoint: "https://source.example",
            label: "Node Source",
            platform: null,
            enabled: false,
            state: "pending",
            credentialStorage: null,
            credentialExpiresAt: null,
            cleanupPending: false,
            renewal: "unsupported",
            lastSeenAt: null,
            revision: 0,
          }),
        );
        yield* store.set("node-source", {
          token: "durable-node-token",
          sourceSessionId: AuthSessionId.make("node-session"),
          scopes: ["orchestration:read"],
          issuedAt: now,
          expiresAt: DateTime.add(now, { days: 30 }),
        });
        yield* metadata.markEnrollment({
          registrationId,
          credentialStorage: "protected-file",
          credentialItemKey: "node-source",
          credentialExpiresAt: null,
        });
        const socket = yield* FakeSocket.make;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("https://source.example/api/auth/websocket-ticket");
            expect(request.headers.authorization).toBe("Bearer durable-node-token");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ ticket: "runtime-ticket", expiresAt: "2099-01-01T00:00:00Z" }),
            );
          }),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const services = yield* Layer.buildWithScope(
          layer({
            sourceTransportLayer: NodeSource.layer.pipe(
              Layer.provide(Layer.merge(socket.layer, Layer.succeed(HttpClient.HttpClient, http))),
            ),
          }).pipe(Layer.provide(configLayer)),
          scope,
        );
        const runtime = Context.get(services, FactoryRuntime);
        const connections = yield* runtime.getConnections;
        const sourceShell = yield* runtime.getSourceShell;
        const shellUpdates = yield* Stream.toQueue(sourceShell.subscribe, { capacity: 16 });
        yield* Queue.take(shellUpdates);
        const states = yield* Stream.toQueue(connections.subscribeStates, { capacity: 16 });
        const upstream = yield* Queue.take(socket.sockets);
        const frame = yield* Queue.take(socket.frames);
        expect(frame).toMatchObject({ _tag: "Request", tag: "subscribeServerConfig", payload: {} });
        upstream.message({
          _tag: "Chunk",
          requestId: frame.id,
          values: [
            {
              version: 1,
              type: "snapshot",
              config: yield* Schema.encodeEffect(importedServerConfig)(sourceConfig("node-env")),
            },
          ],
        });
        const online = yield* Stream.fromQueue(states).pipe(
          Stream.flatMap((snapshot) => Stream.fromIterable(snapshot)),
          Stream.filter(
            (state) => state.target.registrationId === registrationId && state.phase === "online",
          ),
          Stream.runHead,
        );
        expect(online).toMatchObject({
          _tag: "Some",
          value: { target: { environmentId: "node-env" } },
        });
        const shellFrame = yield* Stream.fromQueue(socket.frames).pipe(
          Stream.filter(
            (message) =>
              message._tag === "Request" && message.tag === "orchestration.subscribeShell",
          ),
          Stream.runHead,
        );
        expect(shellFrame._tag).toBe("Some");
        const shellRequest = Option.getOrThrow(shellFrame);
        upstream.message({
          _tag: "Chunk",
          requestId: shellRequest.id,
          values: [
            yield* encodeShellStreamItem({
              kind: "snapshot",
              snapshot: {
                schemaVersion: 1,
                snapshotSequence: 4,
                projects: [],
                threads: [],
                archivedThreads: [],
              },
            }),
          ],
        });
        const applied = yield* Stream.fromQueue(shellUpdates).pipe(
          Stream.filter((update) => update.kind === "frame" && update.frame.kind === "snapshot"),
          Stream.runHead,
        );
        expect(applied).toMatchObject({
          _tag: "Some",
          value: { frame: { target: { environmentId: "node-env" }, sequence: 4 } },
        });
        expect(yield* sourceShell.getStates).toMatchObject([
          { target: { environmentId: "node-env" }, appliedCursor: 4, projects: [], threads: [] },
        ]);
        yield* Scope.close(scope, Exit.void);
        yield* socket.closed;
        const current = (yield* metadata.listEnvironments).find(
          (entry) => entry.registrationId === registrationId,
        )!;
        yield* metadata.updateEnvironment({
          registrationId,
          revision: current.revision,
          enabled: false,
        });
      }),
  );
  it.effect(
    "keeps healthy source supervision available when one pending credential cannot be read",
    () =>
      Effect.gen(function* () {
        const base = yield* ServerConfig.ServerConfig;
        const configLayer = ServerConfig.layer({
          ...base,
          factoryEnabled: true,
          factoryCredentialStore: "protected-file",
        });
        const dependencies = yield* Layer.build(
          Layer.mergeAll(
            Metadata.layer,
            CredentialStore.layer.pipe(Layer.provide(CredentialStore.keyringLayer)),
          ).pipe(Layer.provide(configLayer)),
        );
        const metadata = Context.get(dependencies, Metadata.Metadata);
        const store = Context.get(dependencies, CredentialStore.CredentialStore);
        const now = yield* DateTime.now;
        const row = (id: string, label: string) =>
          FactoryEnvironmentView.make({
            registrationId: FactoryRegistrationId.make(id),
            environmentId: EnvironmentId.make(id),
            endpoint: "https://source.example",
            label,
            platform: null,
            enabled: false,
            state: "pending",
            credentialStorage: null,
            credentialExpiresAt: null,
            cleanupPending: false,
            renewal: "unsupported",
            lastSeenAt: null,
            revision: 0,
          });
        const broken = yield* metadata.createEnvironment(row("broken-pending", "Broken pending"));
        yield* metadata.markPendingEnrollment({
          registrationId: broken.registrationId,
          credentialStorage: "protected-file",
          credentialItemKey: "broken-pending",
        });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(base.secretsDir, "factory-credentials", "broken-pending.json"),
          "{}",
        );
        const healthy = yield* metadata.createEnvironment(row("healthy-vault-source", "Healthy"));
        yield* store.set("healthy-vault-source", {
          token: "healthy-token",
          sourceSessionId: AuthSessionId.make("healthy"),
          scopes: ["orchestration:read"],
          issuedAt: now,
          expiresAt: DateTime.add(now, { days: 30 }),
        });
        yield* metadata.markEnrollment({
          registrationId: healthy.registrationId,
          credentialStorage: "protected-file",
          credentialItemKey: "healthy-vault-source",
          credentialExpiresAt: null,
        });
        const fake = yield* FakeSource.make;
        const services = yield* Layer.build(
          layer({ sourceTransportLayer: fake.layer }).pipe(Layer.provide(configLayer)),
        );
        const runtime = Context.get(services, FactoryRuntime);
        expect(runtime.enabled).toBe(true);
        const attempt = yield* Queue.take(fake.attempts);
        expect(attempt.input.environment.registrationId).toBe("healthy-vault-source");
        const connections = yield* runtime.getConnections;
        yield* connections.disable(healthy.registrationId);
        yield* attempt.closed;
        expect(
          (yield* metadata.listEnvironments).find(
            (entry) => entry.registrationId === broken.registrationId,
          )?.state,
        ).toBe("pending");
        const enrollment = yield* runtime.getEnrollment;
        const pending = (yield* metadata.listEnvironments).find(
          (entry) => entry.registrationId === broken.registrationId,
        )!;
        yield* enrollment.remove({
          registrationId: pending.registrationId,
          revision: pending.revision,
        });
      }),
  );
  it.effect("does not start outbound connections when disabled", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      let transportBuilds = 0;
      const services = yield* Layer.build(
        layer({
          sourceTransportLayer: Layer.effect(
            Connections.SourceTransport,
            Effect.sync(() => {
              transportBuilds++;
              return Connections.SourceTransport.of({
                connect: () => Effect.die("A disabled factory cannot connect."),
              });
            }),
          ),
        }).pipe(Layer.provide(ServerConfig.layer({ ...config, factoryEnabled: false }))),
      );
      const factory = Context.get(services, FactoryRuntime);
      expect(factory.enabled).toBe(false);
      expect(yield* Effect.flip(factory.getMetadata)).toMatchObject({ code: "feature-disabled" });
      expect(yield* Effect.flip(factory.getConnections)).toMatchObject({
        code: "feature-disabled",
      });
      expect(yield* Effect.flip(factory.getSourceShell)).toMatchObject({
        code: "feature-disabled",
      });
      expect(yield* Effect.flip(factory.getOverview)).toMatchObject({
        code: "feature-disabled",
      });
      expect(yield* Effect.flip(factory.getRelayPolicy)).toMatchObject({
        code: "feature-disabled",
      });
      expect(yield* Effect.flip(factory.getRelay)).toMatchObject({ code: "feature-disabled" });
      expect(transportBuilds).toBe(0);
    }),
  );

  it.effect("starts the enabled runtime and exposes persistent metadata", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fake = yield* FakeSource.make;
      const services = yield* Layer.build(
        layer({ sourceTransportLayer: fake.layer }).pipe(
          Layer.provide(ServerConfig.layer({ ...config, factoryEnabled: true })),
        ),
      );
      const factory = Context.get(services, FactoryRuntime);
      const metadata = yield* factory.getMetadata;
      expect(factory.enabled).toBe(true);
      expect(typeof metadata.createGroup).toBe("function");
      expect(yield* factory.getConnections).toBeDefined();
      expect(yield* factory.getSourceShell).toBeDefined();
      const overview = yield* factory.getOverview;
      expect(yield* factory.getRelayPolicy).toBeDefined();
      const snapshot = yield* overview.getSnapshot;
      expect(snapshot.projects).toEqual([]);
      expect(snapshot.threads).toEqual([]);
      expect(fake.calls).toHaveLength(0);
    }),
  );

  it.effect(
    "starts real supervision for saved registrations and uses the latest durable credential",
    () =>
      Effect.gen(function* () {
        const base = yield* ServerConfig.ServerConfig;
        const configLayer = ServerConfig.layer({
          ...base,
          factoryEnabled: true,
          factoryCredentialStore: "protected-file",
        });
        const dependencies = yield* Layer.build(
          Layer.mergeAll(
            Metadata.layer,
            CredentialStore.layer.pipe(Layer.provide(CredentialStore.keyringLayer)),
          ).pipe(Layer.provide(configLayer)),
        );
        const metadata = Context.get(dependencies, Metadata.Metadata);
        const credentials = Context.get(dependencies, CredentialStore.CredentialStore);
        const now = yield* DateTime.now;
        const registrationId = FactoryRegistrationId.make("runtime-source");
        yield* metadata.createEnvironment(
          FactoryEnvironmentView.make({
            registrationId,
            environmentId: EnvironmentId.make("source-env"),
            endpoint: "https://source.example",
            label: "Source",
            platform: null,
            enabled: false,
            state: "pending",
            credentialStorage: null,
            credentialExpiresAt: null,
            cleanupPending: false,
            renewal: "unsupported",
            lastSeenAt: null,
            revision: 0,
          }),
        );
        yield* credentials.set("runtime-source", {
          token: "latest-durable-token",
          sourceSessionId: AuthSessionId.make("replacement"),
          scopes: ["orchestration:read"],
          issuedAt: now,
          expiresAt: DateTime.add(now, { days: 30 }),
        });
        yield* metadata.markEnrollment({
          registrationId,
          credentialStorage: "protected-file",
          credentialItemKey: "runtime-source",
          credentialExpiresAt: null,
        });
        const fake = yield* FakeSource.make;
        const services = yield* Layer.build(
          layer({ sourceTransportLayer: fake.layer }).pipe(Layer.provide(configLayer)),
        );
        const runtime = Context.get(services, FactoryRuntime);
        const connections = yield* runtime.getConnections;
        const attempt = yield* Queue.take(fake.attempts);
        expect(attempt.input.environment.environmentId).toBe("source-env");
        expect(attempt.input.credential.token).toBe("latest-durable-token");
        yield* connections.disable(registrationId);
        yield* attempt.closed;
      }),
  );
});
