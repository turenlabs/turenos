import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260729200226_tool-execution-ledger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`tool_execution\` (
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`status\` text NOT NULL,
          \`owner_id\` text,
          \`settlement\` text,
          \`lease_expires_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tool_execution_pk\` PRIMARY KEY(\`session_id\`, \`assistant_message_id\`, \`call_id\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
