import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260809150000_subagent_board_input_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD COLUMN \`source\` text NOT NULL DEFAULT 'user';`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_source_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`source\`,\`admitted_seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
