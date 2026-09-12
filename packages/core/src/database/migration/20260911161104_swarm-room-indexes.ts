import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911161104_swarm-room-indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_room_member_name_idx\` ON \`swarm_room_member\` (\`room_id\`,\`name\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`swarm_room_root_idx\` ON \`swarm_room\` (\`root_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
