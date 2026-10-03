import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE factory_environments
    ADD COLUMN renewal TEXT NOT NULL DEFAULT 'unsupported' CHECK (
      renewal IN ('ready', 'unsupported', 'due', 'failed', 'expired')
    )
  `;
});
