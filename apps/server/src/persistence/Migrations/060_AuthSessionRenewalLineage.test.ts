import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("creates the consolidated fresh schema without cleanup state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const factoryColumns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(factory_environments)`;
    const sessionColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;

    assert.isTrue(factoryColumns.some((column) => column.name === "renewal"));
    assert.isFalse(factoryColumns.some((column) => column.name === "cleanup_pending"));
    assert.isTrue(sessionColumns.some((column) => column.name === "renewed_from"));
    assert.isTrue(sessionColumns.some((column) => column.name === "root_issued_at"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([57, 58, 59] as const)(
  "preserves branch database data upgraded through migration %s",
  (version) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      let columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(factory_environments)`;
      const hasRenewal = columns.some((column) => column.name === "renewal");
      if (version === 57 && hasRenewal) {
        yield* sql`ALTER TABLE factory_environments DROP COLUMN renewal`;
      } else if (version >= 58 && !hasRenewal) {
        yield* sql`ALTER TABLE factory_environments ADD COLUMN renewal TEXT NOT NULL DEFAULT 'unsupported' CHECK (renewal IN ('ready', 'unsupported', 'due', 'failed', 'expired'))`;
      }
      columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(factory_environments)`;
      if (version === 59 && !columns.some((column) => column.name === "cleanup_pending")) {
        yield* sql`ALTER TABLE factory_environments ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1))`;
      }
      for (const [id, name] of [
        [58, "FactoryCredentialRenewal"],
        [59, "FactoryCredentialCleanupPending"],
      ] as const) {
        if (version >= id) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (${id}, ${name}, '2026-10-04 00:00:00')`;
        }
      }
      yield* sql`INSERT INTO factory_environments (registration_id, environment_id, endpoint, label, enabled, state, revision) VALUES ('branch-registration', 'branch-environment', 'https://branch.example', 'Branch', 0, 'offline', 0)`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at) VALUES ('branch-session', 'factory-source', '["orchestration:read"]', 'bearer-access-token', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;

      yield* runMigrations();
      const factoryColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(factory_environments)`;
      const sessionColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(auth_sessions)`;
      assert.isTrue(factoryColumns.some((column) => column.name === "renewal"));
      assert.isFalse(factoryColumns.some((column) => column.name === "cleanup_pending"));
      assert.isTrue(sessionColumns.some((column) => column.name === "renewed_from"));
      assert.isTrue(sessionColumns.some((column) => column.name === "root_issued_at"));

      const registration = yield* sql<{
        readonly registration_id: string;
      }>`SELECT registration_id FROM factory_environments WHERE registration_id = 'branch-registration'`;
      const lineage = yield* sql<{
        readonly renewed_from: string | null;
        readonly root_issued_at: string;
      }>`SELECT renewed_from, root_issued_at FROM auth_sessions WHERE session_id = 'branch-session'`;
      assert.deepStrictEqual(registration, [{ registration_id: "branch-registration" }]);
      assert.deepStrictEqual(lineage, [
        { renewed_from: null, root_issued_at: "2026-09-01T00:00:00.000Z" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
