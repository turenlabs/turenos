import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729184814_session-task-query-indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_task_root_created_idx\` ON \`session_task\` (\`root_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_parent_created_idx\` ON \`session_task\` (\`parent_session_id\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
