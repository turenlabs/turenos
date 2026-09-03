import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729194403_durable-loop",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`loop_run\` (
          \`id\` text PRIMARY KEY,
          \`loop_id\` text NOT NULL,
          \`scheduled_at\` integer NOT NULL,
          \`trigger\` text NOT NULL,
          \`status\` text NOT NULL,
          \`lease_owner\` text,
          \`lease_expires_at\` integer,
          \`session_id\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_loop_run_loop_id_loop_id_fk\` FOREIGN KEY (\`loop_id\`) REFERENCES \`loop\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`loop\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`status\` text NOT NULL,
          \`schedule_type\` text NOT NULL,
          \`interval_seconds\` integer NOT NULL,
          \`timezone\` text NOT NULL,
          \`overlap_policy\` text NOT NULL,
          \`starts_at\` integer NOT NULL,
          \`next_run_at\` integer,
          \`expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`loop_run_occurrence_idx\` ON \`loop_run\` (\`loop_id\`,\`scheduled_at\`);`)
      yield* tx.run(`CREATE INDEX \`loop_run_status_lease_idx\` ON \`loop_run\` (\`status\`,\`lease_expires_at\`);`)
      yield* tx.run(`CREATE INDEX \`loop_run_loop_created_idx\` ON \`loop_run\` (\`loop_id\`,\`time_created\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`loop_status_due_idx\` ON \`loop\` (\`status\`,\`next_run_at\`);`)
      yield* tx.run(`CREATE INDEX \`loop_created_idx\` ON \`loop\` (\`time_created\`,\`id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
