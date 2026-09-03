import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727191941_session-transcript-adoption",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_transcript_adoption\` (
          \`session_id\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_transcript_adoption_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
