import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008124415_team-room-lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`team_room\` ADD \`archived\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
