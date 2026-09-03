import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260807234937_agent_improvement_proposal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_improvement_proposal\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`author_session_id\` text NOT NULL,
          \`author_agent\` text NOT NULL,
          \`baseline_markdown\` text NOT NULL,
          \`proposal_markdown\` text NOT NULL,
          \`rationale\` text NOT NULL,
          \`evidence\` text NOT NULL,
          \`status\` text NOT NULL,
          \`validation\` text,
          \`error\` text,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_agent_improvement_proposal_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`agent_improvement_root_idx\` ON \`agent_improvement_proposal\` (\`root_session_id\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
