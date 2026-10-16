import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const passes = Number(process.argv[2] ?? 3)
if (!Number.isSafeInteger(passes) || passes < 2 || passes > 20) throw new Error("Pass count must be 2..20")
// Resolve all runtime imports only after redirecting every durable path to disposable state.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "team-output-service-"))
await fs.chmod(root, 0o700)
for (const kind of ["DATA", "CONFIG", "STATE", "CACHE"])
  process.env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase())
process.env.FORGE_DB = path.join(root, "runtime.sqlite")
process.env.FORGE_DISABLE_MODELS_FETCH = "true"
process.env.FORGE_MODELS_PATH = path.resolve("test/tool/fixtures/models-api.json")
process.env.FORGE_TEST_KIMI = "0"

try {
  const { Effect } = await import("effect")
  const { eq, sql } = await import("drizzle-orm")
  const { TeamWorkspace } = await import("@turenlabs/core/team/workspace")
  const { TeamMessageTable } = await import("@turenlabs/core/team/workspace.sql")
  const { Database } = await import("@turenlabs/core/database/database")
  const { SessionMessageTable } = await import("@turenlabs/core/session/sql")
  const { recoveryLayer, seedRecoveryTask, recoveryOutputRow } = await import("../test/fixture/team-output-recovery")
  const headProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
  const head = (await new Response(headProcess.stdout).text()).trim()
  if (await headProcess.exited) throw new Error("Cannot resolve source head")
  const harnessSHA256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(import.meta.path).bytes())
    .update(await Bun.file(new URL("../test/fixture/team-output-recovery.ts", import.meta.url)).bytes())
    .digest("hex")
  const identity = {
    head,
    harnessSHA256,
    bun: Bun.version,
    pid: process.pid,
    ppid: process.ppid,
    sessions: 4,
    outputsPerSession: 128,
    toolBytes: 16384,
    concurrency: 4,
    passes,
  }
  const samples: { rss: number; heapUsed: number; external: number; phase: string; elapsedMs: number }[] = []
  const started = performance.now()
  const sample = (phase: string, observationWindowMs = 0) => {
    const value = {
      ...identity,
      utc: new Date().toISOString(),
      phase,
      elapsedMs: performance.now() - started,
      observationWindowMs,
      ...process.memoryUsage(),
    }
    samples.push(value)
    console.log(JSON.stringify(value))
  }
  const fileBytes = async () =>
    (
      await Promise.all(
        ["", "-wal", "-shm"].map((suffix) =>
          fs
            .stat(`${process.env.FORGE_DB}${suffix}`)
            .then((stat) => stat.size)
            .catch(() => 0),
        ),
      )
    ).reduce((sum, size) => sum + size, 0)

  sample("before-setup")
  const fixtures = await Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const fixtures = []
    for (let index = 0; index < identity.sessions; index++) {
      const fixture = yield* seedRecoveryTask(`worker${index}`, identity.outputsPerSession, identity.toolBytes)
      yield* team.finishTask({
        id: fixture.task.id,
        owner: `worker${index}`,
        status: "succeeded",
        text: "Final",
        sourceMessageIDs: [`msg_worker${index}_${identity.outputsPerSession - 1}`],
      })
      fixtures.push(fixture)
    }
    const cancelled = yield* seedRecoveryTask("cancelled", 1, identity.toolBytes)
    yield* team.cancelTask(cancelled.task.id)
    return { tasks: fixtures, cancelled }
  }).pipe(Effect.provide(recoveryLayer(process.env.FORGE_DB)), Effect.scoped, Effect.runPromise)
  sample("setup-complete")
  await Effect.gen(function* () {
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const expected = identity.sessions * identity.outputsPerSession
    const first = performance.now()
    // Building the real TeamRuntime starts its production recovery timer. No provider loop runs.
    while (true) {
      const rows = yield* db.all<{ count: number }>(
        sql`select count(*) as count from team_message where session_id is not null`,
      )
      if (rows[0]!.count === expected) break
      if (performance.now() - first > 20_000)
        return yield* Effect.die(new Error(`Recovery count did not reach ${expected}`))
      yield* Effect.sleep("50 millis")
    }
    sample("warmup-recovered", performance.now() - first)
    for (let pass = 1; pass <= passes; pass++) {
      const begin = performance.now()
      yield* db
        .insert(SessionMessageTable)
        .values(
          fixtures.tasks.map((fixture, index) =>
            recoveryOutputRow(
              fixture.sessionID,
              `worker${index}`,
              identity.outputsPerSession + pass - 1,
              identity.toolBytes,
            ),
          ),
        )
        .run()
      yield* Effect.sleep("31 seconds")
      const rows = yield* db.all<{ count: number }>(
        sql`select count(*) as count from team_message where session_id is not null`,
      )
      if (rows[0]!.count !== expected + identity.sessions * pass)
        return yield* Effect.die(new Error("Recovery missed or duplicated durable output"))
      const cancelled = yield* db
        .select()
        .from(TeamMessageTable)
        .where(eq(TeamMessageTable.session_id, fixtures.cancelled.sessionID))
        .all()
      if (cancelled.length) return yield* Effect.die(new Error("Cancelled output was published"))
      sample(`churn-${pass}`, performance.now() - begin)
    }
    for (let idle = 1; idle <= 3; idle++) {
      yield* Effect.sleep("31 seconds")
      sample(`idle-${idle}`)
    }
  }).pipe(Effect.provide(recoveryLayer(process.env.FORGE_DB, true)), Effect.scoped, Effect.runPromise)
  sample("services-disposed")
  const durableBytes = await fileBytes()
  await fs.rm(root, { recursive: true, force: true })
  await Bun.sleep(1000)
  sample("post-cleanup")
  const idle = samples.filter((value) => value.phase.startsWith("idle-"))
  console.log(
    JSON.stringify({
      ...identity,
      utc: new Date().toISOString(),
      phase: "summary",
      durableBytes,
      peakSampledRSS: Math.max(...samples.map((value) => value.rss)),
      retained: process.memoryUsage(),
      idleRSSSlopeBytesPerSecond:
        (idle.at(-1)!.rss - idle[0]!.rss) / ((idle.at(-1)!.elapsedMs - idle[0]!.elapsedMs) / 1000),
      nativeBytes: null,
      limits:
        "Synthetic projected tool history; real timer, Session decoder and Team publication; no provider execution; sampled peaks; no forced GC; not incident attribution",
    }),
  )
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
