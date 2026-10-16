import fs from "node:fs/promises"
import assert from "node:assert/strict"
import { isolateWorkload } from "./team-output-isolation"

const passes = Number(process.argv[2] ?? 3)
if (!Number.isSafeInteger(passes) || passes < 2 || passes > 20) throw new Error("Pass count must be 2..20")
const idleDurationMs = Number(process.argv[3] ?? 93_000)
const sampleIntervalMs = Number(process.argv[4] ?? 5_000)
if (!Number.isSafeInteger(idleDurationMs) || idleDurationMs < 1_000 || idleDurationMs > 3_600_000)
  throw new Error("Idle duration must be 1000..3600000 milliseconds")
if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 100 || sampleIntervalMs > idleDurationMs / 2)
  throw new Error("Sample interval must be 100 milliseconds through half the idle duration")
const toolBytes = Number(process.argv[5] ?? 16384)
const outputsPerSession = Number(process.argv[6] ?? 128)
const cleanupIdleMs = Number(process.argv[7] ?? 1000)
if (!Number.isSafeInteger(toolBytes) || toolBytes < 64 || toolBytes > 65536)
  throw new Error("Tool bytes must be 64..65536")
if (!Number.isSafeInteger(outputsPerSession) || outputsPerSession < 1 || outputsPerSession > 256)
  throw new Error("Outputs per Session must be 1..256")
if (!Number.isSafeInteger(cleanupIdleMs) || cleanupIdleMs < 1000 || cleanupIdleMs > 180000)
  throw new Error("Cleanup idle must be 1000..180000 milliseconds")
if (process.env.NODE_ENV !== "test") throw new Error("Use NODE_ENV=test with disposable state only")
// Resolve all runtime imports only after redirecting every durable path to disposable state.
const root = await isolateWorkload("team-output-service-")
const periodic = { timer: undefined as ReturnType<typeof setInterval> | undefined }

try {
  const scratch = await fs.lstat(root)
  console.log(JSON.stringify({
    phase: "scratch-created", pid: process.pid,
    scratch: { root, dev: scratch.dev, ino: scratch.ino, uid: scratch.uid },
  }))
  const { Effect } = await import("effect")
  const { eq, sql } = await import("drizzle-orm")
  const { TeamWorkspace } = await import("@turenlabs/core/team/workspace")
  const { TeamMessageTable } = await import("@turenlabs/core/team/workspace.sql")
  const { Database } = await import("@turenlabs/core/database/database")
  const { SessionMessageTable } = await import("@turenlabs/core/session/sql")
  const { recoveryLayer, seedRecoveryTask, recoveryOutputRow } = await import("../test/fixture/team-output-recovery")
  const headProcess = Bun.spawn(["/usr/bin/git", "rev-parse", "HEAD"], { env: process.env, stdout: "pipe", stderr: "ignore" })
  const head = (await new Response(headProcess.stdout).text()).trim()
  if (await headProcess.exited) throw new Error("Cannot resolve source head")
  const harnessSHA256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(import.meta.path).bytes())
    .update(await Bun.file(new URL("./team-output-isolation.ts", import.meta.url)).bytes())
    .update(await Bun.file(new URL("../test/fixture/team-output-recovery.ts", import.meta.url)).bytes())
    .digest("hex")
  const identity = {
    head,
    harnessSHA256,
    bun: Bun.version,
    pid: process.pid,
    ppid: process.ppid,
    sessions: 4,
    outputsPerSession,
    toolBytes,
    concurrency: 4,
    passes,
    idleDurationMs,
    sampleIntervalMs,
    cleanupIdleMs,
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
  periodic.timer = setInterval(() => sample("periodic"), sampleIntervalMs)
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
  const recoveryLatenciesMs: number[] = []
  const counts = { recovered: 0, historyRows: 0, historyBytes: 0, toolBytes: 0, publishedBytes: 0 }
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
    recoveryLatenciesMs.push(performance.now() - first)
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
      while (true) {
        const rows = yield* db.all<{ count: number }>(
          sql`select count(*) as count from team_message where session_id is not null`,
        )
        if (rows[0]!.count === expected + identity.sessions * pass) break
        if (rows[0]!.count > expected + identity.sessions * pass || performance.now() - begin > 35000)
          return yield* Effect.die(new Error("Recovery missed or duplicated durable output"))
        yield* Effect.sleep("50 millis")
      }
      const cancelled = yield* db
        .select()
        .from(TeamMessageTable)
        .where(eq(TeamMessageTable.session_id, fixtures.cancelled.sessionID))
        .all()
      if (cancelled.length) return yield* Effect.die(new Error("Cancelled output was published"))
      recoveryLatenciesMs.push(performance.now() - begin)
      sample(`churn-${pass}`, performance.now() - begin)
    }
    const history = yield* db.all<{ rows: number; bytes: number; toolBytes: number }>(sql`
      select count(*) as rows, sum(length(cast(data as blob))) as bytes,
        sum(length(json_extract(data, '$.content[0].state.content[0].text'))) as toolBytes
      from session_message where type = 'assistant'
    `)
    const published = yield* db.all<{ rows: number; bytes: number }>(sql`
      select count(*) as rows, sum(length(cast(text as blob))) as bytes
      from team_message where session_id is not null
    `)
    counts.recovered = published[0]!.rows
    counts.historyRows = history[0]!.rows
    counts.historyBytes = history[0]!.bytes
    counts.toolBytes = history[0]!.toolBytes
    counts.publishedBytes = published[0]!.bytes
    assert.equal(counts.recovered, identity.sessions * (identity.outputsPerSession + passes))
    assert.equal(counts.historyRows, counts.recovered + 1)
    assert.equal(counts.toolBytes, counts.historyRows * identity.toolBytes)
    assert.ok(counts.historyBytes > counts.toolBytes)
    const idleStarted = performance.now()
    sample("idle-0")
    while (performance.now() - idleStarted < idleDurationMs) {
      yield* Effect.sleep(Math.min(sampleIntervalMs, idleDurationMs - (performance.now() - idleStarted)))
      sample(`idle-${samples.filter((value) => value.phase.startsWith("idle-")).length}`)
    }
  }).pipe(Effect.provide(recoveryLayer(process.env.FORGE_DB, true)), Effect.scoped, Effect.runPromise)
  sample("services-disposed")
  const durableBytes = await fileBytes()
  await fs.rm(root, { recursive: true, force: true })
  sample("post-cleanup")
  const cleanupStarted = performance.now()
  while (performance.now() - cleanupStarted < cleanupIdleMs) {
    await Bun.sleep(Math.min(sampleIntervalMs, cleanupIdleMs - (performance.now() - cleanupStarted)))
    sample("cleanup-idle")
  }
  clearInterval(periodic.timer)
  const idle = samples.filter((value) => value.phase.startsWith("idle-"))
  const cleanup = samples.filter((value) => value.phase === "cleanup-idle" || value.phase === "post-cleanup")
  console.log(
    JSON.stringify({
      ...identity,
      utc: new Date().toISOString(),
      phase: "summary",
      durableBytes,
      counts,
      recoveryLatenciesMs,
      scratchRemoved: !(await fs.stat(root).then(() => true, () => false)),
      peakSampledRSS: Math.max(...samples.map((value) => value.rss)),
      retained: process.memoryUsage(),
      idleRSSSlopeBytesPerSecond:
        (idle.at(-1)!.rss - idle[0]!.rss) / ((idle.at(-1)!.elapsedMs - idle[0]!.elapsedMs) / 1000),
      cleanupRSSSlopeBytesPerSecond:
        (cleanup.at(-1)!.rss - cleanup[0]!.rss) / ((cleanup.at(-1)!.elapsedMs - cleanup[0]!.elapsedMs) / 1000),
      nativeBytes: null,
      limits:
        "Synthetic projected tool history; real timer, Session decoder and Team publication; no provider execution; sampled peaks; no forced GC; not incident attribution",
    }),
  )
} finally {
  clearInterval(periodic.timer)
  await fs.rm(root, { recursive: true, force: true })
}
