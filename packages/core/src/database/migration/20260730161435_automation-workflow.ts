import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730161435_automation-workflow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_workflow\` text;`)
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`workflow\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
