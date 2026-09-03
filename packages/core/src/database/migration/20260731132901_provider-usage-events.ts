import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731132901_provider-usage-events",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`event_type_idx\` ON \`event\` (\`type\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
