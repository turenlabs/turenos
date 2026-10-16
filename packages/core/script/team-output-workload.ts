import { Database } from "bun:sqlite"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { TeamOutputRecovery } from "../src/team/output-recovery"

export function fixture() {
  const db = new Database(":memory:")
  db.exec(`
    create table session_message (id text primary key, session_id text, type text, seq integer, data text);
    create unique index session_message_session_seq_idx on session_message(session_id, seq);
    create table team_task (id text primary key, session_id text, status text, lease_expires_at integer);
    create table team_message (session_id text, source_key text unique, source_message_ids text);
  `)
  return db
}

export function candidates(db: Database, sessionID: string, after?: number, limit = 100, now = Date.now()) {
  const query = new SQLiteSyncDialect().sqlToQuery(TeamOutputRecovery.candidates({ sessionID, after, limit, now }))
  return db.query<TeamOutputRecovery.Candidate, never[]>(query.sql).all(...(query.params as never[]))
}

export function publish(db: Database, sessionID: string, id: string) {
  db.query("insert or ignore into team_message values (?, ?, ?)").run(
    sessionID,
    `session-output:${sessionID}:${id}`,
    JSON.stringify([id]),
  )
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode !== "baseline" && mode !== "candidate") throw new Error("Expected baseline or candidate")
  const sessions = 4
  const outputs = 256
  const bodyBytes = 64 * 1024
  const passes = 20
  const db = fixture()
  const insert = db.query("insert into session_message values (?, ?, ?, ?, ?)")
  for (let s = 0; s < sessions; s++) {
    const session = `ses_${s}`
    db.query("insert into team_task values (?, ?, 'succeeded', null)").run(`task_${s}`, session)
    insert.run(`msg_team_task_${s}`, session, "user", 0, JSON.stringify({ content: [] }))
    for (let i = 1; i <= outputs; i++) {
      const id = `msg_${s}_${i}`
      insert.run(
        id,
        session,
        "assistant",
        i,
        JSON.stringify({
          time: { completed: 1 },
          finish: "stop",
          content: [{ type: "text", text: "x".repeat(bodyBytes) }],
        }),
      )
      if (i < outputs) publish(db, session, id)
    }
  }
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
  const start = performance.now()
  const samples: ReturnType<typeof process.memoryUsage>[] = []
  const emit = (phase: string, counts = { rowsDecoded: 0, bytesDecoded: 0 }, latencyMs = 0) => {
    const memory = process.memoryUsage()
    samples.push(memory)
    console.log(
      JSON.stringify({
        utc: new Date().toISOString(),
        head,
        bun: Bun.version,
        pid: process.pid,
        mode,
        phase,
        sessions,
        outputsPerSession: outputs,
        bodyBytes,
        concurrency: 1,
        gc: "natural",
        ...counts,
        latencyMs,
        elapsedMs: performance.now() - start,
        ...memory,
      }),
    )
  }
  emit("warmup")
  for (let pass = 0; pass < passes; pass++) {
    const counts = { rowsDecoded: 0, bytesDecoded: 0 }
    const started = performance.now()
    for (let s = 0; s < sessions; s++) {
      const session = `ses_${s}`
      if (mode === "baseline") {
        const rows = db
          .query<
            { id: string; data: string; type: string },
            [string]
          >("select id, data, type from session_message where session_id = ? order by seq")
          .all(session)
        for (const row of rows) {
          JSON.parse(row.data)
          counts.rowsDecoded++
          counts.bytesDecoded += Buffer.byteLength(row.data)
          if (row.type !== "assistant") continue
          // The old recovery also reloads each completed assistant in syncSessionOutput.
          JSON.parse(row.data)
          counts.rowsDecoded++
          counts.bytesDecoded += Buffer.byteLength(row.data)
          publish(db, session, row.id)
        }
      } else {
        let after: number | undefined
        while (true) {
          const page = candidates(db, session, after)
          for (const row of page) {
            if (!row.taskID) continue
            const body = db
              .query<{ data: string }, [string]>("select data from session_message where id = ?")
              .get(row.id)!
            JSON.parse(body.data)
            counts.rowsDecoded++
            counts.bytesDecoded += Buffer.byteLength(body.data)
            publish(db, session, row.id)
          }
          if (page.length < 100) break
          after = page.at(-1)!.seq
        }
      }
    }
    if (mode === "candidate" && counts.rowsDecoded !== (pass === 0 ? sessions : 0))
      throw new Error("Recovery decoded an unexpected number of bodies")
    emit(pass === 0 ? "recover-missed" : `idle-${pass}`, counts, performance.now() - started)
    await Bun.sleep(10)
  }
  db.close()
  await Bun.sleep(100)
  emit("post-cleanup")
  console.log(
    JSON.stringify({
      phase: "summary",
      mode,
      head,
      bun: Bun.version,
      pid: process.pid,
      peakSampledRssBytes: Math.max(...samples.map((x) => x.rss)),
      retainedRssBytes: samples.at(-1)!.rss,
      idleRssSlopeBytesPerPass: (samples.at(-2)!.rss - samples[2].rss) / (passes - 2),
      limits:
        "Synthetic SQLite query/body-decode workload; no provider, schema decode, event loop, cancellation, or production attribution. Natural GC only. Sampled peak excludes intra-pass peaks.",
    }),
  )
}
