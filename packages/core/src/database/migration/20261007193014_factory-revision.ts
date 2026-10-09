import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007193014_factory-revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`team_room\` ADD \`factory_revision\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
