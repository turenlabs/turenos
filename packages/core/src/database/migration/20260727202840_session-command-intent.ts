import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727202840_session-command-intent",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`command\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
