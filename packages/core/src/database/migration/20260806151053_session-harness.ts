import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806151053_session-harness",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_harness\` (
          \`session_id\` text PRIMARY KEY,
          \`revision\` integer NOT NULL,
          \`version\` integer NOT NULL,
          \`snapshot\` text NOT NULL,
          \`snapshots\` text NOT NULL,
          \`proposals\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_harness_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
