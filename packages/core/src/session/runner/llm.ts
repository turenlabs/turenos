import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
  type ToolResultValue,
} from "@turenlabs/llm"
import { ProviderShared } from "@turenlabs/llm/protocols"
import { LobbySession } from "@turenlabs/schema/lobby-session"
import { createHash } from "node:crypto"
import { Cause, Clock, DateTime, Effect, FiberSet, Layer, Option, Scope, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { AgentGuidance } from "../../agent/guidance"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { FSUtil } from "../../fs-util"
import { Image } from "../../image"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { Reflection } from "../../reflection"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { McpTool } from "../../tool/mcp"
import { SessionToolSnapshot } from "../../tool/session-snapshot"
import { ToolVisibleError } from "../../tool/visible-error"
import { GoalTool } from "../../tool/goal"
import { SwarmRoomTool } from "../../tool/swarm-room"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionContextRequest } from "../context-request"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionExecutionControl } from "../execution-control"
import { SessionHistory } from "../history"
import { SessionGoalAccounting } from "../goal-accounting"
import { SessionGoal } from "../goal"
import { SessionHarness } from "../harness"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionTodo } from "../todo"
import { SessionTodoGuidance } from "../todo-guidance"
import { ProviderPrompt } from "../provider-prompt"
import { SessionSchema } from "../schema"
import { SessionStatus } from "../status"
import { SessionTable } from "../sql"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { SessionRunnerLoopDetector } from "./loop-detector"
import { SessionRunnerRetry } from "./retry"
import { SessionRunnerTitle } from "./title"
import { GoalContext } from "./goal-context"
import { SessionRunnerAttachment } from "./attachment"
import { ClaudeCodeMcp } from "./claude-code-mcp-namespace"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { and, eq } from "drizzle-orm"
import { ClaudeCodeCLI } from "../../provider/claude-code"
import { MuseCodeCLI } from "../../provider/muse-code"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [x] Mark busy, retrying, idle, interrupted, or terminal-failure status durably (`../status.ts`,
 *     projected in `../projector.ts`).
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional per-logical-turn agent step limits.
 *   - [x] Bound provider retries (`./retry.ts`). Repeated identical tool calls are still unbounded.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@turenlabs/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots and patches incrementally as they arrive. Retry notices are durable
 *     (`SessionEvent.Retried`).
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [x] Run plugin `tool.execute.before`/`.after` at settlement. Owned by `tool/interceptor.ts`
 *     and run inside `ToolRegistry`, not here: the runner sees a settled result either way.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [x] Promote one queued input per provider-turn boundary (after tool calls settle), so a
 *     follow-up sent while the agent is working joins the next turn instead of waiting for idle.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [x] Generate a Session title in bounded background work (`./title.ts`), forked into this
 *     layer's scope after the opening turn.
 *   - [ ] Update summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound each
 * logical turn; an active goal starts fresh bounded turns until it reaches a terminal or user-controlled state.
 */

/**
 * How many tool calls from a single assistant message may be settling at once.
 *
 * Independent calls have always been forked rather than awaited in turn -- a turn that issues six
 * probes costs the slowest probe, not their sum -- but until this bound existed the fan-out was
 * whatever the model asked for. A model is perfectly capable of emitting thirty `bash` calls in
 * one message, and thirty concurrent process spawns is a laptop-melting amount of work to accept
 * on the model's say-so.
 *
 * Eight, because it is above the size of essentially every batch a model actually emits -- so the
 * common case still settles in max(durations) and the bound is invisible -- while capping the
 * pathological case at a number any machine can absorb even when every call spawns a compiler.
 * Tying it to core count was tempting and wrong: most tool calls are I/O-bound reads and greps,
 * which would be needlessly throttled on a small machine.
 *
 * The semaphore is created per turn, not per Session or per process. That is what makes nesting
 * safe: a `task` call holds a permit for as long as its child Session runs, and the child's own
 * turns take permits from their own semaphores. A shared one would let a deep subagent tree
 * deadlock against itself.
 *
 * Write-write hazards are explicitly *not* handled here. Two edits to one file are unsafe to
 * overlap, and the runner cannot tell which of the model's calls conflict -- only the model knows
 * what it asked for. Batching independent work is therefore the model's responsibility, and the
 * provider prompts say so in as many words.
 */
export const TOOL_CONCURRENCY_LIMIT = 8

/** First durable stall notice after a tool call has been waiting this long. */
const TOOL_STALL_NOTICE_DELAY = "30 seconds"
/** Repeats while any call stays pending; the running transcript shows the wait growing. */
const TOOL_STALL_NOTICE_INTERVAL = "60 seconds"

/**
 * What the Claude CLI is told when it calls `update_goal`, whose real settlement is deferred to
 * this turn's accounting checkpoint. The result is deliberately explicit about the two things the
 * model would otherwise get wrong: that re-reading the goal this turn still shows the old status
 * (so the update looks lost and invites a retry), and that the final usage the tool description
 * promises is not available inline.
 */
const GOAL_UPDATE_ACCEPTED = [
  "Goal status update accepted.",
  "It commits when this turn's accounting settles, so the goal still reports its previous status for the rest of this turn.",
  "Do not call update_goal again for this goal, and do not report final token or elapsed-time usage; it is not available here.",
].join(" ")

const STREAM_RECOVERY_PROMPT = [
  "The previous provider stream ended after emitting partial assistant output.",
  "Follow any newer user message first; otherwise continue the user's task from the durable partial response without repeating completed text.",
  "Any incomplete tool call was not executed; regenerate it from scratch if it is still needed.",
].join(" ")

const currentTaskAnchor = (
  text: string,
  goal: SessionGoal.Info | undefined,
  todos: ReadonlyArray<SessionTodo.Info>,
) => {
  const displayedTodos = [
    ...todos.filter((todo) => todo.status === "in_progress" || todo.status === "pending"),
    ...todos.filter((todo) => todo.status !== "in_progress" && todo.status !== "pending"),
  ]
    .slice(0, 32)
    .map((todo) => ({
      content: todo.content.length > 256 ? `${todo.content.slice(0, 256)}...` : todo.content,
      status: todo.status,
      priority: todo.priority,
    }))
  const displayedInstruction = ToolOutputStore.boundedPreview(
    text,
    "[... current instruction excerpted ...]",
    80,
    8 * 1_024,
  )
  return [
    "<current_task_anchor>",
    "The preceding room coordination context is historical evidence. It does not replace the current task or verified state.",
    "Latest human instruction (authoritative):",
    displayedInstruction,
    ...(goal?.status === "active"
      ? [
          "Current active goal (authoritative):",
          ToolOutputStore.boundedPreview(goal.objective, "[... goal excerpted ...]", 20, 2 * 1_024),
        ]
      : []),
    ...(displayedTodos.length > 0
      ? [
          "Current durable todo state (authoritative):",
          JSON.stringify(displayedTodos),
          ...(todos.length > displayedTodos.length
            ? [`${todos.length - displayedTodos.length} additional todo items remain in durable storage.`]
            : []),
        ]
      : []),
    "Continue from the latest verified state. Do not repeat completed work solely because a room entry describes it.",
    "</current_task_anchor>",
  ].join("\n")
}

// This route lowers only TurenOS-owned function tools. Other adapters may start provider-hosted
// work before they emit an observable tool call, so absence of Tool.Called is not proof that a
// fresh continuation cannot repeat a provider-side action.
const STREAM_RECOVERY_ROUTES = new Set(["openai-responses"])

type GoalTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly write: number }
}

function goalTokenDelta(tokens: GoalTokens | undefined) {
  const total = tokens ? tokens.input + tokens.cache.write + tokens.output + tokens.reasoning : 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(total)))
}

/**
 * The harness as instructions, not as an inventory.
 *
 * A tool listed in the tool schema is easy to walk past: when the model already knows a familiar way
 * to get the same answer, it takes the familiar way. So this leads with the standing directives and
 * says what each session tool settles, rather than reciting a version number and a file list the
 * model has no use for. It steers; it cannot compel, since the model may still take another route.
 */
function harnessPrompt(state: SessionHarness.State | undefined) {
  const snapshot = state?.snapshot
  if (!snapshot) return
  const guidance = (snapshot.guidance ?? []).map(
    (item) => `- ${item.appliesTo ? `When working on ${item.appliesTo}: ` : ""}${item.directive}`,
  )
  const tools = snapshot.tools
    .filter((tool) => tool.enabled && tool.readOnly && tool.name !== SessionHarness.REVIEW_REQUEST_TOOL_NAME)
    .map((tool) => `- ${tool.name}: ${tool.description}`)
  if (guidance.length === 0 && tools.length === 0) return
  const rendered = [
    "Harness adoption protocol: the listed harness_ tools and guidance are active adaptations for this task, not background notes. When one matches the work in front of you, use that harness_ tool before a generic equivalent and follow the matching directive in this turn. If none matches, continue normally.",
    guidance.length > 0
      ? `Standing instructions for this session, established from earlier work:\n${guidance.join("\n")}`
      : undefined,
    tools.length > 0
      ? `Session-local tools. Each encodes a fact already established in this session, so prefer it over re-deriving the same answer:\n${tools.join("\n")}`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n")
  const limit = 16_000
  return rendered.length > limit ? `${rendered.slice(0, limit - 32)}\n[Harness context truncated]` : rendered
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const agentGuidance = yield* AgentGuidance.Service
    const toolSnapshots = yield* SessionToolSnapshot.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const goalAccounting = yield* SessionGoalAccounting.Service
    const goals = yield* SessionGoal.Service
    const harness = yield* Effect.serviceOption(SessionHarness.Service)
    const todos = yield* SessionTodo.Service
    const reflection = yield* Reflection.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const snapshots = yield* Snapshot.Service
    const database = yield* Database.Service
    // Resolved once, like every other collaborator in this layer, and passed as a plain value into
    // `SessionRunnerAttachment.materialize` -- that function's callers are typed with `R = never`,
    // so it cannot pull these from ambient Context itself.
    const attachmentDeps: SessionRunnerAttachment.Dependencies = {
      fsUtil: yield* FSUtil.Service,
      image: yield* Image.Service,
    }
    const db = isWithReplicas(database.db) ? database.db.$primary : database.db
    // The hidden `compaction` agent has carried PROMPT_COMPACTION and an `agents.compaction.model`
    // slot since the V2 agent registry landed, but `agents.select` was only ever called for the
    // session agent -- so V2 summarised with the session's own model and no system prompt at all,
    // and `agents.compaction.model` silently did nothing. Resolve both here, where the registry
    // and the model catalog live. An unavailable override degrades to the session model rather
    // than failing the compaction: a stale entry in config must not make a session uncompactable.
    const compactionSummarizer = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const selection = yield* agents.select(AgentV2.ID.make("compaction"))
      const override = selection.info?.model
      const session = override ? yield* store.get(sessionID) : undefined
      const resolved =
        override && session
          ? yield* models.resolve({ ...session, model: override }, selection.info?.request).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "Configured compaction model is unavailable; summarising with the session model",
                ).pipe(
                  Effect.annotateLogs({
                    sessionID,
                    providerID: override.providerID,
                    modelID: override.id,
                    error: ToolVisibleError.make(error),
                  }),
                  Effect.as(undefined),
                ),
              ),
              Effect.catchDefect(() => Effect.succeed(undefined)),
            )
          : undefined
      return { model: resolved?.model, system: selection.info?.system } satisfies SessionCompaction.Summarizer
    })
    const compaction = SessionCompaction.make({
      events,
      llm,
      // The Effect, not a captured array: compaction re-reads config per call, so `compaction`
      // settings edited mid-session apply on the next turn instead of after a restart.
      config: config.entries(),
      summarizer: compactionSummarizer,
    })
    const title = SessionRunnerTitle.make({ agents, events, llm, models, store })
    /**
     * The scope background work is forked into, and the reason it has to be this one. `Effect.fork`
     * would attach the fiber to the drain, which ends the instant the run does; the per-turn scope
     * closed at the foot of `runTurnAttempt` is shorter still and would kill a title on every fast
     * turn. This layer's scope outlives both and is torn down with the Location, so nothing forked
     * here can outlive the runtime that owns it.
     */
    const scope = yield* Scope.Scope
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })

    // A run can fail before the provider turn is ever opened -- an unresolvable model, a blocked
    // system context, an undecodable transcript. Those failures used to escape without appending a
    // single durable event, so the client kept the optimistic "working" state forever with nothing
    // to render and no way to retry. Track whether the turn got far enough to own its own failure
    // reporting; if it did not, settle the turn here so every run ends in a visible terminal state.
    const turnProgress = new Map<SessionSchema.ID, { promoted: boolean; recorded: boolean }>()
    const markTurnRecorded = (sessionID: SessionSchema.ID) => {
      const progress = turnProgress.get(sessionID)
      if (progress) progress.recorded = true
    }
    const unknownRef = ModelV2.Ref.make({
      id: ModelV2.ID.make("unknown"),
      providerID: ProviderV2.ID.make("unknown"),
    })
    const failedRef = (failure: unknown) => {
      if (failure instanceof SessionRunnerModel.ModelUnavailableError)
        return ModelV2.Ref.make({ id: failure.modelID, providerID: failure.providerID })
      if (failure instanceof SessionRunnerModel.VariantUnavailableError)
        return ModelV2.Ref.make({ id: failure.modelID, providerID: failure.providerID })
      return undefined
    }
    const recordUnstartedFailure = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      cause: Cause.Cause<RunError>,
    ) {
      const progress = turnProgress.get(sessionID)
      if (!progress || progress.recorded) return
      progress.recorded = true
      const session = yield* store.get(sessionID)
      if (!session) return
      const failure = Cause.squash(cause)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        agent: session.agent ?? AgentV2.defaultID,
        model: session.model ?? failedRef(failure) ?? unknownRef,
      })
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        error: { type: "unknown", message: ToolVisibleError.make(failure) },
      })
    })
    const recordUnstartedInterruption = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const progress = turnProgress.get(sessionID)
      if (!progress?.promoted || progress.recorded) return
      progress.recorded = true
      const session = yield* store.get(sessionID)
      if (!session) return
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        agent: session.agent ?? AgentV2.defaultID,
        model: session.model ?? unknownRef,
      })
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        error: { type: "unknown", message: "Provider turn interrupted before it started" },
      })
    })
    // The retry backoff is the one pre-assistant window that has already written durable state:
    // publishing `SessionEvent.Retried` projected a status row of "retry" owned by this process,
    // and only a later Step event replaces it. A run that exits while it still owns that row --
    // interrupted mid-backoff, say -- leaves a countdown nothing is counting, forever. The
    // promoted case is settled by `recordUnstartedInterruption`/`recordUnstartedFailure`, whose
    // `Step.Failed` projects a terminal status over the row before this runs; this clears the
    // remainder, where the run records nothing durable and the honest terminal is the idle the
    // wait began from. Direct-write like `V2Session.recover`, and ownership-guarded the same way:
    // a row another process wrote is its history to settle, not ours.
    const settleAbandonedRetry = (sessionID: SessionSchema.ID) => SessionStatus.clearOwnedRetry(db, sessionID)
    const getGoal = (sessionID: SessionSchema.ID) => goals.get(sessionID).pipe(Effect.orDie)
    const resetReflectionContext = Effect.fn("SessionRunner.resetReflectionContext")(function* (
      sessionID: SessionSchema.ID,
    ) {
      if (!(yield* reflection.resetPending(sessionID))) return
      yield* SessionContextEpoch.reset(db, sessionID)
      yield* reflection.resetComplete(sessionID)
    })
    const activeTimeSince = Effect.fn("SessionRunner.activeTimeSince")(function* (startedAt: bigint) {
      const elapsed = (yield* Clock.currentTimeNanos) - startedAt
      const milliseconds = elapsed <= 0n ? 0n : elapsed / 1_000_000n
      return Number(milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : milliseconds)
    })
    const accountGoal = Effect.fn("SessionRunner.accountGoal")(function* (
      sessionID: SessionSchema.ID,
      current: SessionGoal.Info | undefined,
      checkpointID: SessionMessage.ID,
      usage: SessionGoalAccounting.Usage,
    ) {
      if (current?.status !== "active") return yield* getGoal(sessionID)
      const attempt = (goal: SessionGoal.Info) =>
        goals.account({
          sessionID,
          goalID: goal.id,
          expectedRevision: goal.revision,
          checkpointID,
          tokenDelta: usage.tokenDelta,
          activeTimeMsDelta: usage.activeTimeMsDelta,
          mode: "ActiveOrStopped",
        })
      return yield* attempt(current).pipe(
        Effect.catchTags({
          "SessionGoal.NotFoundError": () => getGoal(sessionID),
          "SessionGoal.InvalidStateError": () => getGoal(sessionID),
          "SessionGoal.ConflictError": () =>
            getGoal(sessionID).pipe(
              Effect.flatMap((latest) => {
                if (latest?.id !== current.id) return Effect.succeed(latest)
                return attempt(latest).pipe(
                  Effect.catchTags({
                    "SessionGoal.NotFoundError": () => getGoal(sessionID),
                    "SessionGoal.InvalidStateError": () => getGoal(sessionID),
                    "SessionGoal.ConflictError": () => getGoal(sessionID),
                  }),
                )
              }),
            ),
        }),
      )
    })
    const stopGoal = Effect.fn("SessionRunner.stopGoal")(function* (
      sessionID: SessionSchema.ID,
      current: SessionGoal.Info | undefined,
      status: "paused" | "usageLimited",
    ) {
      if (current?.status !== "active") return current
      const attempt = (goal: SessionGoal.Info) =>
        goals.status({
          sessionID,
          goalID: goal.id,
          expectedRevision: goal.revision,
          status,
        })
      return yield* attempt(current).pipe(
        Effect.catchTags({
          "SessionGoal.NotFoundError": () => getGoal(sessionID),
          "SessionGoal.InvalidStateError": () => getGoal(sessionID),
          "SessionGoal.ConflictError": () =>
            getGoal(sessionID).pipe(
              Effect.flatMap((latest) => {
                if (latest?.id !== current.id || latest.status !== "active") return Effect.succeed(latest)
                return attempt(latest).pipe(
                  Effect.catchTags({
                    "SessionGoal.NotFoundError": () => getGoal(sessionID),
                    "SessionGoal.InvalidStateError": () => getGoal(sessionID),
                    "SessionGoal.ConflictError": () => getGoal(sessionID),
                  }),
                )
              }),
            ),
        }),
      )
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      | { readonly _tag: "ContinueAfterPruning"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(
        readonly transition: TurnTransition,
        readonly todoPrompt: TodoPrompt | undefined,
      ) {
        super()
      }
    }

    const continueAfterCompaction = (step: number, todoPrompt: TodoPrompt | undefined) =>
      new TurnTransitionError({ _tag: "ContinueAfterCompaction", step }, todoPrompt)
    const continueAfterPruning = (step: number, todoPrompt: TodoPrompt | undefined) =>
      new TurnTransitionError({ _tag: "ContinueAfterPruning", step }, todoPrompt)
    const continueAfterOverflowCompaction = (step: number, todoPrompt: TodoPrompt | undefined) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step }, todoPrompt)

    type GoalPrompt = "continuation" | "reminder"
    type TodoPrompt = SessionTodoGuidance.Prompt | "done"
    type KnownGoal = Pick<SessionGoal.Info, "id" | "objective">
    type StreamRecovery = { readonly userInputPromoted: boolean }

    const loadSystemContext = (agent: AgentV2.Selection, sessionID: SessionSchema.ID) =>
      Effect.all(
        [
          systemContext.load(),
          skillGuidance.load(agent),
          referenceGuidance.load(),
          agentGuidance.load({ agent, sessionID }),
        ],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      goalPrompt: GoalPrompt | undefined,
      knownGoal: KnownGoal | undefined,
      control: SessionExecutionControl.Interface,
      todoPrompt: TodoPrompt | undefined,
      streamRecovery: StreamRecovery | undefined,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
      compactBeforeTurn = true,
    ): Effect.fn.Return<RunTurnResult, RunError, Scope.Scope> {
      const startupStartedAt = Date.now()
      const startupPhase = (phase: string, detail: Record<string, unknown> = {}) =>
        Effect.logInfo("Session runner startup phase", {
          phase,
          sessionID,
          elapsedMs: Date.now() - startupStartedAt,
          ...detail,
        })
      yield* startupPhase("preflight_started")
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const lifecycleGoalAtStart = yield* getGoal(session.id)
      if (goalPrompt === "continuation" && lifecycleGoalAtStart?.status !== "active")
        return {
          ran: false,
          needsContinuation: false,
          todoPrompt: undefined,
          step,
          goal: lifecycleGoalAtStart,
          knownGoal,
        }
      const harnessSessionID = session.parentID ?? session.id
      const [agent, reflectionConfig, harnessState] = yield* Effect.all(
        [
          toolSnapshots.ready().pipe(Effect.andThen(agents.select(session.agent))),
          config.entries().pipe(Effect.map(Reflection.reflectionSettings)),
          Option.isSome(harness)
            ? harness.value.peek(harnessSessionID).pipe(
                Effect.catchTag("SessionHarness.NotFoundError", () =>
                  Effect.succeed({
                    snapshot: null,
                    proposals: [],
                    reviewerRequests: [],
                    reviewerRuns: [],
                  } satisfies SessionHarness.State),
                ),
              )
            : Effect.succeed(undefined),
        ] as const,
        { concurrency: "unbounded" },
      )
      yield* startupPhase("selection_ready")
      const accountedGoalAtStart = agent.id === AgentV2.ID.make("plan") ? undefined : lifecycleGoalAtStart
      yield* resetReflectionContext(session.id)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent, session.id), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      const goalUpdateFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      // A turn cannot finish until its tool fibers do, and a fiber can wait on something that may
      // never arrive -- an unseen permission prompt, an unanswered question, a hung process. With
      // no durable mark the session just looks dead, so report each pending call as tool progress
      // until it settles: "stuck" reads as "waiting on X" to anyone watching the transcript.
      const pendingToolCalls = new Map<
        string,
        { readonly name: string; readonly assistantMessageID: SessionMessage.ID; readonly startedAt: number }
      >()
      const stallNotices = Effect.gen(function* () {
        yield* Effect.sleep(TOOL_STALL_NOTICE_DELAY)
        while (pendingToolCalls.size > 0) {
          const requests = yield* permission
            .forSession(session.id)
            .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PermissionV2.Request>)))
          for (const [callID, call] of pendingToolCalls) {
            const waitedMs = Date.now() - call.startedAt
            const waitingOn =
              call.name === "question"
                ? "question"
                : requests.some((request) => request.source?.type === "tool" && request.source.callID === callID)
                  ? "permission"
                  : "execution"
            const minutes = Math.floor(waitedMs / 60_000)
            const elapsed =
              minutes > 0 ? `${minutes}m ${Math.round((waitedMs % 60_000) / 1000)}s` : `${Math.round(waitedMs / 1000)}s`
            const text =
              waitingOn === "permission"
                ? `Waiting for permission approval (${elapsed})`
                : waitingOn === "question"
                  ? `Waiting for an answer (${elapsed})`
                  : `Still running (${elapsed})`
            yield* events
              .publish(SessionEvent.Tool.Progress, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: call.assistantMessageID,
                callID,
                structured: { stalled: true, waiting_on: waitingOn, waited_ms: waitedMs },
                content: [{ type: "text", text }],
              })
              .pipe(Effect.catchCause(() => Effect.void))
          }
          yield* Effect.sleep(TOOL_STALL_NOTICE_INTERVAL)
        }
      }).pipe(Effect.catchCause(() => Effect.void))
      const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
        Effect.raceFirst(Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers)), stallNotices)
      // See `TOOL_CONCURRENCY_LIMIT`. Per turn, so nested Sessions cannot starve each other.
      const withToolPermit = Semaphore.makeUnsafe(TOOL_CONCURRENCY_LIMIT).withPermit
      const withTodoPermit = Semaphore.makeUnsafe(1).withPermit
      let needsContinuation = false
      let userDeclined = false
      let questionToolInFlight = false
      let currentStep = step
      const promotionCutoff = promotion ? yield* EventV2.latestSequence(db, session.id) : undefined
      if (promotion && promotionCutoff !== undefined) {
        const markPromoted = () => {
          const progress = turnProgress.get(session.id)
          if (progress) progress.promoted = true
        }
        let promoted = 0
        if (promotion === "steer")
          promoted = yield* SessionInput.promoteSteers(db, events, session.id, promotionCutoff, markPromoted)
        if (promotion === "queue") {
          const steers = yield* SessionInput.promoteSteers(db, events, session.id, promotionCutoff, markPromoted)
          promoted += steers
          if (steers === 0)
            promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id, markPromoted))
        }
        if (promoted > 0) currentStep = 1
      }
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolsDisabled = agent.info?.tools === false || isLastStep
      const [system, resolvedModel] = yield* Effect.all(
        [
          initialized
            ? Effect.succeed(initialized)
            : SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session.id), session.id),
          models.resolve(session, agent.info?.request),
        ] as const,
        { concurrency: "unbounded" },
      )
      yield* startupPhase("context_model_ready")
      const model = resolvedModel.model
      const modelRef = resolvedModel.ref
      const toolPermissions = Option.match(LobbySession.binding(session.metadata), {
        onNone: () => agent.info?.permissions,
        onSome: (binding) => [
          ...(agent.info?.permissions ?? []),
          ...LobbySession.capabilityRules(LobbySession.capabilityProfile(binding)),
        ],
      })
      const history = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      // Board notifications continue the current task; restarting its checkpoint cycle changes
      // the leading system prefix and invalidates cached conversation history.
      if (
        promotionCutoff !== undefined &&
        history.some(
          (entry) =>
            entry.seq > promotionCutoff && entry.message.type === "user" && (entry.message.source ?? "user") === "user",
        )
      )
        todoPrompt = "initial"
      const previousAssistant = history.findLast(
        (entry): entry is typeof entry & { readonly message: SessionMessage.Assistant } =>
          entry.message.type === "assistant",
      )
      const followsRoomRead = previousAssistant?.message.content.some(
        (item) => item.type === "tool" && item.name === SwarmRoomTool.readName && item.state.status === "completed",
      )
      const lastMessage = history.at(-1)?.message
      const inspectInputSource = followsRoomRead === true || lastMessage?.type === "user"
      const [latestHumanInput, latestInternalInput] = inspectInputSource
        ? yield* Effect.all(
            [
              SessionInput.latestPromoted(db, session.id, "user"),
              SessionInput.latestPromotedInternal(db, session.id),
            ] as const,
            { concurrency: "unbounded" },
          )
        : [undefined, undefined]
      const currentTask =
        latestHumanInput &&
        (followsRoomRead === true ||
          (lastMessage?.type === "user" && lastMessage.source === "shell_job") ||
          (latestInternalInput !== undefined &&
            (latestInternalInput.promotedSeq ?? -1) > (latestHumanInput.promotedSeq ?? -1)))
          ? latestHumanInput
          : undefined
      yield* startupPhase("history_ready", { entries: history.length })
      const toolSnapshot = toolsDisabled
        ? undefined
        : yield* toolSnapshots.materialize({
            sessionID: session.id,
            directory: location.directory,
            model: modelRef,
            agent: agent.id,
            permissions: toolPermissions,
            parentID: session.parentID,
            taskOwned: session.parentID !== undefined,
            control,
            harnessState,
          })
      yield* startupPhase("tools_ready", { tools: toolSnapshot?.materialization.definitions.length ?? 0 })
      const objectiveChanged =
        knownGoal !== undefined &&
        lifecycleGoalAtStart !== undefined &&
        knownGoal.id === lifecycleGoalAtStart.id &&
        knownGoal.objective !== lifecycleGoalAtStart.objective
      const goalContext = objectiveChanged
        ? GoalContext.objectiveUpdated(lifecycleGoalAtStart)
        : goalPrompt === "continuation" && lifecycleGoalAtStart
          ? GoalContext.continuation(lifecycleGoalAtStart)
          : goalPrompt === "reminder" && lifecycleGoalAtStart?.status === "active"
            ? GoalContext.reminder()
            : undefined
      const modelKnownGoal =
        goalContext && lifecycleGoalAtStart
          ? { id: lifecycleGoalAtStart.id, objective: lifecycleGoalAtStart.objective }
          : (knownGoal ??
            (lifecycleGoalAtStart
              ? { id: lifecycleGoalAtStart.id, objective: lifecycleGoalAtStart.objective }
              : undefined))
      const toolMaterialization = toolSnapshot?.materialization
      const todoToolAvailable =
        toolMaterialization?.definitions.some((definition) => definition.name === "todowrite") ?? false
      const [reflectionPrompt, todoSnapshot] = yield* Effect.all(
        [
          reflection.prompt({
            session,
            enabled: reflectionConfig.enabled,
            interval: reflectionConfig.interval,
            claim:
              !toolsDisabled &&
              (toolMaterialization?.definitions.some((definition) => definition.name === "reflection_complete") ??
                false),
          }),
          todoToolAvailable || currentTask !== undefined ? todos.get(session.id) : Effect.succeed([]),
        ] as const,
        { concurrency: "unbounded" },
      )
      const providerTurnID = SessionMessage.ID.create()
      const claudeTools =
        modelRef.providerID === ClaudeCodeCLI.ID || modelRef.providerID === MuseCodeCLI.ID
          ? (toolMaterialization?.definitions ?? [])
          : []
      type ClaudeToolCall = { readonly id: string; readonly name: string; readonly input: unknown }
      let executeClaudeTool = (_call: ClaudeToolCall): Effect.Effect<ToolResultValue, unknown> =>
        Effect.fail(new Error("Claude Code MCP tool execution started before the provider turn"))
      let todoUpdated = false
      let substantiveWork = false
      const claudeMcpToken =
        claudeTools.length > 0 && toolMaterialization
          ? yield* ClaudeCodeMcp.register({
              definitions: claudeTools,
              execute: (call) => Effect.suspend(() => executeClaudeTool(call)),
            })
          : undefined
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const base = [
        agent.info?.system ?? ProviderPrompt.forModel(model.id),
        system.baseline,
        toolSnapshot?.snapshot.broker.visible.includes(McpTool.SEARCH_TOOL_NAME)
          ? McpTool.DISCOVERY_SYSTEM_PROMPT
          : undefined,
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .map(SystemPart.make)
      // Tool execution still uses this turn's materialization and permissions. A changed
      // definition/model/base explicitly starts a new rendered epoch rather than pinning authority.
      const identity = createHash("sha256")
        .update(
          JSON.stringify({
            model: modelRef,
            upstream: model.id,
            route: model.route.id,
            defaults: model.defaults,
            routeDefaults: {
              generation: model.route.defaults.generation,
              providerOptions: model.route.defaults.providerOptions,
            },
            compatibility: model.compatibility,
            agent: agent.id,
            system: base,
            tools: toolMaterialization?.definitions ?? [],
          }),
        )
        .digest("hex")
      const prepared = yield* SessionContextRequest.prepare(db, session.id, {
        baselineSeq: system.baselineSeq,
        identity,
        history,
      })
      // A new frame replays durable clearings but does not introduce new reductions.
      // Pressure is measured against the fully rendered request below.
      const added = prepared.frame
        ? history.slice(prepared.frame.sources.length)
        : yield* compaction.prune(session.id, history, false)
      const context = yield* SessionRunnerAttachment.materialize(
        attachmentDeps,
        added.map((entry) => entry.message),
      )
      const runtime = [
        harnessPrompt(harnessState),
        todoToolAvailable && todoPrompt && todoPrompt !== "done"
          ? SessionTodoGuidance.prompt(todoPrompt, todoSnapshot)
          : undefined,
        streamRecovery?.userInputPromoted ? STREAM_RECOVERY_PROMPT : undefined,
        reflectionPrompt,
      ].filter((part): part is string => part !== undefined && part.length > 0)
      const instructions = [
        ...(runtime.length > 0
          ? [
              Message.make({
                role: "system",
                content: `These runtime instructions apply only to the immediately following assistant turn. Historical runtime instructions are not pending tasks. They do not replace the latest human request.\n${runtime.join("\n\n")}`,
                metadata: { forge: { internalContext: "runtime" } },
              }),
            ]
          : []),
      ]
      const notes = [
        ...(currentTask
          ? [
              Message.make({
                role: "user",
                content: currentTaskAnchor(currentTask.prompt.text, lifecycleGoalAtStart, todoSnapshot),
                metadata: { forge: { internalContext: "current-task" } },
              }),
            ]
          : []),
        ...(goalContext
          ? [Message.make({ role: "user", content: goalContext, metadata: { forge: { internalContext: "goal" } } })]
          : []),
        ...(streamRecovery && !streamRecovery.userInputPromoted
          ? [
              Message.make({
                role: "user",
                content: STREAM_RECOVERY_PROMPT,
                metadata: { forge: { internalContext: "provider-recovery" } },
              }),
            ]
          : []),
      ]
      const turn = createHash("sha256")
        .update(JSON.stringify({ seq: history.at(-1)?.seq, instructions, notes, isLastStep }))
        .digest("hex")
      const overhead =
        prepared.frame?.turn === turn
          ? []
          : [...instructions, ...notes, ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])]
      // These budget-only rows stay in the rendered frame, not the transcript or summary.
      // Their position before the next assistant lets reported usage absorb older notes
      // while still counting all notes appended since the last measured provider request.
      const measured = [
        ...(prepared.frame?.entries ?? []),
        ...added.map((entry, index) => ({ ...entry, message: context[index]! })),
        ...(overhead.length === 0
          ? []
          : [
              {
                seq: history.at(-1)?.seq ?? 0,
                message: SessionMessage.Synthetic.make({
                  id: SessionMessage.ID.make(`msg_${turn}`),
                  sessionID: session.id,
                  type: "synthetic",
                  text: JSON.stringify(overhead),
                  time: { created: yield* DateTime.now },
                }),
              },
            ]),
      ]
      const messages = toLLMMessages(context, model)
      // Insert one-turn guidance before new user input, never ahead of the cached prefix and
      // never after a newly promoted human instruction. Retrying the same turn adds nothing.
      const boundary = messages.findIndex((message) => message.role === "user")
      const insertion = boundary === -1 ? messages.length : boundary
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        metadata: claudeMcpToken ? ClaudeCodeMcp.requestMetadata(claudeMcpToken) : undefined,
        system: base,
        messages: [
          ...(prepared.frame?.messages ?? []),
          ...messages.slice(0, insertion),
          ...(prepared.frame?.turn === turn ? [] : instructions),
          ...messages.slice(insertion),
          ...(prepared.frame?.turn === turn ? [] : notes),
          ...(isLastStep && prepared.frame?.turn !== turn ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
        ],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: toolsDisabled ? "none" : undefined,
      })
      if (
        compactBeforeTurn &&
        prepared.frame?.turn !== turn &&
        SessionCompaction.needsPruning({ entries: measured, model, request })
      ) {
        // Rebuild from pinned bytes, not live files, and omit budget-only runtime rows.
        const sourceIDs = new Set(history.map((entry) => entry.message.id))
        const pinned = measured.filter((entry) => sourceIDs.has(entry.message.id))
        const reduced = yield* compaction.prune(session.id, pinned)
        if (reduced.some((entry, index) => JSON.stringify(entry.message) !== JSON.stringify(pinned[index]!.message))) {
          // Usage measured before this rewrite no longer describes the new request.
          const entries = reduced.map((entry) => ({
            ...entry,
            message: entry.message.type === "assistant" ? { ...entry.message, tokens: undefined } : entry.message,
          }))
          const cutoff = prepared.frame?.sources.length ?? 0
          const tail = toLLMMessages(
            entries.slice(cutoff).map((entry) => entry.message),
            model,
          )
          const boundary = tail.findIndex((message) => message.role === "user")
          const insertion = boundary === -1 ? tail.length : boundary
          yield* SessionContextRequest.save(db, session.id, {
            baselineSeq: system.baselineSeq,
            identity,
            generation: prepared.generation + (prepared.frame === undefined ? 0 : 1),
            reason: "pressure",
            frame: {
              entries: [...entries, ...(overhead.length > 0 ? measured.slice(-1) : [])],
              messages: [
                ...toLLMMessages(
                  entries.slice(0, cutoff).map((entry) => entry.message),
                  model,
                ),
                ...tail.slice(0, insertion),
                ...instructions,
                ...tail.slice(insertion),
                ...notes,
                ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
              ],
              sources: prepared.sources,
              turn,
            },
          })
          yield* startupPhase("context_epoch_rebuilt", {
            generation: prepared.generation + (prepared.frame === undefined ? 0 : 1),
            reason: "pressure",
          })
          return yield* Effect.die(continueAfterPruning(currentStep, todoPrompt))
        }
      }
      // Summarise the UNPRUNED history against the PRUNED request. The budget question is "does the
      // request the provider is about to receive still fit", so it must be asked of `request`. What
      // the summary is built from is a different question, and answering it with the pruned view
      // was destroying the very thing compaction exists to preserve: prune clears a tool result to
      // a 33-char sentinel, the summarizer then summarises the sentinel, and the content can never
      // re-enter context by any path -- not as raw output, not as a summary bullet. Pruning is a
      // rendering optimization on something the summary is about to make durable; summarising its output
      // makes the saving permanent. `select` bounds each tool result by `TOOL_OUTPUT_BUDGETS`
      // anyway, so the unpruned head costs at most that budget per call rather than the raw bytes.
      if (
        compactBeforeTurn &&
        (yield* compaction.compactIfNeeded({
          sessionID: session.id,
          entries: history,
          model,
          request,
          measured,
        }))
      )
        return yield* Effect.die(continueAfterCompaction(currentStep, todoPrompt))
      // Inside the band the gate deliberately stopped reserving (`OUTPUT_RESERVE_CAP`), the
      // configured output allowance no longer fits `prompt + max_tokens <= context` validation;
      // shrink it to what the window still holds. A no-op for every healthy request.
      // Clamp against the pinned view plus appended runtime overhead. Measuring raw history
      // would re-count freed bytes and shrink the allowance for no reason.
      const wireRequest = SessionCompaction.clampOutput({ entries: measured, model, request })
      yield* SessionContextRequest.save(db, session.id, {
        baselineSeq: system.baselineSeq,
        identity,
        generation: prepared.generation,
        reason: prepared.reason,
        frame: { entries: measured, messages: request.messages, sources: prepared.sources, turn },
      })
      if (prepared.reason)
        yield* startupPhase("context_epoch_rebuilt", { generation: prepared.generation, reason: prepared.reason })
      yield* startupPhase("provider_request_ready", {
        messages: wireRequest.messages.length,
        tools: wireRequest.tools.length,
      })
      const goalStartedAt = yield* Clock.currentTimeNanos
      const goalTurn = yield* goalAccounting.open({
        sessionID: session.id,
        goalID: lifecycleGoalAtStart?.status === "active" ? lifecycleGoalAtStart.id : undefined,
        checkpoint: (usage) =>
          accountedGoalAtStart
            ? accountGoal(session.id, accountedGoalAtStart, providerTurnID, usage)
            : getGoal(session.id),
      })
      const startSnapshot = yield* snapshots.capture()
      // From here on the publisher owns failure reporting for this turn. Provisionally: the
      // publisher only opens the durable step on the first content frame, so if the turn ends
      // with the step never opened, the settlement block below hands the responsibility back.
      markTurnRecorded(session.id)
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        assistantMessageID: providerTurnID,
        agent: agent.id,
        model: modelRef,
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const toolTurnIDs = new Set<SessionMessage.ID>()
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      const publishRetry = Effect.fnUntraced(function* (decision: SessionRunnerRetry.Decision) {
        yield* events.publish(SessionEvent.Retried, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          attempt: decision.attempt,
          delay: decision.delay,
          error: decision.error,
          ...(decision.action === undefined ? {} : { action: decision.action }),
        })
      })
      if (claudeMcpToken && toolMaterialization) {
        executeClaudeTool = (call) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const text = JSON.stringify(call.input) ?? "{}"
              yield* publish(LLMEvent.toolInputStart({ id: call.id, name: call.name }))
              yield* publish(LLMEvent.toolInputDelta({ id: call.id, name: call.name, text }))
              yield* publish(LLMEvent.toolInputEnd({ id: call.id, name: call.name }))
              yield* publish(
                LLMEvent.toolCall({ id: call.id, name: call.name, input: call.input, providerExecuted: false }),
              )
              const assistantMessageID = yield* publisher.assistantMessageID(call.id)
              toolTurnIDs.add(assistantMessageID)
              pendingToolCalls.set(call.id, { name: call.name, assistantMessageID, startedAt: Date.now() })
              const settle = toolMaterialization.settle({
                sessionID: session.id,
                agent: agent.id,
                assistantMessageID,
                call: { type: "tool-call", ...call },
                inline: true,
              })
              // `update_goal` waits for this turn's accounting checkpoint, which only settles
              // once the provider stream is done -- and the CLI's stream cannot finish while it
              // blocks on this MCP response. Settle it on the runner's goal fiber set exactly as
              // the native path does, so the durable transcript still carries the real result,
              // and acknowledge inline so the turn can reach the checkpoint that releases it.
              if (call.name === GoalTool.updateName) {
                yield* Effect.interruptible(settle).pipe(
                  Effect.flatMap((settlement) =>
                    Effect.uninterruptible(
                      publish(
                        LLMEvent.toolResult({
                          id: call.id,
                          name: call.name,
                          result: settlement.result,
                          output: settlement.output,
                        }),
                        settlement.outputPaths ?? [],
                      ),
                    ),
                  ),
                  Effect.ensuring(Effect.sync(() => pendingToolCalls.delete(call.id))),
                  FiberSet.run(goalUpdateFibers),
                )
                return { type: "text" as const, value: GOAL_UPDATE_ACCEPTED }
              }
              if (call.name !== "todowrite") substantiveWork = true
              const settlement = yield* restore(
                call.name === "todowrite" ? withTodoPermit(settle) : withToolPermit(settle),
              ).pipe(Effect.exit)
              if (settlement._tag === "Failure") {
                // Match the regular tool path: declining a user prompt halts the
                // turn instead of becoming model-facing tool output. The CLI runs
                // tools out-of-band of the runner's fiber set, so the defect can
                // never reach `awaitToolFibers` — interrupt the turn directly.
                // Forked detached because the bridge's teardown awaits every
                // active MCP call: awaiting the interrupt from inside one of
                // those calls would deadlock on our own settlement.
                if (isUserDeclined(settlement.cause)) yield* Effect.forkDetach(control.interrupt(session.id))
                const result = {
                  type: "error" as const,
                  value: ToolVisibleError.make(Cause.squash(settlement.cause)),
                }
                yield* publish(LLMEvent.toolResult({ id: call.id, name: call.name, result }))
                return result
              }
              if (settlement.value.result.type === "error") {
                yield* publish(
                  LLMEvent.toolResult({
                    id: call.id,
                    name: call.name,
                    result: settlement.value.result,
                    output: settlement.value.output,
                  }),
                  settlement.value.outputPaths ?? [],
                )
                return settlement.value.result
              }
              if (call.name === "todowrite") todoUpdated = true
              yield* publish(
                LLMEvent.toolResult({
                  id: call.id,
                  name: call.name,
                  result: settlement.value.result,
                  output: settlement.value.output,
                }),
                settlement.value.outputPaths ?? [],
              )
              return settlement.value.result
            }),
          )
      }
      let overflowFailure: ProviderErrorEvent | undefined
      let terminalProviderFailure: ProviderErrorEvent | undefined
      // A retryable provider error that arrived *inside* the stream -- Anthropic's
      // `overloaded_error` frame, say, which is delivered on a 200 and so never reaches
      // `RequestExecutor`'s status handling. Held back rather than published, because publishing a
      // provider error fails the assistant message, and a turn that is about to be retried must not
      // leave a failed step behind it. Released below if the retry budget is spent.
      let retryableProviderFailure: ProviderErrorEvent | undefined
      // Suspended so each attempt calls `llm.stream` afresh. A retry has to be a new provider
      // request; re-running a `Stream` value built once would replay whatever the first call
      // produced, which for a rate limit means retrying the rate limit rather than the request.
      let providerAttemptNumber = 0
      const providerAttempt = Effect.suspend(() => {
        providerAttemptNumber += 1
        const attempt = providerAttemptNumber
        const providerStartedAt = Date.now()
        let firstProviderEvent = true
        // Fresh per attempt: a retry issues a new provider request, so repetition measured against
        // the abandoned one must not carry into it.
        const loop = SessionRunnerLoopDetector.make()
        const stream = llm.stream(wireRequest).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (firstProviderEvent) {
                firstProviderEvent = false
                yield* startupPhase("provider_first_event", {
                  attempt,
                  providerElapsedMs: Date.now() - providerStartedAt,
                  eventType: event.type,
                })
              }
              if (overflowFailure || retryableProviderFailure || publisher.hasProviderError()) return
              if (event.type === "text-delta" && loop.observe(event.text)) {
                // Terminal, not retryable: the same request reproduces the same degenerate output,
                // and the turn has already spent most of its output budget saying nothing. Publishing
                // it fails the step, which is what stops the run continuing into another one.
                terminalProviderFailure = LLMEvent.providerError({
                  message:
                    "The model stopped making progress and began repeating itself, so the turn was ended. Nothing it produced after that point was kept.",
                  retryable: false,
                })
                yield* publish(terminalProviderFailure)
                return
              }
              if (LLMEvent.is.providerError(event)) {
                if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                  overflowFailure = event
                  return
                }
                const inferredRetryable =
                  event.retryable !== false && ProviderShared.isTransientProviderError(undefined, event.message)
                if ((event.retryable === true || inferredRetryable) && publisher.isProviderRetrySafe()) {
                  retryableProviderFailure = event
                  return
                }
                terminalProviderFailure = event
              }
              yield* publish(event)
              if (event.type === "tool-error" && event.recoverable === true) {
                needsContinuation = true
                return
              }
              if (event.type !== "tool-call" || event.providerExecuted) return
              if (!toolMaterialization) {
                yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
                return
              }
              needsContinuation = true
              const assistantMessageID = yield* publisher.assistantMessageID(event.id)
              toolTurnIDs.add(assistantMessageID)
              pendingToolCalls.set(event.id, { name: event.name, assistantMessageID, startedAt: Date.now() })
              // Goal updates settle on their own fiber set and are awaited after the real work, so
              // they stay outside the fan-out budget: a bookkeeping call must not queue behind eight
              // `bash` invocations it has nothing to do with, and there is at most one in flight.
              const isGoalUpdate = event.name === GoalTool.updateName
              const isTodoUpdate = event.name === "todowrite"
              if (!isGoalUpdate && !isTodoUpdate) substantiveWork = true
              if (event.name === "question") questionToolInFlight = true
              const settle = toolMaterialization.settle({
                sessionID: session.id,
                agent: agent.id,
                assistantMessageID,
                call: event,
                ...(!isGoalUpdate ? { executeWithPermit: isTodoUpdate ? withTodoPermit : withToolPermit } : {}),
              })
              // The permit is taken *inside* the forked fiber, never before the fork. Acquiring on
              // the stream's own fiber would stop it draining provider events, which is how a full
              // permit set turns into a stalled turn rather than a queued one. It is also inside
              // `restore`, so a call still waiting its turn stays interruptible -- and it is
              // released before publication, because the model-facing result of a finished tool must
              // not be held hostage to a permit.
              yield* Effect.uninterruptibleMask((restore) =>
                restore(settle).pipe(
                  Effect.catchCause((cause) => {
                    if (isUserDeclined(cause) || (event.name === "question" && Cause.hasInterrupts(cause)))
                      userDeclined = true
                    return Effect.failCause(cause)
                  }),
                  Effect.flatMap((settlement) => {
                    if (event.name === "question") questionToolInFlight = false
                    if (settlement.result.type !== "error") {
                      if (isTodoUpdate) todoUpdated = true
                    }
                    return publish(
                      LLMEvent.toolResult({
                        id: event.id,
                        name: event.name,
                        result: settlement.result,
                        output: settlement.output,
                      }),
                      settlement.outputPaths ?? [],
                    )
                  }),
                  Effect.ensuring(Effect.sync(() => pendingToolCalls.delete(event.id))),
                ),
              ).pipe(FiberSet.run(isGoalUpdate ? goalUpdateFibers : toolFibers))
            }),
          ),
          Effect.ensuring(withPublication(publisher.flush())),
        )
        return startupPhase("provider_request_started", { attempt }).pipe(Effect.andThen(stream))
      })

      // Provider retry. Bounded here rather than in `RequestExecutor` because this is the layer
      // that can say so: it owns a durable event, so a wait is something a second viewer can see
      // instead of a session that merely appears stalled.
      //
      // Retrying is safe before visible text or tool input starts. Reasoning-only frames may be
      // replayed: they have no side effects, each attempt is flushed before the next starts, and
      // preserving them is preferable to failing a turn after a transient 200-body decode error.
      // Text and tool input close this window because replay could duplicate user-visible output
      // or a call that may already be executing.
      let providerRetryAttempt = 0
      const providerStream = Effect.gen(function* () {
        while (true) {
          retryableProviderFailure = undefined
          const outcome = yield* Effect.exit(providerAttempt)
          if (outcome._tag === "Failure" && Cause.hasInterrupts(outcome.cause))
            return yield* Effect.failCause(outcome.cause)
          const failure =
            outcome._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(outcome.cause)) : undefined
          const candidate: SessionRunnerRetry.Failure | undefined =
            outcome._tag === "Failure" ? (failure instanceof LLMError ? failure : undefined) : retryableProviderFailure
          const decision =
            candidate && !overflowFailure && publisher.isProviderRetrySafe()
              ? SessionRunnerRetry.decide({
                  failure: candidate,
                  attempt: providerRetryAttempt,
                  now: yield* Clock.currentTimeMillis,
                  provider: modelRef.providerID,
                  jitter: SessionRunnerRetry.jitterFor(session.id, providerRetryAttempt + 1),
                })
              : undefined
          if (!decision) {
            if (outcome._tag === "Success" && retryableProviderFailure) {
              terminalProviderFailure = retryableProviderFailure
              const released = retryableProviderFailure
              retryableProviderFailure = undefined
              yield* publish(released)
            }
            if (outcome._tag === "Failure") return yield* Effect.failCause(outcome.cause)
            return
          }
          providerRetryAttempt = decision.attempt
          yield* publishRetry(decision)
          yield* Effect.sleep(decision.delay)
        }
      })

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          const overflowCause = stream._tag === "Success" ? overflowFailure : failure
          let overflowRecoveryFailure: unknown | undefined
          let overflowRecovered = false
          if (recoverOverflow && !publisher.hasAssistantStarted() && isContextOverflowFailure(overflowCause)) {
            // Recovery runs before the normal settlement tail. Keep a raw summarizer defect in
            // this turn so it can receive the same durable failure treatment as the provider
            // stream; only an interruption returns responsibility to the run-level recorder.
            // Clear progress.recorded before recovery starts: if an interrupt arrives during recovery,
            // the fiber may die before the exit check below. Clearing it early ensures that
            // recordUnstartedInterruption can run and clear durable state (time_compacting).
            const progress = turnProgress.get(session.id)
            const wasRecorded = progress?.recorded ?? true
            if (progress) progress.recorded = false
            const recovery = yield* restore(
              recoverOverflow({ sessionID: session.id, entries: history, model, request }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    const p = turnProgress.get(session.id)
                    if (p) p.recorded = false
                  }),
                ),
              ),
            ).pipe(Effect.exit)
            if (recovery._tag === "Failure") {
              if (Cause.hasInterrupts(recovery.cause)) {
                // Interruption during overflow recovery happens before the recovery outcome was
                // certain. The publisher has not durable started (overflow only happens before
                // any assistant content), so unstarted-interruption settlement is responsible for
                // the turn's terminal status. progress.recorded is already false from above.
                return yield* Effect.failCause(recovery.cause)
              }
              overflowRecoveryFailure = Cause.squash(recovery.cause)
            } else {
              overflowRecovered = recovery.value
              // Recovery succeeded: restore recorded state so settlement doesn't treat this as
              // an unstarted failure. The defect exit will be caught at the caller level and
              // the next turn will run after compaction.
              if (progress) progress.recorded = wasRecorded
            }
          }
          if (overflowRecovered) {
            yield* goalTurn.complete({
              tokenDelta: 0,
              activeTimeMsDelta: yield* activeTimeSince(goalStartedAt),
            })
            yield* goalTurn.checkpoint
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep, todoPrompt))
          }
          if (overflowRecoveryFailure) {
            yield* withPublication(
              publisher.failAssistant(
                `Provider context recovery failed: ${ToolVisibleError.make(overflowRecoveryFailure)}`,
              ),
            )
          } else if (overflowFailure && stream._tag === "Success") {
            // If the provider emitted an overflow frame and then the stream itself failed, the later
            // stream failure is the actionable cause. Publishing the held overflow frame first would
            // mask a raw defect such as a stack overflow behind a provider-looking error.
            yield* publish(overflowFailure)
          }
          const llmFailure = failure instanceof LLMError ? failure : undefined
          // Same-request replay is unsafe after text or tool input has been published. A fresh
          // continuation is still safe while no tool call or step settlement exists: the failed
          // assistant remains durable, incomplete local tool input is explicitly failed below,
          // and the next turn reloads that history instead of replaying this wire request.
          const streamRecoveryDecision =
            streamRecovery === undefined &&
            STREAM_RECOVERY_ROUTES.has(wireRequest.model.route.id) &&
            llmFailure?.reason._tag === "Transport" &&
            llmFailure.reason.kind === "Stream" &&
            llmFailure.retryable &&
            !publisher.isProviderRetrySafe() &&
            publisher.hasAssistantStarted() &&
            !publisher.hasProviderError() &&
            !publisher.hasToolCalls() &&
            publisher.stepSettlement() === undefined
              ? SessionRunnerRetry.decide({
                  failure: llmFailure,
                  attempt: providerRetryAttempt,
                  now: yield* Clock.currentTimeMillis,
                  provider: modelRef.providerID,
                  jitter: SessionRunnerRetry.jitterFor(session.id, providerRetryAttempt + 1),
                })
              : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(
              publisher.failUnsettledTools(
                streamRecoveryDecision
                  ? "Provider stream ended before this tool call completed. The tool was not executed; regenerate the call on the next turn."
                  : "Provider did not return a tool result",
                streamRecoveryDecision === undefined,
              ),
            )
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          } else if (stream._tag === "Failure" && !Cause.hasInterrupts(stream.cause) && !publisher.hasProviderError()) {
            // `Cause.findErrorOption` only finds typed failures, so a defect — an
            // event-contract invariant broken by a provider mapping, say — leaves
            // `llmFailure` undefined and slips past the branch above. Nothing else
            // settles the turn, so the drain dies with the assistant message and
            // its tool calls pending forever and the failure is visible only as an
            // ERROR in the server log. Settle them here; the cause still
            // propagates, so the drain still fails loudly for operators.
            yield* withPublication(
              publisher.failUnsettledTools("Provider stream failed before the tool returned", true),
            )
            yield* withPublication(
              publisher.failAssistant(`Provider stream failed: ${ToolVisibleError.make(Cause.squash(stream.cause))}`),
            )
          }
          if (toolMaterialization) {
            for (const assistantMessageID of toolTurnIDs) {
              yield* toolMaterialization.completeTurn({ sessionID: session.id, assistantMessageID })
            }
          }
          const streamInterrupted = stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)
          if (streamInterrupted && questionToolInFlight) userDeclined = true
          if (streamInterrupted && !questionToolInFlight) yield* FiberSet.clear(toolFibers)
          const regularSettled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          const unsettledToolNames = publisher.unsettledToolNames()
          const interrupted =
            streamInterrupted || (regularSettled._tag === "Failure" && Cause.hasInterrupts(regularSettled.cause))
          userDeclined ||=
            (regularSettled._tag === "Failure" && isUserDeclined(regularSettled.cause)) ||
            (questionToolInFlight && interrupted)
          if (userDeclined) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          }
          const turnInterrupted =
            interrupted &&
            !userDeclined &&
            (publisher.hasActiveAssistant() || unsettledToolNames.some((name) => name !== "question"))
          if (interrupted) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            // Tool interruption after provider completion: fail the assistant even if it is
            // already inactive. A step-finish event marks the assistant inactive but leaves
            // durable `Step` settlement responsible for closure; interruption during the
            // following tool await must prevent that settlement from projecting a terminal idle.
            if (!turnInterrupted && !userDeclined && publisher.hasAssistantStarted())
              yield* withPublication(publisher.failAssistant("Tool execution interrupted during settlement"))
            if (turnInterrupted) yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (regularSettled._tag === "Failure" && !Cause.hasInterrupts(regularSettled.cause) && !userDeclined) {
            const failure = Cause.squash(regularSettled.cause)
            yield* withPublication(
              publisher.failUnsettledTools(`Tool execution failed: ${ToolVisibleError.make(failure)}`),
            )
          }
          const stepSettlement = publisher.stepSettlement()
          if (
            userDeclined &&
            interrupted &&
            !stepSettlement &&
            publisher.hasAssistantStarted() &&
            !publisher.hasProviderError()
          ) {
            // Close the control-cancelled step even when the provider sent no finish event.
            // These zero counters represent unavailable usage, not a measured empty prompt.
            const emptyUsage = {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            }
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: "stop",
                model: modelRef,
                cost: 0,
                tokens: emptyUsage,
                billed: emptyUsage,
              }),
            )
          }
          // Truncated provider stream: ensure a settlement is published even if step-finish never arrived.
          // A stream that ends cleanly without one leaves `stepSettlement` undefined, so nothing below
          // projects a durable settlement and the turn silently succeeds, consuming the prompt without any
          // assistant record. `hasAssistantStarted()` alone missed the emptiest shape of all, because the
          // assistant is lazy: both real bridges open a step before any content exists (aisdk on
          // `stream-start`, the Claude Code CLI on spawn), so a provider that dies in between -- a CLI that
          // exits before its result envelope -- opened a step, started no assistant, and left the session
          // idle with the prompt spent and nothing in the transcript to show for it. A step the provider
          // opened and never closed is the signal; a stream that never spoke at all is left alone.
          if (
            (publisher.hasAssistantStarted() || publisher.hasStepStarted()) &&
            !stepSettlement &&
            stream._tag === "Success" &&
            !publisher.hasProviderError()
          ) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not send step finish", true))
            yield* withPublication(publisher.failAssistant("Provider stream ended without completing the step"))
          }
          yield* goalTurn.complete({
            // `processed`, not `tokens`: goal usage accounts for every provider request
            // the turn made, while `tokens` describes only the last one (context occupancy).
            tokenDelta: goalTokenDelta(stepSettlement?.processed),
            activeTimeMsDelta: yield* activeTimeSince(goalStartedAt),
          })
          yield* goalTurn.checkpoint
          const allowGoalUpdates =
            stream._tag === "Success" &&
            !publisher.hasProviderError() &&
            regularSettled._tag === "Success" &&
            !userDeclined
          if (allowGoalUpdates) yield* goalTurn.allowUpdates
          if (!allowGoalUpdates) yield* FiberSet.clear(goalUpdateFibers)
          const goalUpdatesSettled = yield* restore(awaitToolFibers(goalUpdateFibers)).pipe(Effect.exit)
          const settled = regularSettled._tag === "Failure" ? regularSettled : goalUpdatesSettled
          if (goalUpdatesSettled._tag === "Failure" && !Cause.hasInterrupts(goalUpdatesSettled.cause)) {
            const failure = Cause.squash(goalUpdatesSettled.cause)
            yield* withPublication(
              publisher.failUnsettledTools(`Goal update failed: ${ToolVisibleError.make(failure)}`),
            )
          }
          if (stepSettlement && !publisher.hasProviderError() && !turnInterrupted) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            const billing = SessionRunnerModel.settle(resolvedModel, stepSettlement)
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                model: modelRef,
                ...billing,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          yield* resetReflectionContext(session.id)
          const accountedGoal = yield* getGoal(session.id)
          // A raw provider defect is terminal for this attempt just like a typed provider error.
          // It must not leave an active goal eligible for the next explicit wake: a malformed
          // request can otherwise reproduce the same defect every time the user asks to continue.
          // Interruptions are deliberately excluded because an explicit user stop preserves the
          // active goal for a later resume.
          const failedProviderTurn =
            !userDeclined &&
            !interrupted &&
            streamRecoveryDecision === undefined &&
            (overflowFailure !== undefined ||
              overflowRecoveryFailure !== undefined ||
              terminalProviderFailure !== undefined ||
              llmFailure !== undefined ||
              (stream._tag === "Failure" && !Cause.hasInterrupts(stream.cause)))
          const currentGoal = failedProviderTurn
            ? yield* stopGoal(
                session.id,
                lifecycleGoalAtStart,
                llmFailure?.reason._tag === "QuotaExceeded" ? "usageLimited" : "paused",
              )
            : accountedGoal
          const todoReconcileRequired =
            !publisher.hasProviderError() &&
            !turnInterrupted &&
            regularSettled._tag === "Success" &&
            settled._tag === "Success" &&
            todoPrompt !== "reconcile" &&
            todoPrompt !== "done" &&
            todoToolAvailable &&
            modelRef.providerID !== ClaudeCodeCLI.ID &&
            substantiveWork &&
            !todoUpdated &&
            (todoPrompt === "initial" || SessionTodoGuidance.hasOpenItems(yield* todos.get(session.id)))
          // `markTurnRecorded` handed failure reporting to the publisher before the provider
          // stream opened, but the publisher only opens the durable step lazily, on the first
          // content frame. If the turn is ending and the step never opened -- an interrupt or a
          // defect inside the pre-content window, including the retry backoff wait -- that handoff
          // never became real: nothing above published a single durable event for this turn.
          // Return the responsibility, so the run-level unstarted-interruption/failure settlement
          // still runs and every run ends in a visible terminal state.
          if (!publisher.hasAssistantStarted()) {
            const progress = turnProgress.get(session.id)
            if (progress) progress.recorded = false
          }
          if (streamRecoveryDecision) {
            yield* publishRetry(streamRecoveryDecision)
            yield* restore(Effect.sleep(streamRecoveryDecision.delay))
          }
          if (userDeclined) return yield* Effect.interrupt
          if (stream._tag === "Failure" && !streamRecoveryDecision) return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          const nextTodoPrompt: TodoPrompt | undefined = streamRecoveryDecision
            ? todoPrompt
            : todoPrompt === "done" || todoUpdated
              ? "done"
              : todoPrompt === "reconcile"
                ? "done"
                : todoReconcileRequired
                  ? "reconcile"
                  : undefined
          return {
            ran: true,
            needsContinuation:
              !publisher.hasProviderError() &&
              (needsContinuation || todoReconcileRequired || streamRecoveryDecision !== undefined),
            todoPrompt: nextTodoPrompt,
            step: currentStep,
            goal: currentGoal,
            knownGoal: modelKnownGoal,
            recoverStream: streamRecoveryDecision !== undefined,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurnResult = {
      readonly ran: boolean
      readonly needsContinuation: boolean
      readonly todoPrompt: TodoPrompt | undefined
      readonly step: number
      readonly goal: SessionGoal.Info | undefined
      readonly knownGoal: KnownGoal | undefined
      readonly recoverStream?: boolean
    }
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      goalPrompt: GoalPrompt | undefined,
      knownGoal: KnownGoal | undefined,
      control: SessionExecutionControl.Interface,
      todoPrompt: TodoPrompt | undefined,
      streamRecovery: StreamRecovery | undefined,
      compactBeforeTurn: boolean,
    ) => Effect.Effect<RunTurnResult, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(
      function* (
        sessionID,
        promotion,
        step,
        goalPrompt,
        knownGoal,
        control,
        todoPrompt,
        streamRecovery,
        _compactBeforeTurn,
      ) {
        return yield* runTurnAttempt(
          sessionID,
          promotion,
          step,
          goalPrompt,
          knownGoal,
          control,
          todoPrompt,
          streamRecovery,
          undefined,
          false,
        ).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(
                sessionID,
                undefined,
                defect.transition.step,
                goalPrompt,
                knownGoal,
                control,
                defect.todoPrompt,
                streamRecovery,
                false,
              )
            }),
          ),
        )
      },
    )

    const runTurn: RunTurn = Effect.fnUntraced(
      function* (
        sessionID,
        promotion,
        step,
        goalPrompt,
        knownGoal,
        control,
        todoPrompt,
        streamRecovery,
        compactBeforeTurn,
      ) {
        return yield* runTurnAttempt(
          sessionID,
          promotion,
          step,
          goalPrompt,
          knownGoal,
          control,
          todoPrompt,
          streamRecovery,
          compaction.compactAfterOverflow,
          compactBeforeTurn,
        ).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              yield* Effect.yieldNow
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* runAfterOverflowCompaction(
                  sessionID,
                  undefined,
                  defect.transition.step,
                  goalPrompt,
                  knownGoal,
                  control,
                  defect.todoPrompt,
                  streamRecovery,
                  false,
                )
              return yield* runTurn(
                sessionID,
                undefined,
                defect.transition.step,
                goalPrompt,
                knownGoal,
                control,
                defect.todoPrompt,
                streamRecovery,
                defect.transition._tag === "ContinueAfterPruning",
              )
            }),
          ),
        )
      },
    )

    const run = Effect.fn("SessionRunner.run")(
      function* (input: {
        readonly sessionID: SessionSchema.ID
        readonly force: boolean
        readonly control: SessionExecutionControl.Interface
      }) {
        const drainStartedAt = Date.now()
        const drainPhase = (phase: string) =>
          Effect.logInfo("Session runner drain phase", {
            phase,
            sessionID: input.sessionID,
            elapsedMs: Date.now() - drainStartedAt,
          })
        yield* drainPhase("started")
        turnProgress.set(input.sessionID, { promoted: false, recorded: false })
        const [hasSteer, initialGoal, hasCompactionContinuation] = yield* Effect.all(
          [
            SessionInput.hasPending(db, input.sessionID, "steer"),
            getGoal(input.sessionID),
            SessionHistory.needsContinuation(db, input.sessionID),
          ] as const,
          { concurrency: "unbounded" },
        )
        const hasActiveGoal = initialGoal?.status === "active"
        const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
        if (!input.force && !hasSteer && !hasActiveGoal && !hasQueue && !hasCompactionContinuation) return
        yield* failInterruptedTools(input.sessionID)
        yield* drainPhase("ready")
        let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
        let goalPrompt: GoalPrompt | undefined = !promotion && hasActiveGoal ? "continuation" : undefined
        let knownGoal: KnownGoal | undefined = initialGoal
          ? { id: initialGoal.id, objective: initialGoal.objective }
          : undefined
        let shouldRun = input.force || hasSteer || hasActiveGoal || hasQueue || hasCompactionContinuation
        while (shouldRun) {
          let needsContinuation = true
          let step = 1
          let todoPrompt: TodoPrompt | undefined = "initial"
          let streamRecovery: StreamRecovery | undefined
          while (needsContinuation) {
            const progress = turnProgress.get(input.sessionID)
            if (progress) {
              progress.promoted = false
              progress.recorded = false
            }
            const result: RunTurnResult = yield* runTurn(
              input.sessionID,
              promotion,
              step,
              goalPrompt,
              knownGoal,
              input.control,
              todoPrompt,
              streamRecovery,
              true,
            )
            goalPrompt = undefined
            knownGoal = result.knownGoal
            todoPrompt = result.todoPrompt
            const recoverStream = result.recoverStream === true
            if (!result.ran) {
              needsContinuation = false
              continue
            }
            // Naming happens after a provider turn, not before it: the prompt that names a
            // Session is only durably projected once the turn has promoted it, and a turn that
            // refused to run (`!result.ran`) has no prompt to name anything with. Re-arm it at
            // every boundary while the name is still a placeholder so a transient title failure
            // can recover during a long agent loop. `ensure` coalesces overlapping attempts and
            // stops immediately after a title sticks. Forked, so the conversation never waits.
            yield* title.ensure(input.sessionID).pipe(Effect.forkIn(scope))
            needsContinuation = result.needsContinuation
            step = result.step + (recoverStream ? 0 : 1)
            const hasPendingSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
            const hasPendingQueue = hasPendingSteer
              ? false
              : yield* SessionInput.hasPending(db, input.sessionID, "queue")
            if (!needsContinuation) needsContinuation = hasPendingSteer || hasPendingQueue
            promotion = hasPendingSteer ? "steer" : hasPendingQueue ? "queue" : undefined
            streamRecovery = recoverStream ? { userInputPromoted: promotion !== undefined } : undefined
            goalPrompt = needsContinuation && result.goal?.status === "active" && !promotion ? "reminder" : undefined
          }
          const hasPendingSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          const currentGoal = yield* getGoal(input.sessionID)
          const hasPendingQueue = hasPendingSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
          shouldRun = hasPendingSteer || currentGoal?.status === "active" || hasPendingQueue
          promotion = hasPendingSteer ? "steer" : hasPendingQueue ? "queue" : undefined
          goalPrompt = !promotion && currentGoal?.status === "active" ? "continuation" : undefined
          if (goalPrompt) yield* Effect.yieldNow
        }
      },
      (effect, input) =>
        effect.pipe(
          Effect.onExit((exit) =>
            Effect.logInfo("Session runner exited", {
              sessionID: input.sessionID,
              exit: exit._tag,
              interrupted: exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause),
              cause: exit._tag === "Failure" ? Cause.pretty(exit.cause) : undefined,
              progress: turnProgress.get(input.sessionID),
            }).pipe(
              Effect.andThen(
                exit._tag === "Success"
                  ? Effect.void
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? recordUnstartedInterruption(input.sessionID)
                    : recordUnstartedFailure(input.sessionID, exit.cause),
              ),
              // After the unstarted settlement on purpose: its `Step.Failed` (when it runs) has
              // already replaced the retry row with a terminal status, so this only ever clears a
              // wait nothing else will account for.
              Effect.andThen(settleAbandonedRetry(input.sessionID)),
              Effect.uninterruptible,
            ),
          ),
          Effect.ensuring(Effect.sync(() => turnProgress.delete(input.sessionID))),
        ),
    )

    // Manual compaction runs here rather than in `V2Session` because the LLM client, the model
    // resolver and the agent registry are Location-scoped and the control plane holds none of
    // them. It deliberately does not continue the conversation afterwards -- V1's manual
    // `summarize` also summarised and stopped; only the automatic paths continue.
    const compact = Effect.fn("SessionRunner.compact")(function* (input: { readonly sessionID: SessionSchema.ID }) {
      const session = yield* getSession(input.sessionID)
      yield* toolSnapshots.ready()
      const agent = yield* agents.select(session.agent)
      const resolved = yield* models.resolve(session, agent.info?.request)
      // The effective context, i.e. exactly what the next turn would send: the stored System
      // baseline cutoff and the previous compaction cutoff already applied.
      const messages = yield* SessionHistory.entries(db, session.id)
      const outcome = yield* compaction.compact({
        sessionID: session.id,
        entries: messages,
        model: resolved.model,
      })
      if (!outcome.ok)
        return yield* new SessionCompaction.FailedError({ sessionID: session.id, reason: outcome.reason })
    })

    return Service.of({
      run,
      compact,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    AgentGuidance.node,
    SessionToolSnapshot.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    PermissionV2.node,
    Snapshot.node,
    Database.node,
    SessionGoal.node,
    SessionGoalAccounting.node,
    SessionTodo.node,
    Reflection.node,
    // Needed by SessionRunnerAttachment.materialize: FileSystem.Service reads `file:` attachments
    // off disk, Image.Service resizes materialized images before they reach `toLLMMessages`.
    FSUtil.node,
    Image.node,
  ],
})
