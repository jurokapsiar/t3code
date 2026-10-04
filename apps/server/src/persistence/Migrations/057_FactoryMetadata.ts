import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE factory_environments (
      registration_id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL UNIQUE,
      endpoint TEXT NOT NULL,
      label TEXT NOT NULL,
      platform TEXT,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'online', 'offline', 'blocked', 'removing')
      ),
      credential_storage TEXT CHECK (
        credential_storage IS NULL OR credential_storage IN ('secure-vault', 'protected-file')
      ),
      credential_item_key TEXT,
      credential_expires_at TEXT,
      renewal TEXT NOT NULL DEFAULT 'unsupported' CHECK (
        renewal IN ('ready', 'unsupported', 'due', 'failed', 'expired')
      ),
      last_seen_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      CHECK ((credential_storage IS NULL) = (credential_item_key IS NULL))
    )
  `;

  yield* sql`
    CREATE TABLE factory_project_groups (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE factory_project_memberships (
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      PRIMARY KEY (environment_id, project_id),
      FOREIGN KEY (environment_id) REFERENCES factory_environments(environment_id)
        ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES factory_project_groups(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE factory_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'group')),
      group_id TEXT,
      environment_id TEXT,
      project_id TEXT,
      order_index INTEGER NOT NULL CHECK (order_index >= 0),
      CHECK (
        (target_kind = 'group' AND group_id IS NOT NULL AND environment_id IS NULL AND project_id IS NULL)
        OR
        (target_kind = 'project' AND group_id IS NULL AND environment_id IS NOT NULL AND project_id IS NOT NULL)
      ),
      FOREIGN KEY (group_id) REFERENCES factory_project_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (environment_id) REFERENCES factory_environments(environment_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_factory_favorite_group
    ON factory_favorites(group_id) WHERE target_kind = 'group'
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_factory_favorite_project
    ON factory_favorites(environment_id, project_id) WHERE target_kind = 'project'
  `;
});
