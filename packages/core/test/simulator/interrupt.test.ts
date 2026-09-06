/**
 * Second simulator suite: phase-precise interruption coverage.
 *
 * Where the turn matrix interrupts "somewhere mid-stream", every scenario here pins the interrupt
 * to one specific phase of the pipeline and asserts the settlement that phase must produce:
 *
 *   - mid tool settlement (`sim_slow` is asleep when the interrupt lands)
 *   - while a `question` tool call is parked on a pending QuestionV2 request (settles idle via
 *     the user-declined path — an interrupt of a parked question IS a dismissal)
 *   - a steer prompt racing that same parked question (today's dismissal semantics: the steer
 *     rejects the question, the parked turn halts user-declined, and the steer is delivered in a
 *     successor turn)
 *   - during overflow-compaction recovery, inside the summarization provider request
 *   - twice in a row (the second interrupt must be a no-op)
 *   - followed immediately by a fresh prompt (the successor turn must run clean)
 *   - with a queued input docked (interruption preserves it; a resume drains it)
 *
 * Determinism notes: scenarios that need a guaranteed in-flight window use `stallAfter` streams
 * (only an interrupt ends them) instead of timing margins. Every scenario ends in
 * `invariants.settled`; the harness's 20s hang guard bounds all of them.
 */
import { describe } from "bun:test"
import { eq } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { LLMEvent } from "@turenlabs/llm"
import type { SessionMessage } from "@turenlabs/core/session/message"
import { SessionTable } from "@turenlabs/core/session/sql"
import { contextOverflow, reply, replyWithTool, requestUserTexts, simulate, type ScenarioContext } from "./harness"

const questionInput = {
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
}

const assistantToolParts = (messages: ReadonlyArray<SessionMessage.Message>) =>
  messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")

const erroredToolParts = (messages: ReadonlyArray<SessionMessage.Message>) =>
  assistantToolParts(messages).filter((part) => part.state.status === "error")

const expectLastRequestContains = (ctx: ScenarioContext, text: string) => {
  const last = ctx.provider.requests().at(-1)
  if (!last) throw new Error("expected at least one provider request")
  if (!requestUserTexts(last.request).some((candidate) => candidate.includes(text)))
    throw new Error(
      `expected the last provider request to carry ${JSON.stringify(text)}; ` +
        `saw user texts ${JSON.stringify(requestUserTexts(last.request))}`,
    )
}

describe("phase-precise interruption", () => {
  simulate("interrupt while sim_slow is mid-settlement errors the call and interrupts the turn", (ctx) =>
    Effect.gen(function* () {
      // 10s sleep: far beyond every deadline in play, so the interrupt is guaranteed to land
      // while the tool is genuinely running — the interrupt, not the timer, ends it.
      ctx.provider.enqueue(replyWithTool("sim_slow", { ms: 10_000 }))
      yield* ctx.user.prompt("Run the slow tool, then get interrupted.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const slow = assistantToolParts(messages).filter((part) => part.name === "sim_slow")
      if (slow.length !== 1) throw new Error(`expected exactly one sim_slow call, saw ${slow.length}`)
      if (slow[0]!.state.status !== "error")
        throw new Error(`expected the interrupted sim_slow call to error, saw "${slow[0]!.state.status}"`)
    }),
  )

  simulate("interrupt after provider completion while sim_slow runs fails the completed provider step", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("sim_slow", { ms: 10_000 }))
      yield* ctx.user.prompt("Finish the provider stream, then interrupt the running tool.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.phase.afterProviderEnd()
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })

      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const slow = assistantToolParts(messages).filter((part) => part.name === "sim_slow")
      if (slow.length !== 1 || slow[0]!.state.status !== "error")
        throw new Error(
          `expected one interrupted sim_slow call, saw ${JSON.stringify(slow.map((part) => part.state.status))}`,
        )
    }),
  )

  simulate("interrupt while a question is pending rejects the question and settles idle", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("question", questionInput))
      yield* ctx.user.prompt("Ask, then get interrupted while waiting.")
      yield* ctx.phase.whenQuestionPending()
      yield* ctx.user.interrupt()
      // Pins today's dismissal semantics: interrupting the run fiber removes the pending request
      // (`QuestionV2.ask`'s onInterrupt rejects the deferred and publishes Rejected), and the
      // parked turn surfaces that rejection as the *user-declined* halt — the same settlement an
      // explicit `questions.reject` produces: `Step.Ended` lands first, so durable status is
      // "idle" (NOT the "Provider turn interrupted" failure shape), with the question call
      // errored. An interrupt of a parked question is indistinguishable from dismissing it.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const pending = yield* ctx.services.questions.list()
      if (pending.some((request) => request.sessionID === ctx.sessionID))
        throw new Error("expected the interrupt to clear the pending question request")
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const errored = erroredToolParts(messages)
      if (errored.length !== 1 || errored[0]!.name !== "question")
        throw new Error(
          `expected exactly the question call to error, saw ${JSON.stringify(errored.map((part) => part.name))}`,
        )
    }),
  )

  simulate("interrupting a pending question before step finish settles idle", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue({
        label: "question-without-step-finish",
        events: [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "question-no-finish", name: "question", input: questionInput }),
        ],
        stallAfter: { count: 2 },
      })
      yield* ctx.user.prompt("Ask before the provider finishes its step.")
      yield* ctx.phase.whenQuestionPending()
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const errored = erroredToolParts(messages)
      if (errored.length !== 1 || errored[0]!.name !== "question")
        throw new Error(
          `expected exactly the question call to error, saw ${JSON.stringify(errored.map((part) => part.name))}`,
        )
    }),
  )

  simulate("steer while a question is pending dismisses it and delivers the steer in a successor turn", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("question", questionInput), reply("Followed the fallback plan."))
      yield* ctx.user.prompt("Ask before proceeding.")
      yield* ctx.phase.whenQuestionPending()
      // Today's core fix: a steer admitted while a question is parked rejects the question
      // (V2Session.dismissPendingQuestions), the parked turn halts user-declined, and the wake
      // registered by the prompt delivers the steer in a fresh turn.
      yield* ctx.user.prompt("Use the fallback plan instead.", { delivery: "steer" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      expectLastRequestContains(ctx, "Use the fallback plan instead.")
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const errored = erroredToolParts(messages)
      if (errored.length !== 1 || errored[0]!.name !== "question")
        throw new Error(
          `expected the dismissed question call to error, saw ${JSON.stringify(errored.map((part) => part.name))}`,
        )
      const pending = yield* ctx.services.questions.list()
      if (pending.some((request) => request.sessionID === ctx.sessionID))
        throw new Error("expected the steer to clear the pending question request")
    }),
  )

  simulate("double interrupt: the second is a no-op and nothing double-settles", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Never delivered.", { chunks: 3, interEventDelayMs: 20, stallAfter: { count: 3 } }))
      yield* ctx.user.prompt("Start, stall, and take two interrupts.")
      yield* ctx.phase.whileStalled()
      yield* ctx.user.interrupt()
      // The first interrupt has fully completed (session.interrupt awaits the run fiber), so the
      // second finds no active execution and must return void without error — `orDie` inside the
      // harness's user.interrupt turns any failure here into a loud test failure.
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const assistants = messages.filter((message) => message.type === "assistant")
      if (assistants.length !== 1)
        throw new Error(`expected exactly one assistant message after a double interrupt, saw ${assistants.length}`)
    }),
  )

  simulate("interrupt then immediate re-prompt runs a clean successor turn", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Never delivered.", { chunks: 3, interEventDelayMs: 20, stallAfter: { count: 3 } }),
        reply("Fresh turn completed."),
      )
      yield* ctx.user.prompt("Start the doomed turn.")
      yield* ctx.phase.whileStalled()
      yield* ctx.user.interrupt()
      yield* ctx.user.prompt("Fresh start after the interrupt.")
      // The successor turn promotes the new prompt and completes; the session ends idle even
      // though the first turn settled as an interruption.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      expectLastRequestContains(ctx, "Fresh start after the interrupt.")
    }),
  )

  simulate("queued input survives an interrupted turn and runs in the resumed drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Never delivered.", { chunks: 3, interEventDelayMs: 20, stallAfter: { count: 3 } }),
        reply("Queued follow-up completed."),
      )
      yield* ctx.user.prompt("Start the doomed turn.")
      yield* ctx.phase.whileStalled()
      yield* ctx.user.prompt("After you finish, do this too.", { delivery: "queue" })
      yield* ctx.user.interrupt()
      // The coordinator's interrupt clears the pending wake, so the queued input does NOT start a
      // successor drain by itself — interruption preserves it durably for a later resume
      // (`allowPendingInput` is exactly this contract).
      yield* ctx.invariants.settled(ctx.sessionID, {
        expect: "interrupted",
        minRequests: 1,
        allowPendingInput: true,
      })
      yield* ctx.user.resume()
      // The resumed drain promotes the queued input and completes it; the second `settled` call
      // omits allowPendingInput, so it also proves the input row was consumed rather than orphaned.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      expectLastRequestContains(ctx, "After you finish, do this too.")
    }),
  )
})

describe("interrupt during compaction recovery", () => {
  simulate(
    "interrupt during the overflow summarization request settles the turn",
    (ctx) =>
      Effect.gen(function* () {
        ctx.provider.enqueue(reply("Earlier turn completed."))
        yield* ctx.user.prompt("Create older history first.")
        yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
        ctx.provider.enqueue(
          contextOverflow(),
          reply("Summary never completes.", {
            label: "overflow-summary",
            stallAfter: { count: 2 },
            match: (request) =>
              requestUserTexts(request).some((text) => text.includes("Output exactly the Markdown structure")),
          }),
        )
        yield* ctx.user.prompt("Overflow and compact this turn.")
        yield* ctx.phase.whileStalled(2)
        yield* ctx.user.interrupt()
        yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 3 })

        const row = yield* ctx.services.db
          .select({ time_compacting: SessionTable.time_compacting })
          .from(SessionTable)
          .where(eq(SessionTable.id, ctx.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (row?.time_compacting !== null)
          throw new Error(`expected compaction marker to clear, saw ${JSON.stringify(row?.time_compacting)}`)
      }),
    {
      // Natural compaction requires a realistic context limit so `compactIfNeeded` gate engages.
      // Without this, the route's default 200k window keeps per-turn compaction inert, and only
      // the scripted overflow frame routes into recovery (which is a different code path).
      modelContextLimit: { context: 8_000, output: 2_000 },
    },
  )

  simulate(
    "interrupt during overflow summarization clears durable compaction marker",
    (ctx) =>
      Effect.gen(function* () {
        // This scenario tests the known FINDING: interrupting overflow-compaction recovery
        // during the summarization request should clear durable status and `time_compacting`,
        // but currently may leave it stranded.
        ctx.provider.enqueue(reply("Setup history."))
        yield* ctx.user.prompt("Create context.")
        yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

        // Fill the context window with enough text to trigger natural compaction on next turn.
        ctx.provider.enqueue(
          // First: the natural compaction preflight summarization request
          reply("Summary of earlier.", {
            label: "natural-summary",
            match: (request) =>
              requestUserTexts(request).some((text) => text.includes("Output exactly the Markdown structure")),
          }),
          // Then: the resumed turn after compaction, which stalls mid-stream
          reply("Hung summary.", {
            chunks: 2,
            interEventDelayMs: 30,
            stallAfter: { count: 1 },
            match: (request) =>
              requestUserTexts(request).some((text) => !text.includes("Output exactly the Markdown structure")),
          }),
        )

        // Trigger natural compaction by filling the window
        yield* ctx.user.prompt("Fill the window. ".repeat(250) + "Now overflow naturally.")
        yield* ctx.phase.whileStalled(2)

        // Interrupt during the stalled summarization.
        yield* ctx.user.interrupt()

        yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 3 })

        // The durable compaction marker should be cleared, not left stranded.
        const row = yield* ctx.services.db
          .select({ time_compacting: SessionTable.time_compacting, status: SessionTable.status })
          .from(SessionTable)
          .where(eq(SessionTable.id, ctx.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (row?.time_compacting !== null)
          throw new Error(
            `[compaction-interrupt] expected time_compacting to clear, saw ${JSON.stringify(row?.time_compacting)} (status=${row?.status})`,
          )
      }),
    {
      modelContextLimit: { context: 8_000, output: 2_000 },
    },
  )

  simulate("interrupt after provider completes but during tool settlement settles failed", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("sim_slow", { ms: 500 }, { label: "provider-with-tool" }))
      yield* ctx.user.prompt("Call a tool and interrupt mid-execution.")
      // After the first byte, the provider has begun streaming the response. Let it complete
      // the tool-call event and step-finish, then interrupt while the local tool is still running.
      // This targets the specific window: provider stream is done, assistant is marked inactive
      // by step-finish, but tool fibers are still executing and haven't yet settled.
      yield* ctx.phase.afterFirstByte()
      yield* Effect.sleep(Duration.millis(100)) // ensure provider has fully completed
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })

      // Verify the assistant message records the interruption. The runner writes it on the
      // message's `error` field (`failAssistant`), not as a content part — assistant content is
      // only text / reasoning / tool.
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const lastAssistant = messages.findLast((m): m is SessionMessage.Assistant => m.type === "assistant")
      if (!lastAssistant) throw new Error("expected an assistant message recording the tool-settlement interruption")
      if (!/interrupted/i.test(lastAssistant.error?.message ?? ""))
        throw new Error(
          `expected the assistant message to record the interruption, saw ${JSON.stringify(lastAssistant.error ?? null)}`,
        )
    }),
  )

  simulate("truncated provider stream (only step-start with no step-finish) settles failed", (ctx) =>
    Effect.gen(function* () {
      // A bare `step-start` and nothing else: the step is opened and never closed, which is the
      // exact shape the runner treats as a truncated stream. `reply` always emits a full
      // text turn, so this behavior is written out longhand rather than through a builder.
      ctx.provider.enqueue({
        label: "truncated-stream",
        events: [LLMEvent.stepStart({ index: 0 })],
      })
      yield* ctx.user.prompt("Get a truncated response with missing step-finish.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 1 })

      // Verify the truncated stream did not silently succeed without a settlement.
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const lastAssistant = messages.findLast((m): m is SessionMessage.Assistant => m.type === "assistant")
      if (!lastAssistant) throw new Error("expected an assistant message for the truncated stream")
      if (!/without completing the step/i.test(lastAssistant.error?.message ?? ""))
        throw new Error(
          `expected the truncated stream to be recorded as an unfinished step, saw ${JSON.stringify(lastAssistant.error ?? null)}`,
        )
    }),
  )
})
