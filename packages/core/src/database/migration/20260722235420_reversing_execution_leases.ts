import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722235420_reversing_execution_leases",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`lease_owner\` text;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`lease_until\` integer;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`last_heartbeat\` integer;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`sandbox_lease_json\` text;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`checkpoint_json\` text;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`cleanup_debt_json\` text;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`dynamic_started\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`reversing_execution\` ADD \`reaper_state\` text DEFAULT 'idle' NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`reversing_execution_claim_idx\` ON \`reversing_execution\` (\`state\`,\`lease_until\`,\`absolute_ttl\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
