export * as SessionContextManagement from "./context-management"

import { and, count, desc, eq, sum } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Catalog } from "../catalog"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { SessionCompaction } from "./compaction"
import { ProviderUsageTable, SessionMessageTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

/**
 * Lets an agent see and manage its own context window.
 *
 * The standing guidance (how the cache works, what breaks it, the budget) lives in the system context, where it
 * stays byte-stable. Everything that changes turn to turn lives here, behind a tool the agent pulls, or in a
 * note injected once per threshold. A per-turn status line would add a permanent message every turn.
 */

/** Share of the window to stay under. Matches the automatic compaction target. */
export const BUDGET = SessionCompaction.CONTEXT_TARGET
/** One-time notes: a soft one while there is room to finish a step, and a firm one at the budget. */
export const SOFT_NUDGE = 0.3
/** Below this a checkpoint costs a cache miss and saves almost nothing, so the tool refuses. */
export const MIN_CHECKPOINT = 0.1
/** Provider caches live minutes. Anthropic defaults to 5, OpenAI to 5-10 on older models and 30+ on GPT-5.6+. */
export const CACHE_SECONDS = 300
/** A cache about to lapse is reported before it does, so the agent can avoid a long wait. */
const CACHE_EXPIRING_SECONDS = 240
const RECENT_TURNS = 8

/**
 * Standing guidance, always in the system context. It is static text so it never changes the cached prefix after
 * it is first written; anything that varies turn to turn comes from `session_context` or a one-time note.
 *
 * The cache facts come from the providers' own documentation: prefix matching in the order tools, system,
 * messages; a change anywhere earlier invalidates what follows; entries live minutes (Anthropic 5 by default,
 * OpenAI 5 to 10 on older models and at least 30 on GPT-5.6 and later); a hit refreshes the entry.
 */
export const GUIDANCE = [
  "Context window and prompt cache",
  "Every turn re-sends the whole conversation. The provider reads the part it has cached at a steep discount and re-processes the rest at full price and full latency, so a large window makes every later turn slower and more expensive. Treat the window as a budget.",
  "How the cache works: it matches an exact prefix, in this order: tool definitions, system prompt, then messages. Appending to the end keeps the prefix valid. Changing anything earlier invalidates everything after it, and the next turn re-reads all of it uncached.",
  "What breaks it: changing a tool definition, or loading or unloading tools with tool_load; changing the model, the reasoning effort or other request settings; rewriting, pruning or clearing earlier messages, including old tool output; and a long gap. Provider caches last minutes, not hours. Assume about 5 minutes of idle time: Anthropic defaults to 5 minutes, and OpenAI keeps entries 5 to 10 minutes on older models and at least 30 minutes on GPT-5.6 and later. Each request that uses the cache refreshes it. A slow build, a sleep, or a wait on the user can let it lapse, and the next turn then pays full price.",
  `Stay under ${Math.round(SessionCompaction.CONTEXT_TARGET * 100)}% of the window. session_context reports how full you are, your recent cache hit rate, and how long since the last request. Keep tool output small: search with limits, read ranges and not whole files, and send wide exploration to a subagent so its output does not enter your window.`,
  `When the window nears ${Math.round(0.3 * 100)}% to ${Math.round(SessionCompaction.CONTEXT_TARGET * 100)}%, finish the current step, then call session_checkpoint at a clean boundary: a task done, checks passing, nothing half-edited. You write the checkpoint, so you decide what survives. Include the objective, decisions and why, work done and in progress, blockers, exact next steps, and the paths, commands, identifiers and error strings you will need. Automatic compaction at ${Math.round(SessionCompaction.CONTEXT_TARGET * 100)}% does the same job with a summarizer, slower and keeping less. If a budget note appears, act on it at the next clean boundary and do not ignore it.`,
].join("\n")

export type Level = "soft" | "hard"

export interface Status {
  readonly contextTokens: number | undefined
  readonly window: number | undefined
  readonly usedPercent: number | undefined
  readonly budgetPercent: number
  readonly turns: number
  readonly compactions: number
  readonly cost: number
  readonly cacheHitPercent: number | undefined
  readonly secondsSinceLastRequest: number | undefined
  readonly cache: "warm" | "expiring" | "cold" | "unknown"
  readonly advice: string
}

export interface Interface {
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<Status>
  /** Records the agent's checkpoint. The runner takes it at the next provider-turn boundary. */
  readonly request: (sessionID: SessionSchema.ID, handoff: string) => Effect.Effect<void>
  readonly take: (sessionID: SessionSchema.ID) => Effect.Effect<string | undefined>
  /** True once per Session, window and level, so a note is injected once rather than every turn. */
  readonly claimNudge: (input: {
    readonly sessionID: SessionSchema.ID
    readonly window: number
    readonly level: Level
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionContextManagement") {}

/**
 * The process-local part: pending checkpoint requests and claimed notes. A lost request is harmless, since the
 * agent can ask again, so none of it is durable. Exported so a test can share one store between graphs.
 */
export const makeRequests = (): Pick<Interface, "request" | "take" | "claimNudge"> => {
  const requested = new Map<SessionSchema.ID, string>()
  const nudged = new Set<string>()
  return {
    request: (sessionID, handoff) => Effect.sync(() => void requested.set(sessionID, handoff)),
    take: (sessionID) =>
      Effect.sync(() => {
        const handoff = requested.get(sessionID)
        requested.delete(sessionID)
        return handoff
      }),
    claimNudge: (input) =>
      Effect.sync(() => {
        const key = `${input.sessionID}:${input.window}:${input.level}`
        if (nudged.has(key)) return false
        nudged.add(key)
        return true
      }),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = Database.primary(database.db)
    const store = yield* SessionStore.Service
    const catalog = yield* Catalog.Service

    const status = Effect.fn("SessionContextManagement.status")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      const model = session?.model
      const info = model ? yield* catalog.model.get(model.providerID, model.id) : undefined
      const window = info?.limit.context
      const recent = yield* db
        .select()
        .from(ProviderUsageTable)
        .where(eq(ProviderUsageTable.session_id, sessionID))
        .orderBy(desc(ProviderUsageTable.time))
        .limit(RECENT_TURNS)
        .all()
        .pipe(Effect.orDie)
      const totals = yield* db
        .select({ turns: count(), cost: sum(ProviderUsageTable.cost) })
        .from(ProviderUsageTable)
        .where(eq(ProviderUsageTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const checkpoints = yield* db
        .select({ time: SessionMessageTable.time_created })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
        .orderBy(desc(SessionMessageTable.time_created))
        .all()
        .pipe(Effect.orDie)
      const now = Date.now()
      return describe({
        window,
        recent,
        turns: totals?.turns ?? 0,
        cost: Number(totals?.cost ?? 0),
        checkpoints: checkpoints.map((row) => row.time),
        now,
      })
    })

    return Service.of({ status, ...makeRequests() })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, SessionStore.node, Catalog.node],
})

/** Pure so it can be tested without a database. `recent` is newest first; `checkpoints` are creation times. */
export const describe = (input: {
  readonly window: number | undefined
  readonly recent: ReadonlyArray<{
    readonly time: number
    readonly tokens_input: number
    readonly tokens_cache_read: number
    readonly tokens_cache_write: number
  }>
  readonly turns: number
  readonly cost: number
  readonly checkpoints: ReadonlyArray<number>
  readonly now: number
}): Status => {
  const latest = input.recent[0]
  // A checkpoint written after the newest provider turn means that turn's size no longer describes the window.
  const compactedSince = latest !== undefined && input.checkpoints.some((time) => time > latest.time)
  const contextTokens =
    latest === undefined || compactedSince
      ? undefined
      : latest.tokens_input + latest.tokens_cache_read + latest.tokens_cache_write
  const usedPercent =
    contextTokens === undefined || input.window === undefined || input.window <= 0
      ? undefined
      : Math.round((contextTokens / input.window) * 100)
  const read = input.recent.reduce((total, row) => total + row.tokens_cache_read, 0)
  const all = input.recent.reduce((total, row) => total + row.tokens_input + row.tokens_cache_read, 0)
  const seconds = latest === undefined ? undefined : Math.max(0, Math.round((input.now - latest.time) / 1000))
  return {
    contextTokens,
    window: input.window,
    usedPercent,
    budgetPercent: Math.round(BUDGET * 100),
    turns: input.turns,
    compactions: input.checkpoints.length,
    cost: Math.round(input.cost * 100) / 100,
    cacheHitPercent: all === 0 ? undefined : Math.round((read / all) * 100),
    secondsSinceLastRequest: seconds,
    cache:
      seconds === undefined
        ? "unknown"
        : seconds < CACHE_EXPIRING_SECONDS
          ? "warm"
          : seconds < CACHE_SECONDS
            ? "expiring"
            : "cold",
    advice: advice(usedPercent),
  }
}

const advice = (usedPercent: number | undefined) => {
  if (usedPercent === undefined)
    return "Context size is not known yet. It is measured after the next model response."
  const budget = Math.round(BUDGET * 100)
  if (usedPercent >= budget)
    return `Over the ${budget}% budget. Checkpoint at the next clean boundary with session_checkpoint; automatic compaction will run otherwise, and it is slower and keeps less.`
  if (usedPercent >= Math.round(SOFT_NUDGE * 100))
    return `Close to the ${budget}% budget. Finish the current step, then checkpoint with session_checkpoint at a clean boundary.`
  return `Within the ${budget}% budget. Keep tool output small and delegate wide exploration.`
}

/** The one-time note injected when a window first crosses a threshold. */
export const nudge = (input: { readonly level: Level; readonly usedPercent: number }) =>
  input.level === "hard"
    ? `Context budget: this window is about ${input.usedPercent}% full, over the ${Math.round(BUDGET * 100)}% target. Finish the current step, then call session_checkpoint with a handoff before doing more. Automatic compaction runs soon if you do not, and it keeps less.`
    : `Context budget: this window is about ${input.usedPercent}% full. At the next clean boundary, between tasks and not in the middle of an edit, call session_checkpoint with a handoff so work continues in a small, cheap window.`

/** Which one-time note, if any, applies at this fill level. */
export const nudgeLevel = (fraction: number): Level | undefined =>
  fraction >= BUDGET ? "hard" : fraction >= SOFT_NUDGE ? "soft" : undefined

export interface Handoff {
  readonly objective: string
  readonly importantDetails: ReadonlyArray<string>
  readonly completed: ReadonlyArray<string>
  readonly active: ReadonlyArray<string>
  readonly blocked: ReadonlyArray<string>
  readonly nextMoves: ReadonlyArray<string>
  readonly relevantFiles: ReadonlyArray<string>
  readonly durableMemories: ReadonlyArray<string>
}

/**
 * Renders an agent's handoff into the checkpoint template, so the next compaction can anchor on it and every
 * consumer of a checkpoint keeps its structural guarantee (`SessionCompaction.validSummary`).
 */
export const renderHandoff = (handoff: Handoff) => {
  const bullets = (items: ReadonlyArray<string>) => {
    const lines = items.map((item) => item.trim()).filter((item) => item.length > 0)
    return (lines.length === 0 ? ["(none)"] : lines).map((line) => `- ${line.replace(/\n+/g, " ")}`).join("\n")
  }
  const moves = handoff.nextMoves.map((item) => item.trim()).filter((item) => item.length > 0)
  return [
    "## Objective",
    bullets([handoff.objective]),
    "",
    "## Important Details",
    bullets(handoff.importantDetails),
    "",
    "## Work State",
    "### Completed",
    bullets(handoff.completed),
    "",
    "### Active",
    bullets(handoff.active),
    "",
    "### Blocked",
    bullets(handoff.blocked),
    "",
    "## Next Move",
    (moves.length === 0 ? ["(none)"] : moves).map((move, index) => `${index + 1}. ${move.replace(/\n+/g, " ")}`).join("\n"),
    "",
    "## Relevant Files",
    bullets(handoff.relevantFiles),
    "",
    "## Durable Memories",
    bullets(handoff.durableMemories),
  ].join("\n")
}
