import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260721162622_storage_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`storage_state\` (
          \`scope\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`storage_state_pk\` PRIMARY KEY(\`scope\`, \`key\`)
        );
      `)
      yield* tx.run(`ALTER TABLE \`data_migration\` ADD \`source_fingerprint\` text;`)
      yield* tx.run(`ALTER TABLE \`data_migration\` ADD \`source_version\` text;`)
      yield* tx.run(`ALTER TABLE \`data_migration\` ADD \`row_count\` integer;`)
      yield* tx.run(`ALTER TABLE \`data_migration\` ADD \`time_verified\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
