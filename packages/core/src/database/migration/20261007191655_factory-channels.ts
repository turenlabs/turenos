import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007191655_factory-channels",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`team_factory_run\` (
          \`id\` text PRIMARY KEY,
          \`room_id\` text NOT NULL,
          \`request\` text NOT NULL,
          \`source_loop_run_id\` text,
          \`status\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`config\` text NOT NULL,
          \`profiles\` text NOT NULL,
          \`task_ids\` text DEFAULT '[]' NOT NULL,
          \`result\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_factory_run_room_id_team_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`team_room\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`team_room\` ADD \`factory_config\` text;`)
      yield* tx.run(`ALTER TABLE \`team_task\` ADD \`factory_run_id\` text;`)
      yield* tx.run(`ALTER TABLE \`loop_run\` ADD \`execution_factory_room_id\` text;`)
      yield* tx.run(`ALTER TABLE \`loop\` ADD \`factory_room_id\` text;`)
      yield* tx.run(
        `CREATE INDEX \`team_factory_run_room_status_idx\` ON \`team_factory_run\` (\`room_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
