import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const factoryColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(factory_environments)`;
  if (!factoryColumns.some((column) => column.name === "renewal")) {
    yield* sql`
      ALTER TABLE factory_environments
      ADD COLUMN renewal TEXT NOT NULL DEFAULT 'unsupported' CHECK (
        renewal IN ('ready', 'unsupported', 'due', 'failed', 'expired')
      )
    `;
  }
  if (factoryColumns.some((column) => column.name === "cleanup_pending")) {
    yield* sql`ALTER TABLE factory_environments DROP COLUMN cleanup_pending`;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  if (!sessionColumns.some((column) => column.name === "renewed_from")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN renewed_from TEXT REFERENCES auth_sessions(session_id)`;
  }
  if (!sessionColumns.some((column) => column.name === "root_issued_at")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN root_issued_at TEXT`;
    yield* sql`UPDATE auth_sessions SET root_issued_at = issued_at WHERE root_issued_at IS NULL`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_renewal_successors
    ON auth_sessions(renewed_from, revoked_at, expires_at)
  `;
});
