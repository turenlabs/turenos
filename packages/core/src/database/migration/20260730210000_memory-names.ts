import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730210000_memory-names",
  up(tx) {
    return Effect.gen(function* () {
      // Empty legacy names make the API response fail schema validation.
      yield* tx.run(
        `UPDATE \`memory_wing\` SET \`name\` = CASE WHEN \`key\` <> '' THEN \`key\` ELSE \`id\` END WHERE \`name\` = '';`,
      )
      yield* tx.run(
        `UPDATE \`memory_room\` SET \`name\` = CASE WHEN \`slug\` <> '' THEN \`slug\` ELSE \`id\` END WHERE \`name\` = '';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
