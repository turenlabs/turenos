import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722234741_reversing_cancel_intent",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`cancel_idempotency_key\` text;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`cancel_request_hash\` text;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`cancel_result_case_revision\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
