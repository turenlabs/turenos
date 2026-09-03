import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260821204524_pending-board-session-index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_input_pending_board_session_idx\` ON \`session_input\` (\`session_id\`) WHERE "session_input"."source" = 'subagent_board' AND "session_input"."promoted_seq" IS NULL AND "session_input"."time_cancelled" IS NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
