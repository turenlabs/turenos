import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008010902_team-rich-content",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`team_message\` ADD \`source_message_ids\` text;`)
      yield* tx.run(`ALTER TABLE \`team_teammate\` ADD \`avatar\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
