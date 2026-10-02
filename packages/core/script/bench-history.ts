// Measures SessionHistory row-decode cost against a real database file: cold read, warm
// (decode-cache) read, and the toLLMMessages lowering pass, for the largest sessions found.
//
//   FORGE_DB=/path/to/forge.db bun run script/bench-history.ts [--sessions 5]
//
// Not a gating test: it prints numbers and asserts nothing.
import { copyFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}
const source = argument("db", process.env.FORGE_DB ?? "/tmp/forge-dev-snapshot.db")
const topN = Number(argument("sessions", "5"))

// Open a throwaway copy: the Database layer checkpoints WAL on close and we only read.
const scratch = join(tmpdir(), `bench-history-${Date.now()}.db`)
if (!existsSync(source)) {
  console.error(`database not found: ${source}`)
  process.exit(1)
}
copyFileSync(source, scratch)
process.env.FORGE_DB = scratch

const { Effect } = await import("effect")
const { sql } = await import("drizzle-orm")
const { Database } = await import("../src/database/database")
const { AppNodeBuilder } = await import("../src/effect/app-node-builder")
const { LayerNode } = await import("../src/effect/layer-node")
const { SessionHistory } = await import("../src/session/history")
const { SessionSchema } = await import("../src/session/schema")
const { toLLMMessages } = await import("../src/session/runner/to-llm-message")
const { ModelV2 } = await import("../src/model")
const { ProviderV2 } = await import("../src/provider")

const layer = AppNodeBuilder.build(LayerNode.group([Database.node]))
const model = {
  id: ModelV2.ID.make("bench-model"),
  provider: ProviderV2.ID.make("bench-provider"),
} as never

const program = Effect.gen(function* () {
  const db = Database.primary((yield* Database.Service).db)
  const sessions = yield* db
    .all<{ session_id: string; n: number; bytes: number }>(
      sql`SELECT session_id, COUNT(*) n, SUM(LENGTH(data)) bytes
          FROM session_message GROUP BY session_id ORDER BY n DESC LIMIT ${topN}`,
    )
    .pipe(Effect.orDie)

  for (const row of sessions) {
    const sessionID = SessionSchema.ID.make(row.session_id)
    const before = { ...SessionHistory.decodeStats }

    let t0 = performance.now()
    const cold = yield* SessionHistory.entries(db, sessionID)
    const coldMs = performance.now() - t0

    t0 = performance.now()
    const warm = yield* SessionHistory.entries(db, sessionID)
    const warmMs = performance.now() - t0

    t0 = performance.now()
    const lowered = toLLMMessages(
      warm.map((entry) => entry.message),
      model,
    )
    const lowerMs = performance.now() - t0

    const hits = SessionHistory.decodeStats.hits - before.hits
    const misses = SessionHistory.decodeStats.misses - before.misses
    console.log(
      `${row.session_id.slice(0, 24)}  rows=${row.n}  json=${(row.bytes / 1048576).toFixed(1)}MB  ` +
        `cold=${coldMs.toFixed(0)}ms  warm=${warmMs.toFixed(0)}ms  lower=${lowerMs.toFixed(0)}ms  ` +
        `decodes=${misses} hits=${hits}  llmMsgs=${lowered.length}`,
    )
  }
})

await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer)))).finally(() =>
  import("node:fs").then((fs) => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${scratch}${suffix}`, { force: true })
      } catch {}
    }
  }),
)
