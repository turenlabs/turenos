/**
 * First simulator suite: the provider x user turn matrix.
 *
 * Provider dimension: fast reply, slow first byte (300ms), inter-chunk delay (50ms),
 * stall-after-2 (only meaningful with a user interrupt), overloaded-then-reply (retryable
 * provider-error frame, ~2s live-clock backoff), typed failure mid-stream, defect mid-stream.
 *
 * User dimension: none, interrupt after first byte, steer mid-stream, queue mid-stream.
 *
 * Invalid combos (documented, deliberately not generated):
 *   - fast-reply x interrupt: the turn can finish before the interrupt lands, so the terminal
 *     status is a race between "idle" and "interrupted" — there is no honest expectation.
 *   - stall-after-2 x none/steer/queue: a stalled provider stream never ends and steer/queue
 *     continuations only start after the current turn ends, so nothing settles without an
 *     interrupt. That is the stall's defining property, not a bug in the stack.
 *   - overloaded-then-reply x interrupt: the interrupt must land inside the retry backoff wait,
 *     which `whenAssistantStreaming` cannot synchronize on -- covered by a dedicated regression
 *     scenario below the matrix instead (formerly a FINDING: it stranded durable status "retry").
 *
 * The interrupt user action synchronizes on `whenAssistantStreaming` (assistant durably started),
 * not just first byte: interrupting in the pre-content window settles differently (an
 * unstarted-interruption record) and has its own regression scenario below (formerly a FINDING).
 *
 * Every scenario ends in `invariants.settled` (status, transcript, input rows, questions, tasks).
 */
import { describe } from "bun:test"
import { Duration, Effect } from "effect"
import { eq } from "drizzle-orm"
import { SessionTable } from "@turenlabs/core/session/sql"
import type { LLMRequest } from "@turenlabs/llm"
import {
  contextOverflow as _contextOverflow, // exercised by follow-up suites; imported so drift breaks loudly here
  matrix,
  overloadedThenReply,
  reply,
  replyWithTool,
  requestUserTexts,
  simulate,
  toolCallEvents,
  transportError,
  type ScenarioContext,
  type SettleOptions,
} from "./harness"

type UserKey = "none" | "interrupt" | "steer" | "queue"

interface ProviderSpec {
  /** Queues the behaviors for the opening turn. */
  readonly arm: (ctx: ScenarioContext) => void
  /** Queues one further plain reply turn (consumed by the steer/queue continuation). */
  readonly extraTurn: (ctx: ScenarioContext) => void
  /** Interrupts synchronize on the stall instrument instead of first byte when set. */
  readonly interruptAt?: "first-byte" | "stalled"
  /** Expected settlement per user action; a missing key marks the combo invalid. */
  readonly outcomes: Partial<Record<UserKey, SettleOptions>>
}

interface UserSpec {
  readonly key: UserKey
  readonly act: (ctx: ScenarioContext, provider: ProviderSpec) => Effect.Effect<unknown>
}

const extraTurn = (ctx: ScenarioContext) => ctx.provider.enqueue(reply("Follow-up turn complete."))

const providerDim: Record<string, ProviderSpec> = {
  "fast-reply": {
    arm: (ctx) => ctx.provider.enqueue(reply("Fast answer.", { chunks: 2 })),
    extraTurn,
    outcomes: {
      none: { expect: "idle", minRequests: 1 },
      // interrupt: invalid — see the suite header.
      steer: { expect: "idle", minRequests: 2 },
      queue: { expect: "idle", minRequests: 2 },
    },
  },
  "slow-first-byte": {
    arm: (ctx) =>
      ctx.provider.enqueue(
        reply("Slow to start, steady after.", { chunks: 3, firstByteDelayMs: 300, interEventDelayMs: 40 }),
      ),
    extraTurn,
    outcomes: {
      none: { expect: "idle", minRequests: 1 },
      interrupt: { expect: "interrupted", minRequests: 1 },
      steer: { expect: "idle", minRequests: 2 },
      queue: { expect: "idle", minRequests: 2 },
    },
  },
  "inter-chunk-50ms": {
    arm: (ctx) => ctx.provider.enqueue(reply("Chunk by chunk by chunk.", { chunks: 4, interEventDelayMs: 50 })),
    extraTurn,
    outcomes: {
      none: { expect: "idle", minRequests: 1 },
      interrupt: { expect: "interrupted", minRequests: 1 },
      steer: { expect: "idle", minRequests: 2 },
      queue: { expect: "idle", minRequests: 2 },
    },
  },
  "stall-after-2": {
    arm: (ctx) =>
      ctx.provider.enqueue(reply("Never delivered.", { chunks: 3, interEventDelayMs: 20, stallAfter: { count: 2 } })),
    extraTurn,
    interruptAt: "stalled",
    outcomes: {
      // Only an interrupt ends a stalled stream; every other pairing is invalid by construction.
      interrupt: { expect: "interrupted", minRequests: 1 },
    },
  },
  "overloaded-then-reply": {
    arm: (ctx) => ctx.provider.enqueue(overloadedThenReply("Recovered after overload.")),
    extraTurn,
    outcomes: {
      // The retryable frame is held back and the attempt is retried after ~2s of live-clock
      // backoff, so the opening turn spans two provider requests.
      none: { expect: "idle", minRequests: 2 },
      // interrupt: covered by the dedicated retry-wait regression scenario below the matrix.
      steer: { expect: "idle", minRequests: 3 },
      queue: { expect: "idle", minRequests: 3 },
    },
  },
  "typed-failure-mid-stream": {
    // Two text deltas land, then the stream fails with a typed transport LLMError. The assistant
    // has started, so the session retry ladder is out of play and the failure is terminal.
    arm: (ctx) =>
      ctx.provider.enqueue(
        reply("Doomed by transport.", {
          chunks: 3,
          interEventDelayMs: 60,
          failAfter: { count: 4, error: transportError() },
        }),
      ),
    extraTurn,
    outcomes: {
      none: { expect: "failed", minRequests: 1 },
      interrupt: { expect: "interrupted", minRequests: 1 },
      // A wake registered while the failing turn ran starts a successor drain, which promotes the
      // steer/queue input and completes it in a fresh turn: the session ends idle, not failed.
      steer: { expect: "idle", minRequests: 2 },
      queue: { expect: "idle", minRequests: 2 },
    },
  },
  "defect-mid-stream": {
    arm: (ctx) =>
      ctx.provider.enqueue(reply("Doomed by defect.", { chunks: 3, interEventDelayMs: 60, dieAfter: { count: 4 } })),
    extraTurn,
    outcomes: {
      none: { expect: "failed", minRequests: 1 },
      interrupt: { expect: "interrupted", minRequests: 1 },
      steer: { expect: "idle", minRequests: 2 },
      queue: { expect: "idle", minRequests: 2 },
    },
  },
}

const userDim: Record<string, UserSpec> = {
  none: { key: "none", act: () => Effect.void },
  "interrupt-after-first-byte": {
    key: "interrupt",
    // First byte alone is not enough for a *streamed* interruption record: the publisher starts
    // the assistant lazily on the first content frame, so the interrupt also waits for the
    // assistant to exist durably. Interrupting inside the pre-content window settles as an
    // unstarted interruption instead -- see the first regression scenario below the matrix.
    act: (ctx, provider) =>
      (provider.interruptAt === "stalled"
        ? ctx.phase.whileStalled()
        : ctx.phase.afterFirstByte().pipe(Effect.andThen(ctx.phase.whenAssistantStreaming()))
      ).pipe(Effect.andThen(ctx.user.interrupt())),
  },
  "steer-mid-stream": {
    key: "steer",
    act: (ctx) =>
      ctx.phase.afterFirstByte().pipe(Effect.andThen(ctx.user.prompt("Change of plans.", { delivery: "steer" }))),
  },
  "queue-mid-stream": {
    key: "queue",
    act: (ctx) =>
      ctx.phase
        .afterFirstByte()
        .pipe(Effect.andThen(ctx.user.prompt("After you finish, do this too.", { delivery: "queue" }))),
  },
}

describe("turn matrix", () => {
  matrix({ provider: providerDim, user: userDim }, ({ providerName, userName, provider, user }) => {
    const outcome = provider.outcomes[user.key]
    if (!outcome) return
    simulate(`${providerName} x ${userName}`, (ctx) =>
      Effect.gen(function* () {
        provider.arm(ctx)
        if (user.key === "steer" || user.key === "queue") provider.extraTurn(ctx)
        yield* ctx.user.prompt("Start the work.")
        yield* user.act(ctx, provider)
        yield* ctx.invariants.settled(ctx.sessionID, outcome)
      }),
    )
  })

  // Formerly a FINDING: interrupting a turn after the stream's first frame but before the first
  // *content* frame erased the turn from the durable record. `SessionRunnerLLM` hands failure
  // reporting to the publisher before the provider stream starts (`markTurnRecorded`), but the
  // publisher only publishes `Step.Started` lazily on the first content frame — so an interrupt in
  // that window was reported by NEITHER party: no assistant message, no `Step.Failed`, durable
  // status stayed "idle", while a real provider request was made and the user's prompt was
  // consumed (promoted). The runner now returns the handoff when a turn ends with the step never
  // opened, so the run-level unstarted-interruption settlement records the turn ("Provider turn
  // interrupted before it started") and the status settles as the interruption terminal.
  simulate("interrupt in the pre-content window durably records the turn", (ctx) =>
    Effect.gen(function* () {
      // Only `step-start` is ever emitted, so the pre-content window stays open until the
      // interrupt lands — deterministically, with no content frame racing it.
      ctx.provider.enqueue(reply("Never delivered.", { stallAfter: { count: 1 } }))
      yield* ctx.user.prompt("Start the work.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })
      // The consumed prompt AND the interruption are both durable: the turn is not erased.
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const assistants = messages.flatMap((message) => (message.type === "assistant" ? [message] : []))
      if (assistants.length !== 1) throw new Error(`expected one assistant record, saw ${assistants.length}`)
      const error = assistants[0]!.error
      if (!/interrupted before it started/i.test(error?.message ?? ""))
        throw new Error(`expected an unstarted-interruption record, saw ${JSON.stringify(error ?? null)}`)
    }),
  )

  // Formerly a FINDING: interrupting a session-level retry wait stranded a non-terminal durable
  // status. With a retryable provider-error frame the runner publishes `SessionEvent.Retried`
  // (status "retry", message "Overloaded", status_owner = this process) and sleeps ~2s;
  // `session.interrupt` during that sleep ends the run and empties the coordinator, and nothing
  // cleared the status row — the session durably claimed "waiting to retry" with a live owner
  // forever, repairable only by `V2Session.recover` (a restart path). The retry wait is now
  // interruption-aware: the run-level settlement records the unstarted interruption (its
  // `Step.Failed` replaces the retry row with the interruption terminal), and any exit that still
  // owns a "retry" row clears it. This is also why overloaded-then-reply x interrupt is not
  // generated in the matrix: the interrupt must land inside the backoff wait, synchronized on the
  // durable retry claim itself rather than any streaming phase.
  simulate("interrupt during a provider retry wait settles durable status 'retry'", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(overloadedThenReply("Recovered after overload."))
      yield* ctx.user.prompt("Start the work.")
      yield* ctx.phase.afterFirstByte()
      // Synchronize on the durable retry claim, not wall-clock guesswork: once the row says
      // "retry" the runner is inside its ~2s backoff sleep, leaving a wide interrupt window.
      yield* ctx.step("poll(status=retry)")
      const startedAt = Date.now()
      while (true) {
        const row = yield* ctx.services.db
          .select({ status: SessionTable.status, status_owner: SessionTable.status_owner })
          .from(SessionTable)
          .where(eq(SessionTable.id, ctx.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (row?.status === "retry") {
          if (row.status_owner === null) throw new Error("retry status row must name its owning process")
          break
        }
        if (Date.now() - startedAt > 4_000)
          throw new Error(`status never reached "retry" (saw ${JSON.stringify(row?.status ?? null)})`)
        yield* Effect.sleep(Duration.millis(10))
      }
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })
      // The retry attempt never ran: one provider request was made and the queued recovery reply
      // was never consumed.
      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected exactly one provider request, saw ${ctx.provider.requests().length}`)
      if (ctx.provider.queued() !== 1)
        throw new Error(`expected the recovery reply to stay queued, saw ${ctx.provider.queued()} queued`)
    }),
  )
})

describe("scenario toolkit", () => {
  simulate("sim_slow completes and the turn continues", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("sim_slow", { ms: 150 }), reply("Slept and finished."))
      yield* ctx.user.prompt("Run the slow tool.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
    }),
  )

  simulate("sim_fail surfaces a typed tool failure and the turn continues", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("sim_fail", { message: "deliberate failure" }),
        reply("Recovered from the tool failure."),
      )
      yield* ctx.user.prompt("Run the failing tool.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      // The failed call must be terminal as an error, not merely absent.
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const failed = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part) => part.type === "tool" && part.state.status === "error")
      if (failed.length !== 1) throw new Error(`expected exactly one errored tool part, saw ${failed.length}`)
    }),
  )

  simulate("sim_huge returns a large payload without wedging the turn", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("sim_huge", { bytes: 200_000 }), reply("Digested the large output."))
      yield* ctx.user.prompt("Run the huge tool.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
    }),
  )

  simulate("sim_hang is only ended by a user interrupt", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("sim_hang", {}))
      yield* ctx.user.prompt("Run the hanging tool.")
      yield* ctx.phase.whenToolRunning("sim_hang")
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })
    }),
  )
})

describe("question flow", () => {
  simulate("question answered resumes the turn with the user's answers", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("question", {
          questions: [
            {
              question: "Proceed with the plan?",
              header: "Confirm",
              options: [
                { label: "Yes", description: "Go ahead" },
                { label: "No", description: "Stop here" },
              ],
            },
          ],
        }),
        reply("Continuing with the confirmed plan."),
      )
      yield* ctx.user.prompt("Ask before proceeding.")
      yield* ctx.phase.whenQuestionPending()
      yield* ctx.user.answerQuestion()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
    }),
  )

  simulate("question rejected halts the turn as user-declined", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("question", {
          questions: [
            {
              question: "Proceed with the plan?",
              header: "Confirm",
              options: [{ label: "Yes", description: "Go ahead" }],
            },
          ],
        }),
      )
      yield* ctx.user.prompt("Ask before proceeding.")
      yield* ctx.phase.whenQuestionPending()
      yield* ctx.user.rejectQuestion()
      // A decline settles the streamed step (`Step.Ended`) and then halts the run as an
      // interruption, so the durable status lands `idle` with the question call errored — the
      // same shape the runner's own question tests assert.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const errored = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part) => part.type === "tool" && part.state.status === "error")
      if (errored.length !== 1) throw new Error(`expected the rejected question call to error, saw ${errored.length}`)
    }),
  )
})

describe("subagent flow", () => {
  // Ordering contract in practice: after spawn_agent settles, the parent's follow-up request and
  // the child's first request race, so every behavior is matched to its session by user text.
  simulate("spawn_agent runs a child from the same queue and wait_agents returns its result", (ctx) =>
    Effect.gen(function* () {
      const parentMatch = (request: LLMRequest) =>
        requestUserTexts(request).some((text) => text.includes("Coordinate the child agents"))
      const childMatch = (request: LLMRequest) =>
        requestUserTexts(request).some((text) => text.includes("Report the child result"))
      ctx.provider.enqueue(
        replyWithTool(
          "spawn_agent",
          { agent: "explore", description: "Sim child probe", prompt: "Report the child result now." },
          { match: parentMatch, label: "parent-spawn" },
        ),
        {
          label: "parent-wait",
          match: parentMatch,
          // Lazy: the task ID only exists once the spawn actually ran.
          events: Effect.gen(function* () {
            const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
            return toolCallEvents("wait_agents", { task_ids: children.map((task) => task.id), timeout_ms: 15_000 })
          }),
        },
        reply("All child work is done.", { match: parentMatch, label: "parent-final" }),
        reply("Child result: probe complete.", { match: childMatch, label: "child-turn" }),
        // The settle drain queues a terminal-state advisory on the parent; it may
        // promote into its own turn after the final reply, so script that turn too.
        reply("Settle advisory noted.", {
          match: (request) => requestUserTexts(request).some((text) => text.includes("reached a terminal state")),
          label: "parent-settle-advisory",
        }),
      )
      yield* ctx.user.prompt("Coordinate the child agents.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })
      const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
      if (children.length !== 1) throw new Error(`expected one subagent task, saw ${children.length}`)
      if (children[0]!.status !== "completed")
        throw new Error(`expected the subagent task to complete, saw "${children[0]!.status}"`)
      yield* ctx.invariants.settled(children[0]!.childSessionID, { expect: "idle", minRequests: 4 })
    }),
  )
})
