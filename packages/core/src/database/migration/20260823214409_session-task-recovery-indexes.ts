import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823214409_session-task-recovery-indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_input_pending_id_idx\` ON \`session_input\` (\`id\`) WHERE "session_input"."promoted_seq" IS NULL AND "session_input"."time_cancelled" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_operation_status_created_idx\` ON \`session_task_operation\` (\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_status_created_idx\` ON \`session_task\` (\`status\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
