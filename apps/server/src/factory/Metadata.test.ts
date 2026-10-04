import { assert, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

import { FactoryEnvironmentView, FactoryProjectKey } from "@t3tools/contracts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as Metadata from "./Metadata.ts";

it.layer(SqlitePersistenceMemory)("Factory metadata migration", (it) => {
  it.effect("creates exactly the four factory metadata tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'factory_%'
        ORDER BY name
      `;

      assert.deepEqual(
        rows.map((row) => row.name),
        [
          "factory_environments",
          "factory_favorites",
          "factory_project_groups",
          "factory_project_memberships",
        ],
      );
    }),
  );
});

const metadataLayer = it.layer(
  Metadata.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer)),
  ),
);

const decodeEnvironment = Schema.decodeSync(FactoryEnvironmentView);
const decodeProject = Schema.decodeSync(FactoryProjectKey);

const environment = (registrationId: string, environmentId: string) =>
  decodeEnvironment({
    registrationId,
    environmentId,
    endpoint: `https://${environmentId}.example`,
    label: environmentId,
    platform: null,
    enabled: false,
    state: "pending",
    credentialStorage: null,
    credentialExpiresAt: null,
    renewal: "unsupported",
    lastSeenAt: null,
    revision: 0,
  });

const project = (environmentId: string, projectId: string) =>
  decodeProject({ environmentId, projectId });

metadataLayer("Factory metadata", (it) => {
  it.effect("advertises a relative source WebSocket route without storing it or a credential", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      yield* metadata.createEnvironment(environment("route/source", "route-environment"));
      const view = (yield* metadata.listEnvironments)[0];
      expect(view?.sourceAccess).toEqual({
        websocketRoute: "/factory/env/route%2Fsource/ws",
        httpPrefix: "/factory/env/route%2Fsource/",
        capabilities: { websocket: true, http: true },
      });
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql`PRAGMA table_info(factory_environments)`;
      expect(columns.map((row) => row.name)).not.toContain("source_access");
    }),
  );

  it.effect("reads the current enrollment reference and forgets it after removal", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      const pending = environment("reference-registration", "reference-environment");
      assert.isUndefined(yield* metadata.getEnrollmentReference(pending.registrationId));
      yield* metadata.createEnvironment(pending);
      const enrolled = yield* metadata.markEnrollment({
        registrationId: pending.registrationId,
        credentialStorage: "secure-vault",
        credentialItemKey: "current-reference",
        credentialExpiresAt: null,
      });
      assert.deepEqual(yield* metadata.getEnrollmentReference(pending.registrationId), {
        environment: enrolled,
        credentialStorage: "secure-vault",
        credentialItemKey: "current-reference",
      });
      yield* metadata.markRemoving({
        registrationId: enrolled.registrationId,
        revision: enrolled.revision,
      });
      const cleared = yield* metadata.clearCredentialReference(enrolled.registrationId);
      yield* metadata.removeEnvironment({
        registrationId: cleared.registrationId,
        revision: cleared.revision,
      });
      assert.isUndefined(yield* metadata.getEnrollmentReference(enrolled.registrationId));
    }),
  );

  it.effect("keeps metadata after closing and reopening the SQLite database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-reopen-" });
      const dbPath = path.join(directory, "factory.sqlite");
      const firstScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
      const firstPersistence = makeSqlitePersistenceLive(dbPath);
      const firstServices = yield* Layer.buildWithScope(
        Layer.merge(Metadata.layer, firstPersistence).pipe(Layer.provideMerge(NodeServices.layer)),
        firstScope,
      );
      const firstMetadata = Context.get(firstServices, Metadata.Metadata);
      const group = yield* firstMetadata.createGroup({ name: "Persisted group" });
      yield* Scope.close(firstScope, Exit.void);

      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      const secondPersistence = makeSqlitePersistenceLive(dbPath);
      const secondServices = yield* Layer.buildWithScope(
        Layer.merge(Metadata.layer, secondPersistence).pipe(Layer.provideMerge(NodeServices.layer)),
        secondScope,
      );
      const snapshot = yield* Context.get(secondServices, Metadata.Metadata).getSnapshot;

      expect(snapshot.groups).toHaveLength(1);
      expect(snapshot.groups[0]).toMatchObject({ id: group.id, name: "Persisted group" });
    }),
  );

  it.effect("does not mark an enrolled source online before a supervisor connects", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      const pending = environment("registration-d", "environment-d");
      yield* metadata.createEnvironment(pending);
      const enrolled = yield* metadata.markEnrollment({
        registrationId: pending.registrationId,
        credentialStorage: "secure-vault",
        credentialItemKey: "registration-d",
        credentialExpiresAt: null,
      });

      expect(enrolled).toMatchObject({
        enabled: true,
        state: "offline",
        credentialStorage: "secure-vault",
      });
    }),
  );

  it.effect("publishes credential renewal status without exposing credential data", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      const pending = environment("registration-renewal", "environment-renewal");
      yield* metadata.createEnvironment(pending);
      yield* metadata.markEnrollment({
        registrationId: pending.registrationId,
        credentialStorage: "secure-vault",
        credentialItemKey: "opaque-reference",
        credentialExpiresAt: null,
      });

      const renewed = yield* metadata.setRenewalStatus(pending.registrationId, "failed");
      const snapshot = yield* metadata.getSnapshot;

      expect(renewed.renewal).toBe("failed");
      expect(
        snapshot.environments.find((entry) => entry.registrationId === pending.registrationId)
          ?.renewal,
      ).toBe("failed");
      expect(yield* encodeJson(snapshot)).not.toContain("opaque-reference");
    }),
  );

  it.effect(
    "keeps an enrolled endpoint immutable while allowing equivalent URLs and metadata edits",
    () =>
      Effect.gen(function* () {
        const metadata = yield* Metadata.Metadata;
        const pending = environment("registration-endpoint", "endpoint-environment");
        yield* metadata.createEnvironment(pending);
        const enrolled = yield* metadata.markEnrollment({
          registrationId: pending.registrationId,
          credentialStorage: "secure-vault",
          credentialItemKey: "endpoint-credential",
          credentialExpiresAt: null,
        });

        const rejected = yield* Effect.flip(
          metadata.updateEnvironment({
            registrationId: enrolled.registrationId,
            revision: enrolled.revision,
            endpoint: "https://attacker.example",
          }),
        );
        expect(rejected).toMatchObject({ code: "invalid-request" });
        expect(
          (yield* metadata.getEnrollmentReference(enrolled.registrationId))?.environment,
        ).toMatchObject({ endpoint: pending.endpoint, credentialStorage: "secure-vault" });

        const updated = yield* metadata.updateEnvironment({
          registrationId: enrolled.registrationId,
          revision: enrolled.revision,
          endpoint: "https://ENDPOINT-ENVIRONMENT.EXAMPLE:443/",
          label: "Renamed source",
          enabled: false,
        });
        expect(updated).toMatchObject({
          endpoint: pending.endpoint,
          label: "Renamed source",
          enabled: false,
        });

        const enabled = yield* metadata.updateEnvironment({
          registrationId: updated.registrationId,
          revision: updated.revision,
          enabled: true,
        });
        expect(enabled.enabled).toBe(true);
      }),
  );

  it.effect("publishes renewal status without exposing cleanup internals", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      const pending = environment("registration-cleanup", "environment-cleanup");
      yield* metadata.createEnvironment(pending);
      yield* metadata.markEnrollment({
        registrationId: pending.registrationId,
        credentialStorage: "secure-vault",
        credentialItemKey: "opaque-reference",
        credentialExpiresAt: null,
      });

      const updated = yield* metadata.setRenewalStatus(pending.registrationId, "ready");

      expect(updated.renewal).toBe("ready");
      expect((yield* metadata.getSnapshot).environments[0]?.renewal).toBe("ready");
      expect("cleanupPending" in updated).toBe(false);
    }),
  );

  it.effect("keeps equal project IDs distinct across environments", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      yield* metadata.createEnvironment(environment("registration-a", "environment-a"));
      yield* metadata.createEnvironment(environment("registration-b", "environment-b"));
      const group = yield* metadata.createGroup({ name: "Review" });
      const first = yield* metadata.assignProject({
        groupId: group.id,
        project: project("environment-a", "project-1"),
      });
      const second = yield* metadata.assignProject({
        groupId: group.id,
        project: project("environment-b", "project-1"),
      });

      expect([first.project, second.project]).toEqual([
        project("environment-a", "project-1"),
        project("environment-b", "project-1"),
      ]);
      expect((yield* metadata.getSnapshot).memberships).toEqual([first, second]);
    }),
  );

  it.effect("uses expected group revisions and cascades group favorites on delete", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      const group = yield* metadata.createGroup({ name: "Review" });
      yield* metadata.renameGroup({
        groupId: group.id,
        name: "Reviewed",
        revision: group.revision,
      });
      const conflict = yield* Effect.flip(
        metadata.renameGroup({
          groupId: group.id,
          name: "Stale rename",
          revision: group.revision,
        }),
      );
      expect(conflict).toMatchObject({ _tag: "FactoryError", code: "conflict" });

      yield* metadata.setFavorite({ target: { kind: "group", groupId: group.id }, favorite: true });
      const favorited = (yield* metadata.getSnapshot).groups.find((item) => item.id === group.id)!;
      yield* metadata.deleteGroup({ groupId: group.id, revision: favorited.revision });
      const afterDelete = yield* metadata.getSnapshot;
      expect(afterDelete.groups.some((item) => item.id === group.id)).toBe(false);
      expect(
        afterDelete.favorites.some(
          (item) => item.target.kind === "group" && item.target.groupId === group.id,
        ),
      ).toBe(false);
    }),
  );

  it.effect("bumps both group revisions when membership moves and guards stale deletes", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      yield* metadata.createEnvironment(environment("registration-groups", "environment-groups"));
      const source = yield* metadata.createGroup({ name: "Source" });
      const destination = yield* metadata.createGroup({ name: "Destination" });
      const key = project("environment-groups", "project-1");

      yield* metadata.assignProject({ groupId: source.id, project: key });
      const afterAssign = yield* metadata.getSnapshot;
      const assignedSource = afterAssign.groups.find((item) => item.id === source.id)!;
      expect(assignedSource.revision).toBe(source.revision + 1);
      expect(
        yield* Effect.flip(metadata.deleteGroup({ groupId: source.id, revision: source.revision })),
      ).toMatchObject({ code: "conflict" });

      yield* metadata.assignProject({ groupId: destination.id, project: key });
      const afterMove = yield* metadata.getSnapshot;
      const movedSource = afterMove.groups.find((item) => item.id === source.id)!;
      const movedDestination = afterMove.groups.find((item) => item.id === destination.id)!;
      expect(movedSource.revision).toBe(assignedSource.revision + 1);
      expect(movedDestination.revision).toBe(destination.revision + 1);
      expect(
        yield* Effect.flip(
          metadata.deleteGroup({ groupId: destination.id, revision: destination.revision }),
        ),
      ).toMatchObject({ code: "conflict" });

      yield* metadata.unassignProject({ groupId: destination.id, project: key });
      const afterUnassign = (yield* metadata.getSnapshot).groups.find(
        (item) => item.id === destination.id,
      )!;
      expect(afterUnassign.revision).toBe(movedDestination.revision + 1);
    }),
  );

  it.effect("bumps group revisions when group favorites are added, removed, and reordered", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      const first = yield* metadata.createGroup({ name: "First" });
      const second = yield* metadata.createGroup({ name: "Second" });

      yield* metadata.setFavorite({ target: { kind: "group", groupId: first.id }, favorite: true });
      let snapshot = yield* metadata.getSnapshot;
      let firstRevision = snapshot.groups.find((item) => item.id === first.id)!.revision;
      expect(firstRevision).toBe(first.revision + 1);
      expect(
        yield* Effect.flip(metadata.deleteGroup({ groupId: first.id, revision: first.revision })),
      ).toMatchObject({ code: "conflict" });

      yield* metadata.setFavorite({
        target: { kind: "group", groupId: second.id },
        favorite: true,
      });
      snapshot = yield* metadata.getSnapshot;
      const secondRevision = snapshot.groups.find((item) => item.id === second.id)!.revision;
      yield* metadata.reorderFavorites({
        targets: [
          { kind: "group", groupId: second.id },
          { kind: "group", groupId: first.id },
        ],
      });
      snapshot = yield* metadata.getSnapshot;
      firstRevision = snapshot.groups.find((item) => item.id === first.id)!.revision;
      expect(firstRevision).toBeGreaterThan(first.revision + 1);
      expect(snapshot.groups.find((item) => item.id === second.id)!.revision).toBe(
        secondRevision + 1,
      );

      yield* metadata.setFavorite({
        target: { kind: "group", groupId: first.id },
        favorite: false,
      });
      snapshot = yield* metadata.getSnapshot;
      expect(snapshot.groups.find((item) => item.id === first.id)!.revision).toBe(
        firstRevision + 1,
      );
    }),
  );

  it.effect("subscribes atomically with a metadata snapshot and observes later commits", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      const before = yield* metadata.createGroup({ name: "Before watch" });
      const watch = yield* metadata.subscribeWithSnapshot;
      const queue = yield* Stream.toQueue(watch.changes, { capacity: 1 });
      const after = yield* metadata.createGroup({ name: "After watch" });
      const commit = yield* Queue.take(queue);

      expect(watch.initial.snapshot.groups).toContainEqual(before);
      expect(watch.initial.snapshot.groups).not.toContainEqual(after);
      expect(commit.revision).toBe(watch.initial.revision + 1);
      expect(commit.snapshot.groups).toContainEqual(after);
    }),
  );

  it.effect("removes a project favorite on assignment and allows it after unassignment", () =>
    Effect.gen(function* () {
      const metadata = yield* Metadata.Metadata;
      yield* metadata.createEnvironment(environment("registration-c", "environment-c"));
      const group = yield* metadata.createGroup({ name: "Review" });
      const key = project("environment-c", "project-1");
      const target = { kind: "project" as const, project: key };

      yield* metadata.setFavorite({ target, favorite: true });
      yield* metadata.assignProject({ groupId: group.id, project: key });
      expect(
        (yield* metadata.getSnapshot).favorites.filter(
          (favorite) =>
            favorite.target.kind === "project" &&
            favorite.target.project.environmentId === key.environmentId &&
            favorite.target.project.projectId === key.projectId,
        ),
      ).toEqual([]);
      yield* metadata.unassignProject({ groupId: group.id, project: key });
      yield* metadata.setFavorite({ target, favorite: true });
      expect(
        (yield* metadata.getSnapshot).favorites.filter(
          (favorite) =>
            favorite.target.kind === "project" &&
            favorite.target.project.environmentId === key.environmentId &&
            favorite.target.project.projectId === key.projectId,
        ),
      ).toHaveLength(1);
    }),
  );
});
