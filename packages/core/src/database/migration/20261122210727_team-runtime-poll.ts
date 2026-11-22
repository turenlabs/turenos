import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261122210727_team-runtime-poll",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`team_factory_run_running_idx\` ON \`team_factory_run\` (\`id\`) WHERE "team_factory_run"."status" = 'running';`,
      )
      yield* tx.run(
        `CREATE INDEX \`team_message_run_idx\` ON \`team_message\` (\`run_id\`) WHERE "team_message"."run_id" IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
