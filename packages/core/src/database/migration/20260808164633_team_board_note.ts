import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808164633_team_board_note",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`team_board_note\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`author_session_id\` text NOT NULL,
          \`author_agent\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`title\` text NOT NULL,
          \`body\` text NOT NULL,
          \`evidence\` text,
          \`supersedes\` text,
          \`superseded_by\` text,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_board_note_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`team_board_root_idx\` ON \`team_board_note\` (\`root_session_id\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
