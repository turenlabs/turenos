export * as ContextTool from "./context"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionCompaction } from "../session/compaction"
import { SessionContextManagement } from "../session/context-management"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const statusName = "session_context"
export const checkpointName = "session_checkpoint"

const Status = Schema.Struct({
  context_tokens: Schema.optional(Schema.Number),
  window_tokens: Schema.optional(Schema.Number),
  used_percent: Schema.optional(Schema.Number),
  budget_percent: Schema.Number,
  turns: Schema.Number,
  checkpoints: Schema.Number,
  cost: Schema.Number,
  cache_hit_percent: Schema.optional(Schema.Number),
  seconds_since_last_request: Schema.optional(Schema.Number),
  cache: Schema.Literals(["warm", "expiring", "cold", "unknown"]),
  advice: Schema.String,
})

const Items = (description: string) =>
  Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000)))).pipe(
    Schema.check(Schema.isMaxLength(40)),
    Schema.annotate({ description }),
  )

const Checkpoint = Schema.Struct({
  objective: Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000))).annotate({
    description: "What the user is trying to accomplish, in one or two sentences.",
  }),
  important_details: Items(
    "Constraints, user preferences, decisions and why, assumptions, and exact context needed to continue.",
  ),
  completed: Items("Finished and verified work, with the changes made."),
  active: Items("Work in progress, partial changes, and the state of any investigation."),
  blocked: Items("Blockers, failing commands, and open questions. Leave empty if none."),
  next_moves: Items("Concrete actions in order. The first is what you do immediately after the checkpoint."),
  relevant_files: Items("`path: why it matters` for each file or directory the next step touches."),
  durable_memories: Items(
    "Up to five facts worth keeping beyond this session: stable decisions, constraints, diagnosed causes.",
  ),
})

const Accepted = Schema.Struct({ accepted: Schema.Boolean, message: Schema.String })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const management = yield* SessionContextManagement.Service

    yield* tools
      .register({
        [statusName]: Tool.make({
          description:
            "Report how full this conversation's context window is, how much of the recent input came from the prompt cache, how long since the last request (provider caches last minutes), and what this session has cost. Cheap; use it before a large read or when deciding whether to checkpoint.",
          input: Schema.Struct({}),
          output: Status,
          execute: (_, context) =>
            management.status(context.sessionID).pipe(
              Effect.map((status) => ({
                ...(status.contextTokens === undefined ? {} : { context_tokens: status.contextTokens }),
                ...(status.window === undefined ? {} : { window_tokens: status.window }),
                ...(status.usedPercent === undefined ? {} : { used_percent: status.usedPercent }),
                budget_percent: status.budgetPercent,
                turns: status.turns,
                checkpoints: status.compactions,
                cost: status.cost,
                ...(status.cacheHitPercent === undefined ? {} : { cache_hit_percent: status.cacheHitPercent }),
                ...(status.secondsSinceLastRequest === undefined
                  ? {}
                  : { seconds_since_last_request: status.secondsSinceLastRequest }),
                cache: status.cache,
                advice: status.advice,
              })),
            ),
        }),
        [checkpointName]: Tool.make({
          description: `Replace this conversation's earlier history with a checkpoint you write, then keep working in a small window. Call it at a clean boundary (a task done, tests passing, nothing half-edited) once ${statusName} or a budget note says the window is near ${Math.round(SessionContextManagement.BUDGET * 100)}% full. The checkpoint, plus the last few messages, is all you will remember, so include everything the next step needs: exact paths, commands, identifiers and error strings. It takes effect before your next step, so keep working after you call it; do not stop. It costs one cache miss, so do not call it when the window is under ${Math.round(SessionContextManagement.MIN_CHECKPOINT * 100)}% full or more than once per window. When the whole task is finished and the work should continue elsewhere, use handoff_session instead.`,
          input: Checkpoint,
          output: Accepted,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (!input.next_moves.some((move) => move.trim().length > 0))
                return yield* new ToolFailure({
                  message: "next_moves needs at least one concrete action, or the next step has nothing to resume from.",
                })
              const status = yield* management.status(context.sessionID)
              if (
                status.usedPercent !== undefined &&
                status.usedPercent < Math.round(SessionContextManagement.MIN_CHECKPOINT * 100)
              )
                return yield* new ToolFailure({
                  message: `The window is only ${status.usedPercent}% full. A checkpoint now costs a cache miss and saves almost nothing. Continue the task.`,
                })
              const handoff = SessionContextManagement.renderHandoff({
                objective: input.objective,
                importantDetails: input.important_details,
                completed: input.completed,
                active: input.active,
                blocked: input.blocked,
                nextMoves: input.next_moves,
                relevantFiles: input.relevant_files,
                durableMemories: input.durable_memories,
              })
              if (!SessionCompaction.validSummary(handoff))
                return yield* new ToolFailure({
                  message: "The checkpoint is missing required content. Provide an objective and at least one next move.",
                })
              yield* management.request(context.sessionID, handoff)
              return {
                accepted: true,
                message:
                  "Checkpoint recorded. Earlier history is replaced before your next step. Continue with your first next move.",
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/context",
  layer,
  deps: [ToolRegistry.node, SessionContextManagement.node],
})
