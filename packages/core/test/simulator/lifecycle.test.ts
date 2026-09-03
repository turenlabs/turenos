/**
 * Simulator coverage for API-call lifetime and durable retry identity.
 *
 * A Session drain is process-owned after admission. Cancelling a caller that is only joining the
 * drain must not cancel provider work, while retrying an admission after losing its response must
 * reconcile by stable message ID instead of duplicating the user message or provider turn.
 */
import { describe } from "bun:test"
import { LLMError, RateLimitReason } from "@turenlabs/llm"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionInputTable } from "@turenlabs/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Fiber } from "effect"
import { reply, requestUserTexts, simulate, type ScenarioBehavior } from "./harness"

const rateLimited = (attempt: number): ScenarioBehavior => ({
  label: `rate-limit-${attempt}`,
  events: [],
  failAfter: {
    count: 0,
    error: new LLMError({
      module: "simulator",
      method: "stream",
      reason: new RateLimitReason({ message: `Rate limited attempt ${attempt}`, retryAfterMs: 0 }),
    }),
  },
})

describe("caller lifetime", () => {
  simulate("cancelling a resume caller does not cancel the process-owned drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("The drain survived its caller.", { chunks: 5, interEventDelayMs: 40 }))
      yield* ctx.user.prompt("Keep running after my request disconnects.", { resume: false })

      const caller = yield* ctx.services.session.resume(ctx.sessionID).pipe(Effect.forkChild)
      yield* ctx.phase.afterFirstByte()
      yield* Fiber.interrupt(caller)
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected one process-owned provider request, saw ${ctx.provider.requests().length}`)
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const output = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
      if (output !== "The drain survived its caller.")
        throw new Error(`expected the detached drain to finish, saw ${JSON.stringify(output)}`)
    }),
  )

  simulate("concurrent resumes join one provider drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Joined once.", { firstByteDelayMs: 100 }))
      yield* ctx.user.prompt("Run exactly once.", { resume: false })

      const first = yield* ctx.services.session.resume(ctx.sessionID).pipe(Effect.forkChild)
      const second = yield* ctx.services.session.resume(ctx.sessionID).pipe(Effect.forkChild)
      const third = yield* ctx.services.session.resume(ctx.sessionID).pipe(Effect.forkChild)
      yield* ctx.phase.afterFirstByte()
      yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(third)], { concurrency: "unbounded" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected concurrent resumes to share one request, saw ${ctx.provider.requests().length}`)
    }),
  )

  simulate("independent root sessions stream concurrently and interrupt independently", (ctx) =>
    Effect.gen(function* () {
      const secondID = SessionV2.ID.make("ses_sim_independent_root")
      const firstText = "Stall the first independent root."
      const secondText = "Stall the second independent root."
      const location = (yield* ctx.services.session.get(ctx.sessionID)).location
      yield* ctx.services.session.create({ id: secondID, title: "simulator: independent root", location })
      ctx.provider.enqueue(
        reply("First remains active.", {
          label: "first-root",
          stallAfter: { count: 3 },
          match: (request) => requestUserTexts(request).includes(firstText),
        }),
        reply("Second remains active.", {
          label: "second-root",
          stallAfter: { count: 3 },
          match: (request) => requestUserTexts(request).includes(secondText),
        }),
      )

      yield* ctx.user.prompt(firstText)
      yield* ctx.services.session
        .prompt({ sessionID: secondID, prompt: Prompt.make({ text: secondText }) })
        .pipe(Effect.orDie)
      yield* Effect.all([ctx.phase.whileStalled(0), ctx.phase.whileStalled(1)], { concurrency: "unbounded" })
      const active = yield* ctx.services.session.active
      if (!active.has(ctx.sessionID) || !active.has(secondID))
        throw new Error(`expected both roots active, saw ${JSON.stringify([...active])}`)

      yield* ctx.services.session.interrupt(ctx.sessionID).pipe(Effect.orDie)
      const afterFirst = yield* ctx.services.session.active
      if (!afterFirst.has(secondID)) throw new Error("interrupting the first root stopped the second root")
      yield* ctx.services.session.interrupt(secondID).pipe(Effect.orDie)
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 2 })
      yield* ctx.invariants.settled(secondID, { expect: "interrupted", minRequests: 2 })
    }),
  )
})

describe("durable prompt identity", () => {
  simulate("an exact retry after a lost admission response promotes one user message", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_sim_exact_retry")
      const input = {
        id,
        sessionID: ctx.sessionID,
        prompt: Prompt.make({ text: "Admit this exactly once." }),
        resume: false,
      } as const

      const first = yield* ctx.services.session.prompt(input)
      const retried = yield* ctx.services.session.prompt(input)
      if (first.id !== id || retried.id !== id)
        throw new Error("exact retry did not return the stable message identity")

      const conflict = yield* ctx.services.session
        .prompt({ ...input, prompt: Prompt.make({ text: "Conflicting retry." }) })
        .pipe(Effect.flip)
      if (conflict._tag !== "Session.PromptConflictError")
        throw new Error(`expected a prompt identity conflict, saw ${conflict._tag}`)

      const rows = yield* ctx.services.db
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, id))
        .all()
        .pipe(Effect.orDie)
      if (rows.length !== 1) throw new Error(`expected one durable input row, saw ${rows.length}`)

      ctx.provider.enqueue(reply("Handled once."))
      yield* ctx.services.session.resume(ctx.sessionID)
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const users = messages.filter((message) => message.type === "user")
      if (users.length !== 1 || users[0]?.id !== id)
        throw new Error(
          `expected one projected user message ${id}, saw ${users.map((message) => message.id).join(", ")}`,
        )
      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected one provider request after exact retry, saw ${ctx.provider.requests().length}`)
    }),
  )
})

describe("retry exhaustion", () => {
  simulate("nine immediate rate limits exhaust eight retries and settle failed", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(...Array.from({ length: 9 }, (_, index) => rateLimited(index + 1)))
      yield* ctx.user.prompt("Exhaust the provider retry budget.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 9 })

      if (ctx.provider.requests().length !== 9)
        throw new Error(`expected nine provider attempts, saw ${ctx.provider.requests().length}`)
      if (ctx.provider.queued() !== 0)
        throw new Error(`expected every rate-limit behavior to be consumed, saw ${ctx.provider.queued()} queued`)
    }),
  )
})
