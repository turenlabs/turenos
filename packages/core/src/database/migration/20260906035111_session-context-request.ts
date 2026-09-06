import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906035111_session-context-request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_context_request\` (
          \`session_id\` text PRIMARY KEY,
          \`data\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`identity\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          \`reason\` text NOT NULL,
          CONSTRAINT \`fk_session_context_request_session_id_session_context_epoch_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_context_epoch\`(\`session_id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
