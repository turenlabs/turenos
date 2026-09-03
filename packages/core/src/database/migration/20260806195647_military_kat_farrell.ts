import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806195647_military_kat_farrell",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_harness\` ADD \`reviewer_requests\` text DEFAULT '[]' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
