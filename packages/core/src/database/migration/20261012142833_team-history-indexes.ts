import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012142833_team-history-indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`team_factory_run_room_time_idx\` ON \`team_factory_run\` (\`room_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`team_task_room_time_idx\` ON \`team_task\` (\`room_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`team_task_active_room_time_idx\` ON \`team_task\` (\`room_id\`,\`time_created\`) WHERE "team_task"."status" IN ('claimed', 'running');`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
