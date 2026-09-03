import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722002438_storage_state_tombstones",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`storage_state\` ADD \`deleted\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
