import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727200816_session-input-routing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`agent\` text;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`model\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
