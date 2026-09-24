import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924132422_session-task-fleet",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_task_actor_claim\` ADD \`actor_item\` integer DEFAULT -1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_task_operation\` ADD \`actor_item\` integer DEFAULT -1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`actor_item\` integer DEFAULT -1 NOT NULL;`)
      // drizzle-kit does not diff index column lists, so widen the actor
      // uniqueness indexes by hand to admit one operation per batch item.
      yield* tx.run(`DROP INDEX IF EXISTS \`session_task_actor_claim_actor_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_actor_claim_actor_idx\` ON \`session_task_actor_claim\` (\`actor_session_id\`,\`actor_assistant_message_id\`,\`actor_tool_call_id\`,\`actor_item\`);`,
      )
      yield* tx.run(`DROP INDEX IF EXISTS \`session_task_operation_actor_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_operation_actor_idx\` ON \`session_task_operation\` (\`actor_session_id\`,\`actor_assistant_message_id\`,\`actor_tool_call_id\`,\`actor_item\`);`,
      )
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`wave\` text;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`orchestrate\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_task_parent_wave_idx\` ON \`session_task\` (\`parent_session_id\`,\`wave\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
