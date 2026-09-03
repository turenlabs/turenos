import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260809152000_team_board_parent_notification",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `ALTER TABLE \`team_board_note\` ADD COLUMN \`parent_notification_status\` text NOT NULL DEFAULT 'none';`,
      )
      yield* tx.run(
        `CREATE INDEX \`team_board_pending_notification_idx\` ON \`team_board_note\` (\`parent_notification_status\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
