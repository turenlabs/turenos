import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261002133019_session-context-blob",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_context_blob\` (
          \`session_id\` text NOT NULL,
          \`sha256\` text NOT NULL,
          \`data\` text NOT NULL,
          \`size\` integer NOT NULL,
          CONSTRAINT \`session_context_blob_pk\` PRIMARY KEY(\`session_id\`, \`sha256\`),
          CONSTRAINT \`fk_session_context_blob_session_id_session_context_epoch_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_context_epoch\`(\`session_id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
