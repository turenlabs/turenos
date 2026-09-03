import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729045159_session-durable-status",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`status\` text DEFAULT 'idle' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`status_owner\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`status_attempt\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`status_message\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`status_next\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`status_action\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
