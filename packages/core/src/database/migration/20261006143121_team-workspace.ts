import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006143121_team-workspace",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`team_duty_run\` (
          \`run_id\` text PRIMARY KEY,
          \`loop_id\` text NOT NULL,
          \`teammate_id\` text NOT NULL,
          \`room_id\` text NOT NULL,
          \`author\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_team_duty_run_run_id_loop_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`loop_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_duty_run_loop_id_loop_id_fk\` FOREIGN KEY (\`loop_id\`) REFERENCES \`loop\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_duty_run_teammate_id_team_teammate_id_fk\` FOREIGN KEY (\`teammate_id\`) REFERENCES \`team_teammate\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_duty_run_room_id_team_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`team_room\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_duty\` (
          \`loop_id\` text PRIMARY KEY,
          \`teammate_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_team_duty_loop_id_loop_id_fk\` FOREIGN KEY (\`loop_id\`) REFERENCES \`loop\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_duty_teammate_id_team_teammate_id_fk\` FOREIGN KEY (\`teammate_id\`) REFERENCES \`team_teammate\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_message\` (
          \`id\` text PRIMARY KEY,
          \`room_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`source_key\` text,
          \`kind\` text NOT NULL,
          \`author\` text NOT NULL,
          \`teammate_id\` text,
          \`text\` text NOT NULL,
          \`reply_to\` text,
          \`session_id\` text,
          \`run_id\` text,
          \`loop_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_team_message_room_id_team_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`team_room\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_message_teammate_id_team_teammate_id_fk\` FOREIGN KEY (\`teammate_id\`) REFERENCES \`team_teammate\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_room\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`topic\` text NOT NULL,
          \`head\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_task\` (
          \`id\` text PRIMARY KEY,
          \`room_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`teammate_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`error\` text,
          \`lease_owner\` text,
          \`lease_expires_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_task_room_id_team_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`team_room\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_task_message_id_team_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`team_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_team_task_teammate_id_team_teammate_id_fk\` FOREIGN KEY (\`teammate_id\`) REFERENCES \`team_teammate\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_teammate\` (
          \`id\` text PRIMARY KEY,
          \`room_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`handle\` text NOT NULL,
          \`role\` text NOT NULL,
          \`mission\` text NOT NULL,
          \`status\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_teammate_room_id_team_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`team_room\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`team_duty_teammate_idx\` ON \`team_duty\` (\`teammate_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_message_room_seq_idx\` ON \`team_message\` (\`room_id\`,\`seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_message_source_idx\` ON \`team_message\` (\`source_key\`);`)
      yield* tx.run(`CREATE INDEX \`team_message_room_time_idx\` ON \`team_message\` (\`room_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_room_name_idx\` ON \`team_room\` (\`name\`);`)
      yield* tx.run(`CREATE INDEX \`team_task_status_lease_idx\` ON \`team_task\` (\`status\`,\`lease_expires_at\`);`)
      yield* tx.run(`CREATE INDEX \`team_task_teammate_status_idx\` ON \`team_task\` (\`teammate_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`team_task_message_teammate_idx\` ON \`team_task\` (\`message_id\`,\`teammate_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`team_teammate_handle_idx\` ON \`team_teammate\` (\`room_id\`,\`handle\`);`)
      yield* tx.run(`CREATE INDEX \`team_teammate_room_idx\` ON \`team_teammate\` (\`room_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
