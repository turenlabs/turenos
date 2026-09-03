import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725030921_reversing_execution_location",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`location_json\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
