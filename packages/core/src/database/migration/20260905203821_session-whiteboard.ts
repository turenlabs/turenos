import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260905203821_session-whiteboard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_whiteboard\` (
          \`session_id\` text PRIMARY KEY,
          \`revision\` integer NOT NULL,
          \`elements\` text NOT NULL,
          \`files\` text NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_whiteboard_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
