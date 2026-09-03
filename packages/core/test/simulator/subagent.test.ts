/**
 * Third simulator suite: slow and failed subagent children.
 *
 * Builds on the turn-matrix subagent scenario (happy path) with the unhappy phases:
 *
 *   - a stalled child that outlives `wait_agents`' timeout (the parent settles idle around a
 *     still-running child, then `interrupt_agent` completes it)
 *   - a child whose provider fails typed mid-stream (task terminal "failed", reported via wait)
 *   - the parent interrupted while children run (the root cancellation cascade: child sessions
 *     interrupted, tasks "cancelled", no pending operations left behind)
 *   - two children at different speeds gathered by one wait
 *   - a child that itself parks on a `question` (rejection settles child, task, and parent)
 *
 * Ordering contract (see the harness header): `spawn_agent` returns as soon as the child prompt
 * is admitted, so parent continuation requests race child first requests. Every behavior below is
 * therefore `match`-tagged on a user-text fragment unique to its session, and behaviors that need
 * task IDs are lazy (`events` as an Effect) because those IDs only exist after the spawn ran.
 *
 * Task-status vocabulary pinned here (session/task.ts): a child whose drain completes settles its
 * task "completed"; a typed drain failure settles it "failed"; a drain that exits interrupted
 * settles it "interrupted"; and every *cancellation* path (`interrupt_agent`'s
 * `completeInterrupt`, the user-interrupt root cascade) commits "cancelled".
 */
import { describe } from "bun:test"
import { DateTime, Duration, Effect } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent, type LLMRequest } from "@turenlabs/llm"
import type { SessionMessage } from "@turenlabs/core/session/message"
import { SessionTaskOperationTable } from "@turenlabs/core/session/task.sql"
import type { SessionTaskV2 } from "@turenlabs/core/session/task"
import {
  reply,
  replyWithTool,
  requestUserTexts,
  simulate,
  toolCallEvents,
  transportError,
  type ScenarioContext,
} from "./harness"

const matchText = (fragment: string) => (request: LLMRequest) =>
  requestUserTexts(request).some((text) => text.includes(fragment))

const questionInput = {
  questions: [
    {
      question: "Which probe should the child run?",
      header: "Child confirm",
      options: [{ label: "Deep probe", description: "Slower but complete" }],
    },
  ],
}

interface WaitTaskView {
  readonly task_id: string
  readonly session_id: string
  readonly description: string
  readonly status: string
  readonly result?: string
  readonly error?: string
}

interface WaitOutput {
  readonly tasks: ReadonlyArray<WaitTaskView>
  readonly timed_out: boolean
}

/** The structured output of the newest completed `wait_agents` call in the parent transcript. */
const lastWaitOutput = (ctx: ScenarioContext) =>
  Effect.gen(function* () {
    const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
    const waits = messages
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .filter((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.name === "wait_agents")
    const last = waits.at(-1)
    if (!last) throw new Error("expected a wait_agents call in the parent transcript")
    if (last.state.status !== "completed")
      throw new Error(`expected the wait_agents call to complete, saw "${last.state.status}"`)
    return last.state.structured as unknown as WaitOutput
  })

const onlyChildTask = (ctx: ScenarioContext) =>
  Effect.gen(function* () {
    const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
    if (children.length !== 1) throw new Error(`expected exactly one subagent task, saw ${children.length}`)
    return children[0]!
  })

/** Lazy behavior events for a wait_agents call over every child task known at request time. */
const lazyWait = (ctx: ScenarioContext, timeoutMs: number) =>
  Effect.gen(function* () {
    const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
    return toolCallEvents("wait_agents", { task_ids: children.map((task) => task.id), timeout_ms: timeoutMs })
  })

const pollUntil = <A>(label: string, get: Effect.Effect<A | undefined>, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    while (true) {
      const value = yield* get
      if (value !== undefined) return value
      if (Date.now() - startedAt > timeoutMs)
        return yield* Effect.die(new Error(`[subagent-suite poll:${label}] not satisfied within ${timeoutMs}ms`))
      yield* Effect.sleep(Duration.millis(25))
    }
  })

describe("subagent slow and failed children", () => {
  simulate("wait_agents times out on a stalled child; interrupt_agent then completes it", (ctx) =>
    Effect.gen(function* () {
      const parentMatch = matchText("Coordinate the stalled child")
      const childMatch = matchText("Stall forever child assignment")
      ctx.provider.enqueue(
        replyWithTool(
          "spawn_agent",
          { agent: "explore", description: "Stalled sim child", prompt: "Stall forever child assignment." },
          { match: parentMatch, label: "parent-spawn" },
        ),
        // The child's stream parks after step-start/text-start/one delta; only an interrupt ends
        // it, so the task deterministically outlives the 400ms wait below.
        reply("Never finishes.", {
          match: childMatch,
          label: "child-stall",
          chunks: 3,
          interEventDelayMs: 20,
          stallAfter: { count: 3 },
        }),
        { label: "parent-wait", match: parentMatch, events: lazyWait(ctx, 400) },
        reply("Child still running; reporting the timeout.", { match: parentMatch, label: "parent-after-timeout" }),
      )
      yield* ctx.user.prompt("Coordinate the stalled child.")
      // A wait timeout does not cancel children: the parent's turn completes and the session goes
      // idle while the child task legitimately stays "running" (hence allowActiveTasks).
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4, allowActiveTasks: true })
      const timedOut = yield* lastWaitOutput(ctx)
      if (!timedOut.timed_out) throw new Error("expected the wait_agents call to report timed_out")
      if (timedOut.tasks[0]?.status !== "running")
        throw new Error(`expected the timed-out snapshot to show a running child, saw "${timedOut.tasks[0]?.status}"`)
      const running = yield* onlyChildTask(ctx)
      if (running.status !== "running")
        throw new Error(`expected the child task to stay running after the timeout, saw "${running.status}"`)

      // Second turn: interrupt_agent persists the durable interrupt intent, stops the child's
      // execution, and commits cancellation.
      ctx.provider.enqueue(
        {
          label: "parent-interrupt",
          match: parentMatch,
          events: Effect.gen(function* () {
            const task = yield* onlyChildTask(ctx)
            return toolCallEvents("interrupt_agent", { task_id: task.id })
          }),
        },
        reply("Child interrupted and cancelled.", { match: parentMatch, label: "parent-final" }),
      )
      yield* ctx.user.prompt("Now interrupt the stalled child.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 6 })
      const cancelled = yield* onlyChildTask(ctx)
      if (cancelled.status !== "cancelled")
        throw new Error(`expected interrupt_agent to commit "cancelled", saw "${cancelled.status}"`)
      // The child's own session settled as an in-process interruption of its stalled stream.
      yield* ctx.invariants.settled(cancelled.childSessionID, { expect: "interrupted", minRequests: 6 })
      // The interrupt operation was completed, not left pending.
      const pendingOps = yield* ctx.services.db
        .select({ id: SessionTaskOperationTable.id })
        .from(SessionTaskOperationTable)
        .where(eq(SessionTaskOperationTable.status, "pending"))
        .all()
        .pipe(Effect.orDie)
      if (pendingOps.length > 0)
        throw new Error(`expected no pending task operations, saw ${JSON.stringify(pendingOps)}`)
    }),
  )

  simulate("a typed child provider failure lands the task 'failed' and wait_agents reports it", (ctx) =>
    Effect.gen(function* () {
      const parentMatch = matchText("Coordinate the failing child")
      const childMatch = matchText("Fail with transport child assignment")
      ctx.provider.enqueue(
        replyWithTool(
          "spawn_agent",
          { agent: "explore", description: "Failing sim child", prompt: "Fail with transport child assignment." },
          { match: parentMatch, label: "parent-spawn" },
        ),
        // Two text deltas land before the typed failure, so the child's assistant has started and
        // the failure is terminal for its turn (no session retry ladder).
        reply("Doomed child reply.", {
          match: childMatch,
          label: "child-typed-failure",
          chunks: 3,
          interEventDelayMs: 30,
          failAfter: { count: 4, error: transportError("Child transport failed") },
        }),
        { label: "parent-wait", match: parentMatch, events: lazyWait(ctx, 15_000) },
        reply("Observed the child failure.", { match: parentMatch, label: "parent-final" }),
      )
      yield* ctx.user.prompt("Coordinate the failing child.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })
      const task = yield* onlyChildTask(ctx)
      if (task.status !== "failed") throw new Error(`expected the child task to fail, saw "${task.status}"`)
      if (task.error === undefined) throw new Error("expected the failed task to carry an error")
      const output = yield* lastWaitOutput(ctx)
      if (output.timed_out) throw new Error("expected the wait to return without a timeout")
      if (output.tasks[0]?.status !== "failed" || output.tasks[0].error === undefined)
        throw new Error(`expected wait_agents to report the failed child, saw ${JSON.stringify(output.tasks[0])}`)
      // The child session itself is durably failed with the provider's (non-interrupt) message.
      yield* ctx.invariants.settled(task.childSessionID, { expect: "failed", minRequests: 4 })
    }),
  )

  simulate("interrupting the parent cascades: child session interrupted, task cancelled", (ctx) =>
    Effect.gen(function* () {
      const parentMatch = matchText("Coordinate then get interrupted")
      const childMatch = matchText("Stall forever child assignment")
      ctx.provider.enqueue(
        replyWithTool(
          "spawn_agent",
          { agent: "explore", description: "Cascade sim child", prompt: "Stall forever child assignment." },
          { match: parentMatch, label: "parent-spawn" },
        ),
        // Both follow-up streams stall with durable content: the child's first turn and the
        // parent's post-spawn continuation. Requests #1 and #2 race for order, but both park on
        // their stall instruments, so awaiting both pins "parent mid-turn AND child mid-turn".
        reply("Child never finishes.", {
          match: childMatch,
          label: "child-stall",
          chunks: 3,
          interEventDelayMs: 20,
          stallAfter: { count: 3 },
        }),
        reply("Parent never finishes.", {
          match: parentMatch,
          label: "parent-stall",
          chunks: 3,
          interEventDelayMs: 20,
          stallAfter: { count: 3 },
        }),
      )
      yield* ctx.user.prompt("Coordinate then get interrupted.")
      yield* ctx.phase.whileStalled(1)
      yield* ctx.phase.whileStalled(2)
      // V2Session.interrupt runs the root cascade first (`cancelRootWithInterrupt`): the child's
      // execution is interrupted and its task committed "cancelled" before the parent's own run
      // fiber is interrupted.
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 3 })
      const task = yield* onlyChildTask(ctx)
      if (task.status !== "cancelled")
        throw new Error(`expected the cascade to cancel the child task, saw "${task.status}"`)
      yield* ctx.invariants.settled(task.childSessionID, { expect: "interrupted", minRequests: 3 })
      // The known morning failure mode is a stuck non-terminal operation ("pending interrupt op",
      // session/task.ts) or task after a parent interrupt; pin its absence explicitly.
      const pendingOps = yield* ctx.services.db
        .select({ id: SessionTaskOperationTable.id, kind: SessionTaskOperationTable.kind })
        .from(SessionTaskOperationTable)
        .where(eq(SessionTaskOperationTable.status, "pending"))
        .all()
        .pipe(Effect.orDie)
      if (pendingOps.length > 0)
        throw new Error(`expected no pending task operations after the cascade, saw ${JSON.stringify(pendingOps)}`)
    }),
  )

  simulate("two children at different speeds settle through one wait_agents call", (ctx) =>
    Effect.gen(function* () {
      const parentMatch = matchText("Coordinate two children")
      ctx.provider.enqueue(
        {
          label: "parent-spawn-two",
          match: parentMatch,
          events: [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({
              id: "spawn-fast",
              name: "spawn_agent",
              input: {
                agent: "explore",
                description: "Fast sim child",
                prompt: "Fast child assignment: reply at once.",
              },
            }),
            LLMEvent.toolCall({
              id: "spawn-slow",
              name: "spawn_agent",
              input: {
                agent: "explore",
                description: "Slow sim child",
                prompt: "Slow child assignment: reply after a delay.",
              },
            }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
        },
        reply("Fast child done.", { match: matchText("Fast child assignment"), label: "child-fast" }),
        reply("Slow child done.", {
          match: matchText("Slow child assignment"),
          label: "child-slow",
          firstByteDelayMs: 400,
        }),
        { label: "parent-wait", match: parentMatch, events: lazyWait(ctx, 15_000) },
        reply("Both children reported.", { match: parentMatch, label: "parent-final" }),
      )
      yield* ctx.user.prompt("Coordinate two children at different speeds.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 5 })
      const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
      if (children.length !== 2) throw new Error(`expected two subagent tasks, saw ${children.length}`)
      const byDescription = (fragment: string) => {
        const task = children.find((candidate) => candidate.description.includes(fragment))
        if (!task) throw new Error(`expected a task described "${fragment}"`)
        return task
      }
      const fast = byDescription("Fast sim child")
      const slow = byDescription("Slow sim child")
      for (const task of [fast, slow])
        if (task.status !== "completed")
          throw new Error(`expected task "${task.description}" to complete, saw "${task.status}"`)
      // Completion order: the fast child settled durably no later than the delayed one.
      const completedAt = (task: SessionTaskV2.Info) => {
        if (task.time.completed === undefined) throw new Error(`task "${task.description}" has no completed time`)
        return DateTime.toEpochMillis(task.time.completed)
      }
      if (completedAt(fast) > completedAt(slow))
        throw new Error("expected the fast child to complete before the slow child")
      // `wait_agents` snapshots keep the requested ID order and carry each child's full result.
      const output = yield* lastWaitOutput(ctx)
      if (output.timed_out) throw new Error("expected the two-child wait to return without a timeout")
      const results = output.tasks.map((task) => task.result)
      if (output.tasks.length !== 2 || !results.includes("Fast child done.") || !results.includes("Slow child done."))
        throw new Error(`expected both child results in the wait output, saw ${JSON.stringify(output.tasks)}`)
      yield* ctx.invariants.settled(fast.childSessionID, { expect: "idle", minRequests: 5 })
      yield* ctx.invariants.settled(slow.childSessionID, { expect: "idle", minRequests: 5 })
    }),
  )

  simulate("a child that parks on a question settles through rejection and reports via wait", (ctx) =>
    Effect.gen(function* () {
      const parentMatch = matchText("Coordinate the asking child")
      const childMatch = matchText("Ask the user child assignment")
      ctx.provider.enqueue(
        replyWithTool(
          "spawn_agent",
          { agent: "explore", description: "Asking sim child", prompt: "Ask the user child assignment." },
          { match: parentMatch, label: "parent-spawn" },
        ),
        replyWithTool("question", questionInput, { match: childMatch, label: "child-question" }),
        { label: "parent-wait", match: parentMatch, events: lazyWait(ctx, 15_000) },
        reply("Handled the child's dismissal.", { match: parentMatch, label: "parent-final" }),
      )
      yield* ctx.user.prompt("Coordinate the asking child.")
      // The parent's wait is parked on the child, and the child is parked on its question. The
      // question belongs to the *child* session, so it is resolved through the shared QuestionV2
      // service rather than ctx.user (which only addresses the parent's questions).
      const task = yield* pollUntil(
        "child-task",
        ctx.services.tasks.list({ parentSessionID: ctx.sessionID }).pipe(Effect.map((tasks) => tasks[0])),
      )
      const request = yield* pollUntil(
        "child-question-pending",
        ctx.services.questions
          .list()
          .pipe(Effect.map((pending) => pending.find((candidate) => candidate.sessionID === task.childSessionID))),
      )
      yield* ctx.services.questions.reject(request.id).pipe(Effect.orDie)
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })
      // Rejection halts the child's turn as user-declined: its session settles idle (Step.Ended
      // lands before the halt), while the drain's interrupt exit settles the task "interrupted" —
      // that pair is today's contract for a dismissed child question.
      yield* ctx.invariants.settled(task.childSessionID, { expect: "idle", minRequests: 3 })
      const settled = yield* onlyChildTask(ctx)
      if (settled.status !== "interrupted")
        throw new Error(`expected the dismissed child's task to settle "interrupted", saw "${settled.status}"`)
      const output = yield* lastWaitOutput(ctx)
      if (output.timed_out) throw new Error("expected the wait to return once the child settled")
      if (output.tasks[0]?.status !== "interrupted")
        throw new Error(`expected wait_agents to report the dismissed child, saw ${JSON.stringify(output.tasks[0])}`)
      const childMessages = yield* ctx.services.store.context(task.childSessionID).pipe(Effect.orDie)
      const errored = childMessages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part) => part.type === "tool" && part.state.status === "error")
      if (errored.length !== 1)
        throw new Error(`expected exactly the child's question call to error, saw ${errored.length}`)
    }),
  )
})
