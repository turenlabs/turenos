import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823211419_flawless_bastion",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_task_operation_applied_message_task_idx\` ON \`session_task_operation\` (\`message_id\`,\`task_id\`) WHERE "session_task_operation"."status" = 'applied' AND "session_task_operation"."message_id" IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
