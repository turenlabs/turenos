import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730171430_automation-step-outputs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`step_outputs\` text DEFAULT '{}' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
