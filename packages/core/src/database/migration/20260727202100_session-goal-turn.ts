import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727202100_session-goal-turn",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal_turn\` (
          \`assistant_message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`goal_id\` text NOT NULL,
          \`goal_revision\` integer NOT NULL,
          \`token_delta\` integer NOT NULL,
          \`active_time_ms_delta\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_goal_turn_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_goal_turn_session_idx\` ON \`session_goal_turn\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
