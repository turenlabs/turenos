import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730164124_automation-step-cursor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`current_step\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
