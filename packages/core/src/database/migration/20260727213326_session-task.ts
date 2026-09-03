import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727213326_session-task",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task_operation\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`actor_session_id\` text NOT NULL,
          \`actor_assistant_message_id\` text NOT NULL,
          \`actor_tool_call_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`message_id\` text,
          \`prompt\` text,
          \`status\` text NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_task_operation_task_id_session_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`session_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_operation_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_operation_actor_session_id_session_id_fk\` FOREIGN KEY (\`actor_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_task\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL UNIQUE,
          \`parent_task_id\` text,
          \`actor_assistant_message_id\` text NOT NULL,
          \`actor_tool_call_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`model\` text,
          \`prompt\` text NOT NULL,
          \`description\` text NOT NULL,
          \`depth\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`parent_permissions\` text NOT NULL,
          \`ancestor_permission_sets\` text NOT NULL,
          \`child_permissions\` text NOT NULL,
          \`hard_permissions\` text NOT NULL,
          \`write_roots\` text NOT NULL,
          \`commands\` text NOT NULL,
          \`result\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_task_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_parent_task_id_session_task_id_fk\` FOREIGN KEY (\`parent_task_id\`) REFERENCES \`session_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`time_cancelled\` integer;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_operation_actor_kind_idx\` ON \`session_task_operation\` (\`actor_session_id\`,\`actor_assistant_message_id\`,\`actor_tool_call_id\`,\`kind\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_operation_task_idx\` ON \`session_task_operation\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_operation_message_idx\` ON \`session_task_operation\` (\`message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_root_status_idx\` ON \`session_task\` (\`root_session_id\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_task_parent_session_idx\` ON \`session_task\` (\`parent_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_task_parent_task_idx\` ON \`session_task\` (\`parent_task_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
