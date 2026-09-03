export * as Retention from "./retention"

import path from "path"
import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Config } from "./config"
import { ConfigRetention } from "./config/retention"
import { Database } from "./database/database"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode } from "./effect/app-node"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { ToolExecutionTable, type StoredSettlement } from "./tool/execution.sql"
import { boundedPreview } from "./tool-output-store"
import type { SessionMessage } from "./session/message"

//
// -- Why this never touches the event log --------------------------------------------------------
//
// `event` rows are the durable, append-only source of truth. `commitDurableEvent` re-reads the
// stored row on any stale replay and `Effect.die`s with "Replay diverged" unless the whole `data`
// payload is deep-equal to what the peer sent (`event.ts:264-292`), and `/sync/history` ships those
// rows between instances verbatim. Truncating one would therefore poison replay in both directions,
// permanently and undetectably: the instance that already holds the original bytes can never accept
// ours again, and vice versa. It is also a defect rather than a typed error, so it kills the
// workspace sync fiber rather than being caught.
//
// So this policy rewrites only the two *derived* copies of the same bytes: `session_message.data`
// (the transcript projection) and `tool_execution.settlement` (the resume/dedup ledger). Neither is
// re-materialized from events after the fact -- the stale-replay branch above returns before any
// projector runs, so a replay of an event we already hold cannot undo a truncation. Two of the three
// stored copies is the whole safe saving, and the event log stays byte-exact forever.
//
// The consequence to be honest about: `session_message.data` is what `session/history.ts` lowers
// into a provider request, so truncating it does change what the model would see if that session
// were resumed. That is the intent -- it is the same substitution `compaction.pruneEntries` already
// performs at read time -- but it is why both windows default to weeks rather than days, and why
// `time.pruned`-style readability is preserved: the preview keeps the head and tail of what was
// there rather than replacing it with a bare sentinel.
//

/** Milliseconds in a day. Retention windows are configured in days and compared against epoch millis. */
const DAY = 24 * 60 * 60 * 1000

/**
 * Preview budget for a truncated payload.
 *
 * Deliberately far below `ToolOutputStore`'s 2000 lines / 50 KB. Every stored payload has *already*
 * passed through `bound` at publish time, so a retention pass that reused those limits would find
 * almost nothing over budget and reclaim nothing. 20 lines and 2 KB takes a capped 50 KB payload
 * down by ~96% while still showing what the call produced and how it ended.
 */
export const PREVIEW_MAX_LINES = 20
export const PREVIEW_MAX_BYTES = 2_000

/** Only input fields past this size are cleared; paths, flags, and small values always survive. */
export const INPUT_FIELD_MIN_CHARS = 2_000

export const TOOL_MARKER = "... older tool output removed by retention policy ..."
export const SHELL_MARKER = "... older shell output removed by retention policy ..."
export const INPUT_REMOVED_TEXT = "[Tool input removed by retention policy]"

/** Rows rewritten per transaction. Bounded so a sweep never holds the write lock for long. */
const BATCH = 200

/** How often the background sweep runs. Retention windows are measured in days; hours is plenty. */
export const INTERVAL = Duration.hours(6)

export interface Settings {
  /** Days after archiving before an archived session's payloads are reduced. `0` disables. */
  readonly archivedSessionDays: number
  /** Days a stored tool payload is kept in full in any session. `0` disables. */
  readonly toolOutputDays: number
}

export interface Report {
  readonly messages: number
  readonly executions: number
  /** Bytes of stored JSON this pass removed, as measured before and after each rewrite. */
  readonly bytes: number
}

const EMPTY: Report = { messages: 0, executions: 0, bytes: 0 }

export interface Interface {
  /** Effective policy, folded from the global config with defaults and clamps applied. */
  readonly settings: () => Effect.Effect<Settings>
  /** Applies the policy once. `override` runs a specific window without touching the config. */
  readonly sweep: (override?: Partial<Settings>) => Effect.Effect<Report>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Retention") {}

//
// -- Policy resolution ---------------------------------------------------------------------------
//

const clamp = (value: number) => Math.min(Math.max(Math.trunc(value), 0), ConfigRetention.MAX_DAYS)

/**
 * Defaults applied, then clamped -- never range-checked in the schema.
 *
 * `Config.decodeDocument` drops any document it cannot decode, so a bounded `Schema` range on a
 * user-facing value would silently delete the rest of the user's config on a typo.
 */
export function resolve(configured: Partial<Settings> | undefined): Settings {
  return {
    archivedSessionDays: clamp(configured?.archivedSessionDays ?? ConfigRetention.DEFAULT_ARCHIVED_SESSION_DAYS),
    toolOutputDays: clamp(configured?.toolOutputDays ?? ConfigRetention.DEFAULT_TOOL_OUTPUT_DAYS),
  }
}

/**
 * Epoch millis before which a row is eligible, or `undefined` when the window is disabled.
 *
 * `0` is the explicit "never" and is the only value that disables a window, which is why this
 * returns `undefined` rather than a cutoff of `now`: a disabled policy must contribute no SQL
 * predicate at all, not one that happens to match nothing today.
 */
export function cutoff(days: number, now: number): number | undefined {
  return days <= 0 ? undefined : now - days * DAY
}

//
// -- Payload rewriting ---------------------------------------------------------------------------
//

/** Bytes a value occupies once stored as JSON -- the only quantity this policy is trying to reduce. */
export function bytes(value: unknown): number {
  const json = JSON.stringify(value)
  return json === undefined ? 0 : Buffer.byteLength(json, "utf-8")
}

/**
 * A `session_message.data` blob as this module treats it.
 *
 * Deliberately an open record rather than the encoded message union: `Omit<Message["Encoded"], …>`
 * collapses a union to its common keys, so the drizzle column type cannot see `content` or `output`
 * at all. Every rewrite here spreads the original and replaces named fields, so no unmodelled key is
 * ever lost -- which is the property that matters, not whether TypeScript can name them.
 */
type StoredData = Record<string, unknown>

type ToolStateEncoded = (typeof SessionMessage.ToolState)["Encoded"]
type SettledState = Extract<ToolStateEncoded, { readonly status: "completed" | "error" }>
type AssistantContentEncoded = (typeof SessionMessage.AssistantContent)["Encoded"]

/** Text a stored payload carries, serialized the same way `ToolOutputStore.bound` serialized it. */
function payloadText(state: SettledState): string {
  const text = state.content
    .filter((item): item is Extract<typeof item, { readonly type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("")
  if (text) return text
  return JSON.stringify(state.structured, null, 2) ?? ""
}

/** Oversized string fields become the sentinel; paths, flags, and small values survive. */
export function truncateToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([field, value]) => [
      field,
      typeof value === "string" && value.length > INPUT_FIELD_MIN_CHARS ? INPUT_REMOVED_TEXT : value,
    ]),
  )
}

export interface RewriteOptions {
  /** Also clear oversized tool *inputs*. Only the archived-session window does this. */
  readonly pruneInputs: boolean
  readonly maxLines?: number
  readonly maxBytes?: number
}

/**
 * Preview form of a settled tool payload, or `undefined` when rewriting would not save anything.
 *
 * The `undefined` return is what makes a sweep idempotent and cheap: a payload already at or below
 * the preview budget is left completely alone, so re-running the job rewrites nothing and the second
 * pass over a swept database performs no writes at all.
 */
export function truncateToolState(state: ToolStateEncoded, options: RewriteOptions): ToolStateEncoded | undefined {
  if (state.status !== "completed" && state.status !== "error") return undefined
  const maxLines = options.maxLines ?? PREVIEW_MAX_LINES
  const maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES
  const input = options.pruneInputs ? truncateToolInput(state.input) : state.input
  const preview = boundedPreview(payloadText(state), TOOL_MARKER, maxLines, maxBytes)
  // `content` must stay non-empty: an empty one makes `ToolOutput.toResultValue` fall back to
  // `structured` and ship the entire payload that was just cleared. `attachments` and `result` are
  // the other two carriers of the same bytes and go with it; `outputPaths` are paths, not content,
  // and other readers still resolve them.
  const next: ToolStateEncoded =
    state.status === "completed"
      ? {
          status: "completed",
          input,
          content: [{ type: "text", text: preview }],
          structured: {},
          ...(state.outputPaths === undefined ? {} : { outputPaths: state.outputPaths }),
        }
      : {
          status: "error",
          input,
          content: [{ type: "text", text: preview }],
          structured: {},
          error: state.error,
        }
  return bytes(next) < bytes(state) ? next : undefined
}

/**
 * Rewrites the tool payloads inside one stored assistant message.
 *
 * Assistant *text* and reasoning are never touched -- they are what makes the transcript still read
 * after a sweep, and they are a rounding error next to the payloads.
 */
export function truncateAssistantData(data: StoredData, options: RewriteOptions): StoredData | undefined {
  const content = data["content"]
  if (!Array.isArray(content)) return undefined
  let changed = false
  const next = (content as ReadonlyArray<AssistantContentEncoded>).map((item) => {
    if (item.type !== "tool") return item
    const state = truncateToolState(item.state, options)
    if (!state) return item
    changed = true
    return { ...item, state }
  })
  return changed ? { ...data, content: next } : undefined
}

/** Reduces a stored shell transcript's captured output to the same preview form. */
export function truncateShellData(data: StoredData, options: RewriteOptions): StoredData | undefined {
  const output = data["output"]
  if (typeof output !== "string") return undefined
  const preview = boundedPreview(
    output,
    SHELL_MARKER,
    options.maxLines ?? PREVIEW_MAX_LINES,
    options.maxBytes ?? PREVIEW_MAX_BYTES,
  )
  if (Buffer.byteLength(preview, "utf-8") >= Buffer.byteLength(output, "utf-8")) return undefined
  return { ...data, output: preview, truncated: true }
}

/** Dispatches on the `session_message.type` column, which is the only reliable discriminator. */
export function truncateMessageData(
  type: SessionMessage.Type,
  data: StoredData,
  options: RewriteOptions,
): StoredData | undefined {
  if (type === "assistant") return truncateAssistantData(data, options)
  if (type === "shell") return truncateShellData(data, options)
  return undefined
}

/**
 * Preview form of a stored settlement.
 *
 * The shape is preserved rather than nulled. `restoreSettlement` degrades a row carrying neither
 * `result` nor `output` to "outcome is indeterminate", and `claim` treats a NULL `settlement` the
 * same way, so emptying the column would turn a completed call into an error if anything ever did
 * read it back. Shrinking `output` in place keeps every one of those paths behaving exactly as
 * before, just over fewer bytes.
 */
export function truncateSettlement(
  settlement: StoredSettlement,
  options: RewriteOptions,
): StoredSettlement | undefined {
  const output = settlement.output
  if (!output) return undefined
  const text = output.content
    .filter((item): item is Extract<typeof item, { readonly type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("")
  const preview = boundedPreview(
    text || (JSON.stringify(output.structured, null, 2) ?? ""),
    TOOL_MARKER,
    options.maxLines ?? PREVIEW_MAX_LINES,
    options.maxBytes ?? PREVIEW_MAX_BYTES,
  )
  // `result` is derived from `output` by `restoreSettlement`, so a row that has one must not keep a
  // stale full-size copy of the other. Dropping it here is exactly what `persistableSettlement` does.
  const { result: _result, ...rest } = settlement
  const next: StoredSettlement = {
    ...rest,
    output: { structured: {}, content: [{ type: "text", text: preview }] },
  }
  return bytes(next) < bytes(settlement) ? next : undefined
}

//
// -- Service -------------------------------------------------------------------------------------
//

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)

    /**
     * Reads the policy from the *global* config only.
     *
     * There is one database, so there is one retention policy; a per-project override would be
     * ambiguous about which project's window governs a shared row. This is also exactly the file the
     * desktop settings panel writes through `PATCH /global/config`. Re-read on every sweep rather
     * than captured at layer construction so an edit takes effect on the next pass.
     */
    const settings = Effect.fn("Retention.settings")(function* () {
      let configured: ConfigRetention.Info | undefined
      for (const name of Config.NAMES) {
        const text = yield* fs
          .readFileStringSafe(path.join(global.config, name))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!text) continue
        const document = Config.decodeDocument(text, path.join(global.config, name))
        if (document?.info.retention !== undefined) configured = document.info.retention
      }
      return resolve(configured)
    })

    const sweepMessages = Effect.fn("Retention.sweepMessages")(function* (
      toolCutoff: number | undefined,
      archivedCutoff: number | undefined,
    ) {
      if (toolCutoff === undefined && archivedCutoff === undefined) return EMPTY
      // A session whose archive window has elapsed gives up every payload it holds, at any age.
      // A session that has not gives up only tool payloads older than the tool window.
      const archived =
        archivedCutoff === undefined
          ? undefined
          : and(isNotNull(SessionTable.time_archived), lt(SessionTable.time_archived, archivedCutoff))
      const stale =
        toolCutoff === undefined
          ? undefined
          : and(eq(SessionMessageTable.type, "assistant"), lt(SessionMessageTable.time_created, toolCutoff))
      const eligible = archived && stale ? or(archived, stale) : (archived ?? stale)

      let messages = 0
      let saved = 0
      let after: SessionMessage.ID | undefined
      for (;;) {
        // Keyset paging on the primary key: rewritten rows still satisfy `eligible`, so an OFFSET
        // walk would revisit them, and a cursor is stable against concurrent inserts either way.
        const rows = yield* db
          .select({
            id: SessionMessageTable.id,
            type: SessionMessageTable.type,
            data: SessionMessageTable.data,
            updated: SessionMessageTable.time_updated,
            archivedAt: SessionTable.time_archived,
          })
          .from(SessionMessageTable)
          .innerJoin(SessionTable, eq(SessionTable.id, SessionMessageTable.session_id))
          .where(
            and(
              inArray(SessionMessageTable.type, ["assistant", "shell"]),
              eligible,
              after === undefined ? undefined : gt(SessionMessageTable.id, after),
            ),
          )
          .orderBy(asc(SessionMessageTable.id))
          .limit(BATCH)
          .pipe(Effect.orDie)
        if (rows.length === 0) break
        after = rows[rows.length - 1]!.id

        const rewrites = rows.flatMap((row) => {
          const isArchived = archivedCutoff !== undefined && row.archivedAt !== null && row.archivedAt < archivedCutoff
          // Shell output is only ever reclaimed for archived sessions: it is the user's own
          // transcript of a command they ran, not a tool payload the agent generated.
          if (!isArchived && row.type !== "assistant") return []
          const data = truncateMessageData(row.type, row.data, { pruneInputs: isArchived })
          if (data === undefined) return []
          return [{ row, data: data as typeof row.data, saved: bytes(row.data) - bytes(data) }]
        })
        if (rewrites.length === 0) continue

        const applied = yield* db
          .transaction(
            () =>
              Effect.forEach(rewrites, (rewrite) =>
                db
                  .update(SessionMessageTable)
                  // `time_updated` is carried through explicitly to defeat drizzle's `$onUpdate`.
                  // A retention pass is maintenance, not activity, and must not make every idle
                  // session look freshly touched.
                  .set({ data: rewrite.data, time_updated: rewrite.row.updated })
                  .where(
                    and(
                      eq(SessionMessageTable.id, rewrite.row.id),
                      // A projector may have advanced this message while its preview was encoded.
                      eq(SessionMessageTable.time_updated, rewrite.row.updated),
                      eq(SessionMessageTable.data, rewrite.row.data),
                    ),
                  )
                  .returning({ id: SessionMessageTable.id })
                  .get()
                  .pipe(Effect.map((row) => (row ? rewrite : undefined))),
              ),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        const committed = applied.flatMap((rewrite) => (rewrite ? [rewrite] : []))
        messages += committed.length
        saved += committed.reduce((total, rewrite) => total + rewrite.saved, 0)
      }
      return { messages, executions: 0, bytes: saved } satisfies Report
    })

    const sweepExecutions = Effect.fn("Retention.sweepExecutions")(function* (toolCutoff: number | undefined) {
      if (toolCutoff === undefined) return EMPTY
      let executions = 0
      let saved = 0
      let after: { session: string; message: string; call: string } | undefined
      for (;;) {
        // `completed` only. A `running` or `indeterminate` row may still be claimed or resumed, and
        // the ledger is the only place that outcome exists. The lease is an hour, so any row this
        // window can reach is long past being resumable -- but the status check is what guarantees
        // it rather than the arithmetic.
        const rows = yield* db
          .select({
            session: ToolExecutionTable.session_id,
            message: ToolExecutionTable.assistant_message_id,
            call: ToolExecutionTable.call_id,
            settlement: ToolExecutionTable.settlement,
            updated: ToolExecutionTable.time_updated,
          })
          .from(ToolExecutionTable)
          .where(
            and(
              eq(ToolExecutionTable.status, "completed"),
              isNotNull(ToolExecutionTable.settlement),
              lt(ToolExecutionTable.time_updated, toolCutoff),
              // Row-value cursor over the whole primary key. `call_id` alone is provider-supplied
              // and not unique across sessions, so a single-column cursor could step over the rest
              // of a group that straddles a batch boundary and silently skip those rows.
              after === undefined
                ? undefined
                : sql`(${ToolExecutionTable.session_id}, ${ToolExecutionTable.assistant_message_id}, ${ToolExecutionTable.call_id}) > (${after.session}, ${after.message}, ${after.call})`,
            ),
          )
          .orderBy(
            asc(ToolExecutionTable.session_id),
            asc(ToolExecutionTable.assistant_message_id),
            asc(ToolExecutionTable.call_id),
          )
          .limit(BATCH)
          .pipe(Effect.orDie)
        if (rows.length === 0) break
        const last = rows[rows.length - 1]!
        after = { session: last.session, message: last.message, call: last.call }

        const rewrites = rows.flatMap((row) => {
          if (!row.settlement) return []
          const settlement = truncateSettlement(row.settlement, { pruneInputs: false })
          if (!settlement) return []
          return [{ row, observed: row.settlement, settlement, saved: bytes(row.settlement) - bytes(settlement) }]
        })
        if (rewrites.length === 0) continue

        const applied = yield* db
          .transaction(
            () =>
              Effect.forEach(rewrites, (rewrite) =>
                db
                  .update(ToolExecutionTable)
                  .set({ settlement: rewrite.settlement, time_updated: rewrite.row.updated })
                  .where(
                    and(
                      eq(ToolExecutionTable.session_id, rewrite.row.session),
                      eq(ToolExecutionTable.assistant_message_id, rewrite.row.message),
                      eq(ToolExecutionTable.call_id, rewrite.row.call),
                      // Do not replace a settlement changed by another process's maintenance pass.
                      eq(ToolExecutionTable.time_updated, rewrite.row.updated),
                      eq(ToolExecutionTable.settlement, rewrite.observed),
                    ),
                  )
                  .returning({ call: ToolExecutionTable.call_id })
                  .get()
                  .pipe(Effect.map((row) => (row ? rewrite : undefined))),
              ),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        const committed = applied.flatMap((rewrite) => (rewrite ? [rewrite] : []))
        executions += committed.length
        saved += committed.reduce((total, rewrite) => total + rewrite.saved, 0)
      }
      return { messages: 0, executions, bytes: saved } satisfies Report
    })

    const sweep = Effect.fn("Retention.sweep")(function* (override?: Partial<Settings>) {
      const resolved = { ...(yield* settings()), ...override }
      const now = Date.now()
      const toolCutoff = cutoff(resolved.toolOutputDays, now)
      const archivedCutoff = cutoff(resolved.archivedSessionDays, now)
      if (toolCutoff === undefined && archivedCutoff === undefined) return EMPTY
      const fromMessages = yield* sweepMessages(toolCutoff, archivedCutoff)
      const fromExecutions = yield* sweepExecutions(toolCutoff)
      const report = {
        messages: fromMessages.messages,
        executions: fromExecutions.executions,
        bytes: fromMessages.bytes + fromExecutions.bytes,
      } satisfies Report
      if (report.messages > 0 || report.executions > 0) yield* Effect.logInfo("retention swept", report)
      return report
    })

    return Service.of({ settings, sweep })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, FSUtil.node, Global.node] })

/**
 * Runs the sweep on a global schedule rather than once per active Location.
 *
 * There is a single database behind every Location, so a per-Location sweep would be N processes
 * rewriting the same rows. Follows `ToolOutputStore.cleanupLayer`, including running once at
 * startup: a user who has just lowered their retention window should not wait six hours to see it
 * take effect.
 */
export const sweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const retention = yield* Service
    yield* retention.sweep().pipe(
      Effect.catchCause((cause) => Effect.logError("retention sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(INTERVAL)),
      Effect.forkScoped,
    )
  }),
)

export const sweepNode = makeGlobalNode({
  name: "retention-sweep",
  layer: Layer.merge(layer, sweepLayer.pipe(Layer.provide(layer))),
  deps: [Database.node, FSUtil.node, Global.node],
})
