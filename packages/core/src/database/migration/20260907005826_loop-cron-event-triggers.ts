import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907005826_loop-cron-event-triggers",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`trigger_payload\` text;`)
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`cron_expression\` text;`)
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`trigger_type\` text;`)
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`trigger_config\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
