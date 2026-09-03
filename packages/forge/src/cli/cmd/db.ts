import type { Argv } from "yargs"
import { spawn } from "child_process"
import { statSync } from "node:fs"
import { Database } from "@turenlabs/core/database/database"
import { Effect } from "effect"
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm"
import { SessionTable } from "@turenlabs/core/session/sql"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { effectCmd, fail } from "../effect-cmd"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

const CompactCommand = effectCmd({
  command: "compact",
  describe: "report or reclaim space held by archived or old sessions",
  instance: (args) => args.apply === true,
  builder: (yargs: Argv) =>
    yargs
      .option("archived", { type: "boolean", describe: "select archived sessions" })
      .option("older-than", { type: "number", describe: "select sessions not updated for this many days" })
      .option("apply", { type: "boolean", describe: "delete selected idle/failed sessions, then VACUUM" }),
  handler: Effect.fn("Cli.db.compact")(function* (args: { archived?: boolean; olderThan?: number; apply?: boolean }) {
    if (args.olderThan !== undefined && (!Number.isFinite(args.olderThan) || args.olderThan < 0)) {
      return yield* fail("--older-than must be a non-negative number of days")
    }
    const hasSelector = args.archived === true || args.olderThan !== undefined
    if (args.apply && !hasSelector) return yield* fail("Refusing to delete without --archived or --older-than")

    const { db } = yield* Database.Service
    const databasePath = Database.path()
    const fileSize = statSync(databasePath).size
    const page = yield* db
      .get<{
        pageCount: number
        pageSize: number
        freelist: number
      }>(
        sql`select page_count as pageCount, page_size as pageSize, freelist_count as freelist from pragma_page_count(), pragma_page_size(), pragma_freelist_count()`,
      )
      .pipe(Effect.orDie)
    const tables = yield* db
      .all<{
        name: string
        bytes: number
      }>(sql`select name, sum(pgsize) as bytes from dbstat group by name order by bytes desc limit 12`)
      .pipe(Effect.orDie)
    const events = yield* db
      .all<{
        type: string
        count: number
        bytes: number
      }>(
        sql`select type, count(*) as count, sum(length(data)) as bytes from event group by type order by bytes desc limit 12`,
      )
      .pipe(Effect.orDie)

    const conditions = [or(eq(SessionTable.status, "idle"), eq(SessionTable.status, "failed"))]
    if (args.archived) conditions.push(isNotNull(SessionTable.time_archived))
    if (args.olderThan !== undefined)
      conditions.push(lt(SessionTable.time_updated, Date.now() - args.olderThan * 86_400_000))
    const candidates = hasSelector
      ? yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(and(...conditions))
          .all()
          .pipe(Effect.orDie)
      : []
    // Only remove leaves. `Session.removeCoordinated` recursively removes a
    // tree, so selecting a parent could otherwise remove an active descendant
    // that never matched this command's idle/failed safety predicate.
    const parentRows = hasSelector
      ? yield* db
          .select({ parentID: SessionTable.parent_id })
          .from(SessionTable)
          .where(isNotNull(SessionTable.parent_id))
          .all()
          .pipe(Effect.orDie)
      : []
    const parents = new Set(parentRows.map((row) => row.parentID))
    const selected = candidates.filter((row) => !parents.has(row.id))
    const skipped = hasSelector
      ? yield* db
          .select({ status: SessionTable.status, count: sql<number>`count(*)` })
          .from(SessionTable)
          .where(
            and(
              ...(args.archived ? [isNotNull(SessionTable.time_archived)] : []),
              ...(args.olderThan === undefined
                ? []
                : [lt(SessionTable.time_updated, Date.now() - args.olderThan * 86_400_000)]),
            ),
          )
          .groupBy(SessionTable.status)
          .all()
          .pipe(Effect.orDie)
      : []
    const selectedIDs = selected.map((row) => row.id)
    const estimated =
      selectedIDs.length === 0
        ? 0
        : ((yield* db
            .get<{ bytes: number }>(
              sql`
              select coalesce(sum(length(data)), 0) as bytes
              from event
              where aggregate_id in (${sql.join(
                selectedIDs.map((id) => sql`${id}`),
                sql`, `,
              )})
            `,
            )
            .pipe(Effect.orDie))?.bytes ?? 0)

    console.log(`Database: ${formatBytes(fileSize)} (${page?.pageCount ?? 0} pages, ${page?.freelist ?? 0} free)`)
    console.log("Largest tables and indexes:")
    for (const row of tables) console.log(`  ${row.name}: ${formatBytes(row.bytes)}`)
    console.log("Largest event payloads:")
    for (const row of events) console.log(`  ${row.type}: ${row.count} rows, ${formatBytes(row.bytes)}`)
    if (!hasSelector) {
      console.log(
        "No selector supplied. This is report-only; use --archived and/or --older-than <days> to plan cleanup.",
      )
      return
    }
    const skippedBusy = skipped.filter((row) => row.status !== "idle" && row.status !== "failed")
    console.log(`Selected: ${selected.length} idle/failed sessions, about ${formatBytes(estimated)} of event payloads`)
    if (skippedBusy.length > 0)
      console.log(`Skipped active sessions: ${skippedBusy.map((row) => `${row.count} ${row.status}`).join(", ")}`)
    if (!args.apply) {
      console.log("Dry run only. Re-run with --apply to delete the selected sessions and VACUUM the database.")
      return
    }

    const sessions = yield* Session.Service
    yield* Effect.forEach(
      selected,
      (row) =>
        sessions
          .removeCoordinated({
            sessionID: SessionID.make(row.id),
            interrupt: () => Effect.void,
            // Selection is intentionally rechecked at the destructive boundary,
            // not only while the dry-run plan is built. A prompt can arrive in
            // the time between those two operations.
            beforeRemove: db
              .select({ status: SessionTable.status })
              .from(SessionTable)
              .where(eq(SessionTable.id, row.id))
              .get()
              .pipe(
                Effect.flatMap((current) => {
                  if (current?.status === "idle" || current?.status === "failed") return Effect.void
                  return Effect.die(new Error(`Session ${row.id} became active during cleanup`))
                }),
              ),
          })
          .pipe(Effect.orDie),
      { concurrency: 1, discard: true },
    )
    yield* db.run(sql`VACUUM`).pipe(Effect.orDie)
    console.log(`Reclaimed ${formatBytes(Math.max(0, fileSize - statSync(databasePath).size))}`)
  }),
})

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`
  if (value < 1_024 * 1_024 * 1_024) return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`
  return `${(value / (1_024 * 1_024 * 1_024)).toFixed(2)} GiB`
}

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(CompactCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
