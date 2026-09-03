import { describe } from "bun:test"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionInputTable, SessionTable } from "@turenlabs/core/session/sql"
import { eq } from "drizzle-orm"
import { Duration, Effect, Fiber } from "effect"
import {
  contextOverflow,
  overloadedThenReply,
  reply,
  replyWithTool,
  requestUserTexts,
  simulate,
  toolCallEvents,
  transportError,
  type RequestRecord,
  type ScenarioContext,
} from "./harness"

const questionInput = {
  questions: [
    {
      question: "Proceed with the staged work?",
      header: "Confirm",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" },
      ],
    },
  ],
}

const checkpointSummary = `## Objective
- Preserve the user's checkpointed work and the follow-up request.
## Important Details
- The overflow recovery must retain durable input.
## Work State
- The original turn is waiting for a recovered provider request.
### Completed
- The earlier context was summarized.
### Active
- The current instruction still needs a response.
### Blocked
- None.
## Next Move
1. Resume the current instruction and then process the queued follow-up.
## Relevant Files
- None.
## Durable Memories
- None.`

const expectRequestCount = (records: ReadonlyArray<RequestRecord>, expected: number, label: string) => {
  if (records.length !== expected)
    throw new Error(`[${label}] expected ${expected} provider requests, saw ${records.length}`)
}

const expectUserTexts = (label: string, record: RequestRecord | undefined, expected: ReadonlyArray<string>) => {
  if (!record) throw new Error(`[${label}] request was never issued`)
  const actual = requestUserTexts(record.request)
  if (actual.length !== expected.length || actual.some((text, index) => text !== expected[index]))
    throw new Error(`[${label}] user texts ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

const expectRequestContains = (label: string, record: RequestRecord | undefined, text: string) => {
  if (!record) throw new Error(`[${label}] request was never issued`)
  if (!requestUserTexts(record.request).some((candidate) => candidate.includes(text)))
    throw new Error(
      `[${label}] expected ${JSON.stringify(text)} in ${JSON.stringify(requestUserTexts(record.request))}`,
    )
}

const expectRequestOmits = (label: string, record: RequestRecord | undefined, text: string) => {
  if (!record) throw new Error(`[${label}] request was never issued`)
  if (requestUserTexts(record.request).some((candidate) => candidate.includes(text)))
    throw new Error(
      `[${label}] did not expect ${JSON.stringify(text)} in ${JSON.stringify(requestUserTexts(record.request))}`,
    )
}

const inputRows = (ctx: ScenarioContext, sessionID = ctx.sessionID) =>
  ctx.services.db
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)

const contextUsers = (messages: ReadonlyArray<SessionMessage.Message>) =>
  messages.filter((message): message is SessionMessage.User => message.type === "user")

const assistantTools = (messages: ReadonlyArray<SessionMessage.Message>) =>
  messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")

const expectPromotedInputs = (rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>, label: string) => {
  if (rows.some((row) => row.promoted_seq === null && row.time_cancelled === null))
    throw new Error(`[${label}] an admitted input was left unpromoted`)
}

const expectNoTasks = (ctx: ScenarioContext, sessionID = ctx.sessionID) =>
  Effect.gen(function* () {
    const tasks = yield* ctx.services.tasks.list({ parentSessionID: sessionID })
    if (tasks.length > 0) throw new Error(`[tasks] expected no child tasks for ${sessionID}, saw ${tasks.length}`)
  })

const waitForRetryStatus = (ctx: ScenarioContext) =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    while (true) {
      const row = yield* ctx.services.db
        .select({ status: SessionTable.status, status_owner: SessionTable.status_owner })
        .from(SessionTable)
        .where(eq(SessionTable.id, ctx.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row?.status === "retry") {
        if (row.status_owner === null) throw new Error("retry status did not retain its process owner")
        return
      }
      if (Date.now() - startedAt > 5_000)
        throw new Error(`session never reached retry status; saw ${row?.status ?? "missing"}`)
      yield* Effect.sleep(Duration.millis(10))
    }
  })

describe("delivery extremes", () => {
  simulate("queue admitted during sim_slow is in the next request after tool settlement", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 70 }, { label: "slow-opening" }),
        reply("The queued work is next.", { label: "queued-continuation" }),
      )
      yield* ctx.user.prompt("Start the slow work.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.user.prompt("Run this immediately after the tool.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "slow queue")
      expectUserTexts("slow opening", records[0], ["Start the slow work."])
      expectUserTexts("slow continuation", records[1], ["Start the slow work.", "Run this immediately after the tool."])
      expectPromotedInputs(yield* inputRows(ctx), "slow queue")
      const users = contextUsers(yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie))
      if (users.length !== 2 || !users.some((message) => message.text === "Run this immediately after the tool."))
        throw new Error(
          `[slow queue] expected two projected user messages, saw ${users.map((message) => message.text)}`,
        )
    }),
  )

  simulate("two queue messages drain one per successive tool boundary", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 25 }, { label: "tool-boundary-0" }),
        replyWithTool("sim_slow", { ms: 25 }, { label: "tool-boundary-1" }),
        replyWithTool("sim_slow", { ms: 25 }, { label: "tool-boundary-2" }),
        reply("Both queued turns are complete.", { label: "tool-boundary-final" }),
      )
      yield* ctx.user.prompt("Open the tool chain.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.user.prompt("Queue boundary one.", { delivery: "queue" })
      yield* ctx.user.prompt("Queue boundary two.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 4, "two queue boundaries")
      expectUserTexts("boundary opening", records[0], ["Open the tool chain."])
      expectUserTexts("boundary one", records[1], ["Open the tool chain.", "Queue boundary one."])
      expectUserTexts("boundary two", records[2], [
        "Open the tool chain.",
        "Queue boundary one.",
        "Queue boundary two.",
      ])
      expectUserTexts("boundary final", records[3], [
        "Open the tool chain.",
        "Queue boundary one.",
        "Queue boundary two.",
      ])
      expectPromotedInputs(yield* inputRows(ctx), "two queue boundaries")
    }),
  )

  simulate("steer and queue racing a tool boundary promote steer first and queue next", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 25 }, { label: "race-opening" }),
        replyWithTool("sim_slow", { ms: 25 }, { label: "race-steer" }),
        reply("The queued race loser is handled.", { label: "race-queue" }),
      )
      yield* ctx.user.prompt("Begin the raced turn.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.user.prompt("Steer at the boundary.", { delivery: "steer" })
      yield* ctx.user.prompt("Queue behind the steer.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 3, "steer queue race")
      expectRequestContains("race steer", records[1], "Steer at the boundary.")
      expectRequestOmits("race steer", records[1], "Queue behind the steer.")
      expectRequestContains("race queue", records[2], "Queue behind the steer.")
      expectPromotedInputs(yield* inputRows(ctx), "steer queue race")
    }),
  )

  simulate("a four-message queue flood drains FIFO across continuing turns", (ctx) =>
    Effect.gen(function* () {
      const queued = ["Flood one.", "Flood two.", "Flood three.", "Flood four."]
      ctx.provider.enqueue(
        ...Array.from({ length: queued.length + 1 }, (_, index) =>
          replyWithTool("sim_slow", { ms: 20 }, { label: `flood-tool-${index}` }),
        ),
        reply("The flood has drained.", { label: "flood-final" }),
      )
      yield* ctx.user.prompt("Open the flood.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* Effect.forEach(queued, (text) => ctx.user.prompt(text, { delivery: "queue" }), { discard: true })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 6 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 6, "queue flood")
      expectUserTexts("flood opening", records[0], ["Open the flood."])
      queued.forEach((text, index) => {
        expectUserTexts(`flood boundary ${index + 1}`, records[index + 1], [
          "Open the flood.",
          ...queued.slice(0, index + 1),
        ])
      })
      expectUserTexts("flood final", records[5], ["Open the flood.", ...queued])
      const rows = yield* inputRows(ctx)
      if (rows.length !== 5) throw new Error(`[queue flood] expected five durable input rows, saw ${rows.length}`)
      expectPromotedInputs(rows, "queue flood")
    }),
  )

  simulate("resume:false queue admitted during a live turn is promoted by that drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 60 }, { label: "deferred-opening" }),
        reply("The deferred queue was promoted.", { label: "deferred-next" }),
      )
      yield* ctx.user.prompt("Start with a deferred follow-up.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.user.prompt("Deferred while the tool runs.", { delivery: "queue", resume: false })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "resume false queue")
      expectRequestContains("resume false queue", records[1], "Deferred while the tool runs.")
      const rows = yield* inputRows(ctx)
      const deferred = rows.find((row) => row.prompt.text === "Deferred while the tool runs.")
      if (!deferred || deferred.promoted_seq === null || deferred.time_cancelled !== null)
        throw new Error("resume:false queue was not promoted by the active drain")
    }),
  )

  simulate("a queue admitted before a later resume-false steer gives steer priority", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("The steer wins the opening boundary.", { label: "priority-steer" }),
        reply("The older queue follows.", { label: "priority-queue" }),
      )
      yield* ctx.user.prompt("Stage the opening work.", { resume: false })
      yield* ctx.user.prompt("Stage the older queue.", { delivery: "queue", resume: false })
      yield* ctx.user.prompt("Stage the later steer.", { delivery: "steer", resume: false })
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "staged priority")
      expectUserTexts("staged steer", records[0], ["Stage the opening work.", "Stage the later steer."])
      expectUserTexts("staged queue", records[1], [
        "Stage the opening work.",
        "Stage the later steer.",
        "Stage the older queue.",
      ])
      const rows = yield* inputRows(ctx)
      if (rows.length !== 3) throw new Error(`[staged priority] expected three rows, saw ${rows.length}`)
      expectPromotedInputs(rows, "staged priority")
    }),
  )
})

describe("lifecycle extremes", () => {
  simulate("many concurrent resumes on a staged mixed inbox create one opening drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Opening mixed inbox.", { label: "mixed-opening" }),
        reply("First mixed queue handled.", { label: "mixed-queue-one" }),
        reply("Second mixed queue handled.", { label: "mixed-queue-two" }),
      )
      yield* ctx.user.prompt("Stage the mixed inbox.", { resume: false })
      yield* ctx.user.prompt("Mixed queue one.", { delivery: "queue", resume: false })
      yield* ctx.user.prompt("Mixed steer one.", { delivery: "steer", resume: false })
      yield* ctx.user.prompt("Mixed queue two.", { delivery: "queue", resume: false })
      yield* ctx.user.prompt("Mixed steer two.", { delivery: "steer", resume: false })

      yield* Effect.all(
        Array.from({ length: 12 }, () => ctx.services.session.resume(ctx.sessionID).pipe(Effect.exit)),
        { concurrency: "unbounded" },
      )
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 3, "mixed resumes")
      expectUserTexts("mixed opening", records[0], ["Stage the mixed inbox.", "Mixed steer one.", "Mixed steer two."])
      expectUserTexts("mixed queue one", records[1], [
        "Stage the mixed inbox.",
        "Mixed steer one.",
        "Mixed steer two.",
        "Mixed queue one.",
      ])
      expectUserTexts("mixed queue two", records[2], [
        "Stage the mixed inbox.",
        "Mixed steer one.",
        "Mixed steer two.",
        "Mixed queue one.",
        "Mixed queue two.",
      ])
      expectPromotedInputs(yield* inputRows(ctx), "mixed resumes")
    }),
  )

  simulate("a typed provider failure with many mid-stream steers has one successor", (ctx) =>
    Effect.gen(function* () {
      const steers = [
        "Steer after typed failure one.",
        "Steer after typed failure two.",
        "Steer after typed failure three.",
        "Steer after typed failure four.",
        "Steer after typed failure five.",
      ]
      ctx.provider.enqueue(
        reply("This stream will fail.", {
          label: "typed-failure",
          chunks: 7,
          interEventDelayMs: 35,
          failAfter: { count: 5, error: transportError("typed mid-stream failure") },
        }),
        reply("All steers were coalesced.", { label: "typed-successor" }),
      )
      yield* ctx.user.prompt("Open the typed failure.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.phase.whenAssistantStreaming()
      yield* Effect.forEach(steers, (text) => ctx.user.prompt(text, { delivery: "steer" }), { discard: true })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "typed failure steers")
      expectUserTexts("typed failure opening", records[0], ["Open the typed failure."])
      expectUserTexts("typed failure successor", records[1], ["Open the typed failure.", ...steers])
      expectPromotedInputs(yield* inputRows(ctx), "typed failure steers")
    }),
  )

  simulate("concurrent exact-ID queue admission produces one row, message, and request", (ctx) =>
    Effect.gen(function* () {
      const messageID = SessionMessage.ID.make("msg_sim_extreme_concurrent_queue")
      const input = {
        id: messageID,
        sessionID: ctx.sessionID,
        prompt: Prompt.make({ text: "Admit this concurrent queue exactly once." }),
        delivery: "queue" as const,
        resume: false,
      }
      ctx.provider.enqueue(reply("The exact queue ran once.", { label: "exact-queue" }))

      const returned = yield* Effect.all(
        Array.from({ length: 10 }, () => ctx.services.session.prompt(input).pipe(Effect.exit)),
        { concurrency: "unbounded" },
      )
      if (returned.some((exit) => exit._tag !== "Success" || exit.value.id !== messageID))
        throw new Error("an exact queue retry did not reconcile successfully")
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const rows = yield* inputRows(ctx)
      if (rows.length !== 1 || rows[0]?.id !== messageID)
        throw new Error(`[exact queue] expected one input row, saw ${rows.length}`)
      const users = contextUsers(yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie))
      if (users.length !== 1 || users[0]?.id !== messageID)
        throw new Error(
          `[exact queue] expected one projected message ${messageID}, saw ${users.map((user) => user.id)}`,
        )
      expectRequestCount(ctx.provider.requests(), 1, "exact queue")
    }),
  )

  simulate("exact-ID queue retry conflicts only on changed delivery or text and leaves the live drain alone", (ctx) =>
    Effect.gen(function* () {
      const messageID = SessionMessage.ID.make("msg_sim_extreme_live_exact_queue")
      const input = {
        id: messageID,
        sessionID: ctx.sessionID,
        prompt: Prompt.make({ text: "Run this exact queue while the tool is live." }),
        delivery: "queue" as const,
        resume: false,
      }
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 90 }, { label: "live-exact-tool" }),
        reply("The live exact queue finished.", { label: "live-exact-final" }),
      )
      yield* ctx.services.session.prompt(input)
      yield* ctx.user.resume()
      yield* ctx.phase.whenToolRunning("sim_slow")

      const exact = yield* ctx.services.session.prompt(input)
      if (exact.id !== messageID) throw new Error("exact retry did not reconcile the promoted queue")
      const textConflict = yield* ctx.services.session
        .prompt({ ...input, prompt: Prompt.make({ text: "Changed text must conflict." }) })
        .pipe(Effect.flip)
      if (textConflict._tag !== "Session.PromptConflictError")
        throw new Error(`unexpected text conflict ${textConflict._tag}`)
      const deliveryConflict = yield* ctx.services.session
        .prompt({ ...input, delivery: "steer" as const })
        .pipe(Effect.flip)
      if (deliveryConflict._tag !== "Session.PromptConflictError")
        throw new Error(`unexpected delivery conflict ${deliveryConflict._tag}`)
      if (ctx.provider.requests().length !== 1) throw new Error("conflicting exact retries changed the live drain")

      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      const rows = yield* inputRows(ctx)
      if (rows.length !== 1 || rows[0]?.id !== messageID)
        throw new Error(`[live exact] expected one durable row, saw ${rows.length}`)
      const users = contextUsers(yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie))
      if (users.length !== 1 || users[0]?.id !== messageID)
        throw new Error(`[live exact] expected one user message, saw ${users.length}`)
      expectRequestCount(ctx.provider.requests(), 2, "live exact")
    }),
  )

  simulate("queue during a pending question does not dismiss it and arrives after the answer", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("question", questionInput, { label: "question-queue-opening" }),
        reply("The answer and queued work are both retained.", { label: "question-queue-follow-up" }),
      )
      yield* ctx.user.prompt("Ask before the queued work.")
      yield* ctx.phase.whenQuestionPending()
      yield* ctx.user.prompt("Run this after the answer.", { delivery: "queue" })
      const pending = yield* ctx.services.questions.list()
      if (!pending.some((request) => request.sessionID === ctx.sessionID))
        throw new Error("queue dismissed the pending question")
      yield* ctx.user.answerQuestion()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "question queue")
      expectRequestContains("question queue follow-up", records[1], "Run this after the answer.")
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const question = assistantTools(messages).find((part) => part.name === "question")
      if (!question || question.state.status !== "completed") throw new Error("answered question was not completed")
      expectPromotedInputs(yield* inputRows(ctx), "question queue")
    }),
  )

  simulate("steer and queue during a pending question dismiss question, then deliver steer and queue", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("question", questionInput, { label: "question-race-opening" }),
        reply("The steer successor is complete.", { label: "question-race-steer" }),
        reply("The queued successor is complete.", { label: "question-race-queue" }),
      )
      yield* ctx.user.prompt("Ask before the racing inputs.")
      yield* ctx.phase.whenQuestionPending()
      yield* ctx.user.prompt("Steer away from the question.", { delivery: "steer" })
      yield* ctx.user.prompt("Queue behind the steer.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 3, "question steer queue")
      expectRequestContains("question steer", records[1], "Steer away from the question.")
      expectRequestOmits("question steer", records[1], "Queue behind the steer.")
      expectRequestContains("question queue", records[2], "Queue behind the steer.")
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const question = assistantTools(messages).find((part) => part.name === "question")
      if (!question || question.state.status !== "error") throw new Error("steer did not dismiss the pending question")
      expectPromotedInputs(yield* inputRows(ctx), "question steer queue")
    }),
  )
})

describe("goals and retry extremes", () => {
  simulate("an active goal with sim_slow promotes queue at the next boundary", (ctx) =>
    Effect.gen(function* () {
      const goal = yield* ctx.services.goals.create({
        sessionID: ctx.sessionID,
        objective: "Finish the slow operation and then process the queued request.",
      })
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 60 }, { label: "goal-slow" }),
        { label: "goal-queue-complete", events: toolCallEvents("update_goal", { status: "complete" }) },
        reply("The active goal is complete.", { label: "goal-final" }),
      )
      yield* ctx.user.prompt("Begin the active goal.")
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.user.prompt("Process this at the next goal boundary.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 3, "goal queue boundary")
      expectRequestContains("goal queue boundary", records[1], "Process this at the next goal boundary.")
      const finalGoal = yield* ctx.services.goals.get(ctx.sessionID)
      if (!finalGoal || finalGoal.id !== goal.id || finalGoal.status !== "complete")
        throw new Error(`goal did not complete after the queued boundary: ${finalGoal?.status ?? "missing"}`)
      expectPromotedInputs(yield* inputRows(ctx), "goal queue boundary")
      yield* expectNoTasks(ctx)
    }),
  )

  simulate("queued input plus update_goal completion leaves no orphan or duplicate goal continuation", (ctx) =>
    Effect.gen(function* () {
      const goal = yield* ctx.services.goals.create({
        sessionID: ctx.sessionID,
        objective: "Complete exactly once while draining the staged queue.",
      })
      ctx.provider.enqueue(
        { label: "goal-stage-complete", events: toolCallEvents("update_goal", { status: "complete" }) },
        reply("The staged queue completed after the goal.", { label: "goal-stage-queue" }),
      )
      yield* ctx.user.prompt("Start the staged goal.", { resume: false })
      yield* ctx.user.prompt("Queue after goal completion.", { delivery: "queue", resume: false })
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "goal completion queue")
      expectRequestContains("goal completion queue", records[1], "Queue after goal completion.")
      if (
        records.some((record) => requestUserTexts(record.request).some((text) => text.includes("goal_loop_reminder")))
      )
        throw new Error("goal completion left an unexpected reminder continuation")
      const finalGoal = yield* ctx.services.goals.get(ctx.sessionID)
      if (!finalGoal || finalGoal.id !== goal.id || finalGoal.status !== "complete")
        throw new Error(`expected completed goal, saw ${finalGoal?.status ?? "missing"}`)
      const rows = yield* inputRows(ctx)
      if (rows.length !== 2) throw new Error(`[goal completion queue] expected two input rows, saw ${rows.length}`)
      expectPromotedInputs(rows, "goal completion queue")
      yield* expectNoTasks(ctx)
    }),
  )

  simulate("active goal interruption preserves queued input and resumes cleanly", (ctx) =>
    Effect.gen(function* () {
      const goal = yield* ctx.services.goals.create({
        sessionID: ctx.sessionID,
        objective: "Resume the interrupted goal with its queued work intact.",
      })
      ctx.provider.enqueue(replyWithTool("sim_hang", {}, { label: "goal-interrupted-hang" }))
      yield* ctx.user.prompt("Start the goal and interrupt its tool.")
      yield* ctx.phase.whenToolRunning("sim_hang")
      yield* ctx.user.prompt("Preserve this goal follow-up.", { delivery: "queue" })
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1, allowPendingInput: true })

      const interruptedRows = yield* inputRows(ctx)
      const pending = interruptedRows.find((row) => row.prompt.text === "Preserve this goal follow-up.")
      if (!pending || pending.promoted_seq !== null || pending.time_cancelled !== null)
        throw new Error("interruption did not preserve the goal's queued input")

      ctx.provider.enqueue(
        { label: "goal-resume-complete", events: toolCallEvents("update_goal", { status: "complete" }) },
        reply("The interrupted goal resumed cleanly.", { label: "goal-resume-final" }),
      )
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const finalGoal = yield* ctx.services.goals.get(ctx.sessionID)
      if (!finalGoal || finalGoal.id !== goal.id || finalGoal.status !== "complete")
        throw new Error(`resumed goal did not complete: ${finalGoal?.status ?? "missing"}`)
      expectRequestContains("goal resume", ctx.provider.requests()[1], "Preserve this goal follow-up.")
      expectPromotedInputs(yield* inputRows(ctx), "goal resume")
      yield* expectNoTasks(ctx)
    }),
  )

  simulate("queued input after typed local sim_fail arrives on the next continuation", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("sim_fail", { message: "local typed failure" }, { label: "local-failure" }),
        reply("The queued input follows the local failure.", { label: "local-failure-queue" }),
      )
      yield* ctx.user.prompt("Run the local failing tool.")
      yield* ctx.phase.whenToolRunning("sim_fail")
      yield* ctx.user.prompt("Continue after the local failure.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "local tool failure")
      expectRequestContains("local tool failure continuation", records[1], "Continue after the local failure.")
      const tools = assistantTools(yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie))
      const failed = tools.filter((part) => part.name === "sim_fail" && part.state.status === "error")
      if (failed.length !== 1) throw new Error(`expected one terminal sim_fail error, saw ${failed.length}`)
      expectPromotedInputs(yield* inputRows(ctx), "local tool failure")
    }),
  )

  simulate("queued inputs after a provider defect arrive on successors without duplication", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("This provider stream defects.", {
          label: "defect-opening",
          chunks: 7,
          interEventDelayMs: 35,
          dieAfter: { count: 5 },
        }),
        reply("The first defect successor completes.", { label: "defect-successor-one" }),
        reply("The second defect successor completes.", { label: "defect-successor-two" }),
      )
      yield* ctx.user.prompt("Open the provider defect.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.phase.whenAssistantStreaming()
      yield* ctx.user.prompt("First queue after defect.", { delivery: "queue" })
      yield* ctx.user.prompt("Second queue after defect.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 3, "provider defect queue")
      expectRequestContains("defect successor one", records[1], "First queue after defect.")
      expectRequestOmits("defect successor one", records[1], "Second queue after defect.")
      expectRequestContains("defect successor two", records[2], "Second queue after defect.")
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      if (!messages.some((message) => message.type === "assistant" && message.error !== undefined))
        throw new Error("provider defect did not leave a durable failed assistant")
      expectPromotedInputs(yield* inputRows(ctx), "provider defect queue")
    }),
  )

  simulate("queue admitted during retry is handled after recovery without a duplicate retry", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        ...overloadedThenReply("Recovered from the retry window."),
        reply("The queue waited for recovery.", { label: "after-retry-queue" }),
      )
      yield* ctx.user.prompt("Start the retry window.")
      yield* waitForRetryStatus(ctx)
      if (ctx.provider.requests().length !== 1) throw new Error("retry window issued more than its first attempt")
      yield* ctx.user.prompt("Queue while the provider is retrying.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 3, "retry queue")
      if (records.filter((record) => record.label === "overloaded").length !== 1)
        throw new Error("retry window consumed more than one overloaded attempt")
      if (records.filter((record) => record.label === "reply-after-overload").length !== 1)
        throw new Error("retry recovery reply was duplicated")
      expectRequestContains("retry queue successor", records[2], "Queue while the provider is retrying.")
      expectPromotedInputs(yield* inputRows(ctx), "retry queue")
    }),
  )
})

describe("tools and compaction extremes", () => {
  simulate("queue admitted during overflow compaction stays durable through checkpoint recovery", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Create durable history before overflow.", { label: "checkpoint-history" }))
      yield* ctx.user.prompt("Create durable history before overflow.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      ctx.provider.enqueue(
        contextOverflow(),
        reply(checkpointSummary, {
          label: "overflow-summary",
          chunks: 4,
          interEventDelayMs: 25,
          match: (request) =>
            requestUserTexts(request).some((text) => text.includes("Output exactly the Markdown structure")),
        }),
        reply("Recovered the original overflow turn.", {
          label: "overflow-recovery",
          match: (request) => requestUserTexts(request).some((text) => text.includes("Force checkpoint recovery.")),
        }),
        reply("Processed the queued checkpoint follow-up.", {
          label: "checkpoint-queue",
          match: (request) =>
            requestUserTexts(request).some((text) => text.includes("Queue during checkpoint recovery.")),
        }),
      )
      yield* ctx.user.prompt("Force checkpoint recovery.")
      yield* ctx.phase.afterFirstByte(2)
      yield* ctx.user.prompt("Queue during checkpoint recovery.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 5 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 5, "overflow queue")
      expectRequestOmits("overflow recovery", records[3], "Queue during checkpoint recovery.")
      expectRequestContains("checkpoint queue", records[4], "Queue during checkpoint recovery.")
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      if (messages.filter((message) => message.type === "compaction").length !== 1)
        throw new Error("overflow recovery did not project one checkpoint")
      if (!contextUsers(messages).some((message) => message.text === "Queue during checkpoint recovery."))
        throw new Error("queued checkpoint input was not projected into SessionMessage context")
      const rows = yield* inputRows(ctx)
      if (rows.length !== 3) throw new Error(`[overflow queue] expected three durable inputs, saw ${rows.length}`)
      expectPromotedInputs(rows, "overflow queue")
    }),
  )
})

describe("isolation extremes", () => {
  simulate("independent roots each queue and complete while interrupting only one", (ctx) =>
    Effect.gen(function* () {
      const secondID = SessionV2.ID.make("ses_sim_extreme_second_root")
      const firstText = "First root stalls independently."
      const firstQueue = "First root queued recovery."
      const secondText = "Second root keeps working independently."
      const secondQueue = "Second root queued completion."
      const location = (yield* ctx.services.session.get(ctx.sessionID)).location
      yield* ctx.services.session.create({ id: secondID, title: "simulator: second extreme root", location })

      ctx.provider.enqueue(
        reply("First root is stalled.", {
          label: "first-root-stalled",
          chunks: 3,
          interEventDelayMs: 20,
          stallAfter: { count: 3 },
          match: (request) => requestUserTexts(request).includes(firstText),
        }),
        replyWithTool(
          "sim_slow",
          { ms: 250 },
          {
            label: "second-root-tool",
            match: (request) => requestUserTexts(request).includes(secondText),
          },
        ),
        reply("Second root completed its queue.", {
          label: "second-root-queue",
          match: (request) => requestUserTexts(request).includes(secondQueue),
        }),
      )
      yield* ctx.user.prompt(firstText)
      yield* ctx.phase.whileStalled(0)
      yield* ctx.services.session
        .prompt({ sessionID: ctx.sessionID, prompt: Prompt.make({ text: firstQueue }), delivery: "queue" })
        .pipe(Effect.orDie)
      yield* ctx.services.session
        .prompt({ sessionID: secondID, prompt: Prompt.make({ text: secondText }) })
        .pipe(Effect.orDie)
      yield* ctx.phase.whenToolRunning("sim_slow")
      yield* ctx.services.session
        .prompt({ sessionID: secondID, prompt: Prompt.make({ text: secondQueue }), delivery: "queue" })
        .pipe(Effect.orDie)

      yield* ctx.services.session.interrupt(ctx.sessionID).pipe(Effect.orDie)
      const active = yield* ctx.services.session.active
      if (active.has(ctx.sessionID) || !active.has(secondID))
        throw new Error("interrupting one root affected the other root")
      yield* ctx.invariants.settled(secondID, { expect: "idle", minRequests: 3 })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 3, allowPendingInput: true })

      const firstRows = yield* inputRows(ctx)
      const firstPending = firstRows.find((row) => row.prompt.text === firstQueue)
      if (!firstPending || firstPending.promoted_seq !== null || firstPending.time_cancelled !== null)
        throw new Error("the interrupted root did not preserve its queued input")
      const secondRows = yield* inputRows(ctx, secondID)
      expectPromotedInputs(secondRows, "independent second root")
      const secondUsers = contextUsers(yield* ctx.services.store.context(secondID).pipe(Effect.orDie))
      if (!secondUsers.some((message) => message.text === secondQueue))
        throw new Error("the second root lost its queue")

      ctx.provider.enqueue(
        reply("First root completed after resume.", {
          label: "first-root-queue",
          match: (request) => requestUserTexts(request).includes(firstQueue),
        }),
      )
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })
      yield* ctx.invariants.settled(secondID, { expect: "idle", minRequests: 4 })
      expectPromotedInputs(yield* inputRows(ctx), "independent first root")
      yield* expectNoTasks(ctx)
    }),
  )
})
