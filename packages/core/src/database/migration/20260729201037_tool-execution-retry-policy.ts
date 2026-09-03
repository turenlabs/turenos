import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729201037_tool-execution-retry-policy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`tool_execution\` ADD \`retryable_error\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
