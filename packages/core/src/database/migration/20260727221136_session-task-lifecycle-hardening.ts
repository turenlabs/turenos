import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727221136_session-task-lifecycle-hardening",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_task_actor_claim\` (
          \`id\` text PRIMARY KEY,
          \`actor_session_id\` text NOT NULL,
          \`actor_assistant_message_id\` text NOT NULL,
          \`actor_tool_call_id\` text NOT NULL,
          \`operation_id\` text NOT NULL UNIQUE,
          \`task_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`actor_session_id\` text NOT NULL DEFAULT '';`)
      yield* tx.run(`UPDATE \`session_task\` SET \`actor_session_id\` = \`parent_session_id\`;`)
      yield* tx.run(`
        INSERT OR IGNORE INTO \`session_task_actor_claim\` (
          \`id\`,
          \`actor_session_id\`,
          \`actor_assistant_message_id\`,
          \`actor_tool_call_id\`,
          \`operation_id\`,
          \`task_id\`,
          \`kind\`,
          \`request_hash\`,
          \`time_created\`
        )
        SELECT
          \`id\`,
          \`actor_session_id\`,
          \`actor_assistant_message_id\`,
          \`actor_tool_call_id\`,
          \`id\`,
          \`task_id\`,
          \`kind\`,
          \`request_hash\`,
          \`time_created\`
        FROM \`session_task_operation\`;
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_actor_claim_actor_idx\` ON \`session_task_actor_claim\` (\`actor_session_id\`,\`actor_assistant_message_id\`,\`actor_tool_call_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_task_actor_claim_task_idx\` ON \`session_task_actor_claim\` (\`task_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
