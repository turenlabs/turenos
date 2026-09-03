import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729213807_loop-agent-model",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`agent\` text;`)
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`model\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
