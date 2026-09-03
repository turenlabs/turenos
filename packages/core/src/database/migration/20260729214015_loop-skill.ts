import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729214015_loop-skill",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`skill\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
