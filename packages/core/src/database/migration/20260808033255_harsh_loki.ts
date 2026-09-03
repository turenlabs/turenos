import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808033255_harsh_loki",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_task_parent_session_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_time_created_id_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`todo_session_idx\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
