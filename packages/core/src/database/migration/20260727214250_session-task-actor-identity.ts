import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727214250_session-task-actor-identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_task_operation_actor_kind_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_operation_actor_idx\` ON \`session_task_operation\` (\`actor_session_id\`,\`actor_assistant_message_id\`,\`actor_tool_call_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
