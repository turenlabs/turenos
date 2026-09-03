import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727184945_session_goal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`session_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL UNIQUE,
          \`revision\` integer NOT NULL,
          \`objective\` text NOT NULL,
          \`status\` text NOT NULL,
          \`token_budget\` integer,
          \`tokens_used\` integer NOT NULL,
          \`active_time_ms\` integer NOT NULL,
          \`status_changed_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_goal_status_idx\` ON \`session_goal\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
