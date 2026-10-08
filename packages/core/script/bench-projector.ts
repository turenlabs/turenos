// Drives the real SessionProjector through EventV2 and reports, per durable event, the main-thread time and the
// bytes SQLite appended to the WAL while one assistant message already holds k completed tool parts.
//
//   bun run bench:projector [--counts 10,50,100,200,400] [--output-bytes 2048] [--lifecycles 5]
//
// Not a gating test: it prints numbers and asserts nothing.
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "projector-bench-"))
process.env.FORGE_DB = join(directory, "bench.db")
process.env.XDG_DATA_HOME = join(directory, "share")
process.env.XDG_CACHE_HOME = join(directory, "cache")
process.env.XDG_CONFIG_HOME = join(directory, "config")
process.env.XDG_STATE_HOME = join(directory, "state")

const { DateTime, Effect } = await import("effect")
const { Database } = await import("../src/database/database")
const { LayerNode } = await import("../src/effect/layer-node")
const { AppNodeBuilder } = await import("../src/effect/app-node-builder")
const { EventV2 } = await import("../src/event")
const { ModelV2 } = await import("../src/model")
const { Project } = await import("../src/project")
const { ProjectTable } = await import("../src/project/sql")
const { ProviderV2 } = await import("../src/provider")
const { AbsolutePath } = await import("../src/schema")
const { SessionEvent } = await import("../src/session/event")
const { SessionMessage } = await import("../src/session/message")
const { SessionProjector } = await import("../src/session/projector")
const { SessionSchema } = await import("../src/session/schema")
const { SessionMessageTable, SessionTable } = await import("../src/session/sql")
const { eq } = await import("drizzle-orm")

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}
const counts = argument("counts", "10,50,100,200,400").split(",").map(Number)
const outputBytes = Number(argument("output-bytes", "2048"))
const lifecycles = Number(argument("lifecycles", "5"))
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const output = "x".repeat(outputBytes)
const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]))

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  const db = Database.primary(database.db)
  const events = yield* EventV2.Service
  // Keep every write in the WAL so the file size is the bytes written.
  yield* db.run("PRAGMA wal_autocheckpoint = 0")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  const wal = () => statSync(`${process.env.FORGE_DB}-wal`).size
  let clock = 0
  const timestamp = () => DateTime.makeUnsafe(clock++)

  // The four durable events one tool call costs.
  const lifecycle = (
    sessionID: typeof SessionSchema.ID.Type,
    assistantMessageID: ReturnType<typeof SessionMessage.ID.make>,
    callID: string,
  ) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID,
        name: "bash",
        timestamp: timestamp(),
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        callID,
        text: '{"command":"ls"}',
        timestamp: timestamp(),
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        callID,
        tool: "bash",
        input: { command: "ls" },
        provider: { executed: false },
        timestamp: timestamp(),
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        callID,
        structured: {},
        content: [{ type: "text", text: output }],
        provider: { executed: false },
        timestamp: timestamp(),
      })
    })

  const results = []
  for (const count of counts) {
    const sessionID = SessionSchema.ID.make(`ses_bench_${count}`)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: `bench-${count}`,
        directory: "/project",
        title: "bench",
        version: "bench",
      })
      .run()
    const assistantMessageID = SessionMessage.ID.make(`msg_bench_${count}`)
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: "build",
      model,
      timestamp: timestamp(),
    })
    for (let index = 0; index < count; index++) yield* lifecycle(sessionID, assistantMessageID, `fill_${index}`)
    const walBefore = wal()
    const started = performance.now()
    for (let index = 0; index < lifecycles; index++) yield* lifecycle(sessionID, assistantMessageID, `probe_${index}`)
    const elapsed = performance.now() - started
    const walBytes = wal() - walBefore
    const row = yield* db
      .select({ bytes: SessionMessageTable.data })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
    const durable = lifecycles * 4
    results.push({
      tools: count,
      row_kb: Math.round(JSON.stringify(row?.bytes).length / 1024),
      ms_per_event: Number((elapsed / durable).toFixed(2)),
      wal_kb_per_event: Number((walBytes / durable / 1024).toFixed(1)),
    })
  }
  console.table(results)
})

await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true }))),
  ),
)
