import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260807015024_mixed_brother_voodoo",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_harness\` ADD \`reviewer_runs\` text DEFAULT '[]' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
