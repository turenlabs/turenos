import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012183644_team-attachments",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`team_attachment\` (
          \`message_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`room_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`digest\` text NOT NULL,
          \`content\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`team_attachment_pk\` PRIMARY KEY(\`message_id\`, \`position\`),
          CONSTRAINT \`fk_team_attachment_message_id_team_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`team_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_attachment_room_id_team_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`team_room\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`team_attachment_room_idx\` ON \`team_attachment\` (\`room_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
