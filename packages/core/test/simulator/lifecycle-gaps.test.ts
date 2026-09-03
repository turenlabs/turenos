/**
 * Simulator suite: lifecycle coverage gaps identified in the audit.
 *
 * These scenarios exercise the highest-risk boundaries missed by the existing
 * matrix: prompt idempotency (exact ID retries), retry exhaustion, and
 * session isolation under concurrent callers.
 */

import { describe } from "bun:test"
import { Effect, Duration } from "effect"
import { LLMError, ProviderInternalReason } from "@turenlabs/llm"
import { SessionMessage } from "@turenlabs/core/session/message"
import { eq } from "drizzle-orm"
import { SessionInputTable } from "@turenlabs/core/session/sql"
import {
  simulate,
  requestUserTexts,
  reply,
  overloadedThenReply,
  type RequestRecord,
  type ScenarioBehavior,
} from "./harness"

/**
 * An Anthropic-style 529 overload, as a typed stream failure that fails before any event.
 *
 * `retryAfterMs: 0` is the determinism device the sibling `retry-exhaustion.test.ts` documents:
 * `SessionRunnerRetry.delayFor` honours a provider deadline verbatim, so a whole nine-attempt
 * ladder completes in milliseconds instead of the 2s/4s/8s/16s/30s... header-less schedule, which
 * would need two minutes of live clock and could never run inside a scenario. The retry *decision*
 * is unchanged: `ProviderInternal` is session-retryable with the full `MAX_ATTEMPTS` budget.
 */
const overloaded = (attempt: number): ScenarioBehavior => ({
  label: `overloaded-${attempt}`,
  events: [],
  failAfter: {
    count: 0,
    error: new LLMError({
      module: "simulator",
      method: "stream",
      reason: new ProviderInternalReason({
        message: `Overloaded on attempt ${attempt}`,
        status: 529,
        retryAfterMs: 0,
      }),
    }),
  },
})

const expectRequestCount = (records: ReadonlyArray<RequestRecord>, expected: number) => {
  if (records.length !== expected)
    throw new Error(`[lifecycle-gaps] expected ${expected} provider request(s), saw ${records.length}`)
}

const expectUserTexts = (record: RequestRecord | undefined, expected: ReadonlyArray<string>) => {
  if (!record) throw new Error(`[lifecycle-gaps] request was never issued`)
  const actual = requestUserTexts(record.request)
  if (actual.length !== expected.length || actual.some((text, index) => text !== expected[index]))
    throw new Error(`[lifecycle-gaps] user texts ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

const expectLastRequestContains = (ctx: any, text: string) => {
  const records = ctx.provider.requests()
  const last = records.at(-1)
  if (!last) throw new Error(`[lifecycle-gaps] no requests made`)
  const userTexts = requestUserTexts(last.request)
  if (!userTexts.some((t) => t === text))
    throw new Error(`[lifecycle-gaps] last request does not contain "${text}": ${JSON.stringify(userTexts)}`)
}

describe("idempotency: exact message ID retries", () => {
  simulate("same message ID and identical payload admitted before promotion can be retried", (ctx) =>
    Effect.gen(function* () {
      const firstMessageID = SessionMessage.ID.make("msg_idem_exact_before")
      ctx.provider.enqueue(reply("First attempt completed."))
      yield* ctx.user.prompt("Do this task.", { id: firstMessageID })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Exact retry before promotion: should return the existing row and complete
      // without making a second provider request.
      ctx.provider.enqueue(reply("Never served (exact retry)"))
      yield* ctx.user.prompt("Do this task.", { id: firstMessageID })
      yield* ctx.invariants.settled(ctx.sessionID, {
        expect: "idle",
        minRequests: 1, // still 1, no second request made
      })

      const records = ctx.provider.requests()
      expectRequestCount(records, 1)
      expectUserTexts(records[0]!, ["Do this task."])
    }),
  )

  simulate("same message ID with different delivery mode is rejected as conflicting identity", (ctx) =>
    Effect.gen(function* () {
      const conflictMessageID = SessionMessage.ID.make("msg_idem_conflict")
      ctx.provider.enqueue(reply("Initial prompt."))
      yield* ctx.user.prompt("Original text.", { id: conflictMessageID, delivery: "steer" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Retry with same ID but different delivery: conflict — the second attempt fails
      const secondAttempt = ctx.user
        .prompt("Original text.", { id: conflictMessageID, delivery: "queue" })
        .pipe(Effect.exit)
      const result = yield* secondAttempt
      if (result._tag === "Success")
        throw new Error("expected conflicting reuse to be rejected, but second prompt succeeded")
    }),
  )

  simulate("concurrent identical prompt admissions using the same ID deduplicate safely", (ctx) =>
    Effect.gen(function* () {
      const concurrentMessageID = SessionMessage.ID.make("msg_idem_concurrent")
      ctx.provider.enqueue(reply("Concurrent admission settled."))

      // Fire two identical prompts concurrently: both should be admitted and deduplicated
      // to a single durable input. The turn should complete after a single provider request.
      yield* Effect.all(
        [
          ctx.user.prompt("Identical concurrent text.", { id: concurrentMessageID }),
          ctx.user.prompt("Identical concurrent text.", { id: concurrentMessageID }),
        ],
        { concurrency: "unbounded" },
      )
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 1)
    }),
  )
})

describe("retry exhaustion", () => {
  simulate("multiple retries succeed after transient overload", (ctx) =>
    Effect.gen(function* () {
      // `overloadedThenReply(text)` is *two* behaviors — the overload frame and the reply that
      // serves the retry — so passing text here would have ended the ladder on the first retry.
      // Two bare overload frames, then the success the third attempt draws.
      ctx.provider.enqueue(
        overloadedThenReply(undefined),
        overloadedThenReply(undefined),
        reply("Finally succeeded after multiple retries."),
      )
      yield* ctx.user.prompt("Request that will be retried multiple times.")
      // An in-band overload frame carries no provider deadline, so the ladder falls back to
      // `INITIAL_DELAY_MS * BACKOFF_FACTOR^(attempt-1)`: 2s then 4s, each jittered up to x1.25,
      // i.e. up to 7.5s of mandatory live-clock waiting before the third attempt is even made.
      // 12s covers that with headroom and still trips the 20s hang guard if the ladder wedges.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3, deadlineMs: 12_000 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 3) // 2 retries + 1 final success
      expectUserTexts(records[2]!, ["Request that will be retried multiple times."])
    }),
  )

  simulate("retryable failure after exhausting the attempt limit settles as failed", (ctx) =>
    Effect.gen(function* () {
      // `MAX_ATTEMPTS = 8` is a bound on *retries*, checked as `attempt >= maxAttempts` before
      // scheduling the next one, so the budget buys nine attempts: the original plus eight retries.
      // A tenth behavior is deliberately withheld — a tenth request would die on the empty queue
      // instead of passing quietly.
      const behaviors = Array.from({ length: 9 }, (_, attempt): ScenarioBehavior => overloaded(attempt + 1))
      ctx.provider.enqueue(...behaviors)
      yield* ctx.user.prompt("Will exhaust the retry budget.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 9 })
      expectRequestCount(ctx.provider.requests(), 9)
      if (ctx.provider.queued() !== 0)
        throw new Error(`expected every overload to be consumed, saw ${ctx.provider.queued()} queued`)
    }),
  )

  simulate("interrupt during retry backoff is handled correctly", (ctx) =>
    Effect.gen(function* () {
      // The turn-matrix already covers this, but repeat it here to verify it's in
      // the exhaustion suite. Overload, start retry backoff, interrupt, settle interrupted.
      ctx.provider.enqueue(overloadedThenReply("Recovered."))
      yield* ctx.user.prompt("Will be interrupted during retry wait.")
      yield* ctx.phase.afterFirstByte()
      // Schedule interrupt during the ~2s backoff
      yield* Effect.delay(Duration.millis(500))(Effect.void).pipe(Effect.forkChild)
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })
    }),
  )
})

describe("coordinator concurrency", () => {
  simulate("multiple concurrent resume() calls on the same session produce one provider turn", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("One turn only."))
      // The session needs work to resume *into*: `resume` claims a drain, and a drain with an
      // empty inbox is correctly a no-op (runner/llm.ts, the `!input.force && ...` guard). Dock
      // the input without waking so the three resumes below are the only thing that can start it.
      yield* ctx.user.prompt("Work for exactly one turn.", { resume: false })
      // Fire three concurrent resume calls: all should join the same provider turn
      yield* Effect.all([ctx.user.resume(), ctx.user.resume(), ctx.user.resume()], { concurrency: "unbounded" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 1) // One turn, three joiners
      expectUserTexts(records[0]!, ["Work for exactly one turn."])
    }),
  )

  simulate("rapid wake storms coalesce into a single promoted input", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Coalesced wake."))
      // One docked input, then a storm of bare wakes. `pendingWake` is a boolean, so the storm
      // coalesces into at most one successor drain, and that successor (force = false) finds the
      // inbox already empty and issues no request at all. One promoted input, one provider turn.
      yield* ctx.user.prompt("Do this once.", { resume: false })
      yield* Effect.all(
        Array.from({ length: 3 }, () => ctx.user.wakeNoResume()),
        { concurrency: "unbounded" },
      )
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 1)
      expectUserTexts(records[0]!, ["Do this once."])
      const promoted = yield* ctx.services.db
        .select({ id: SessionInputTable.id, promoted: SessionInputTable.promoted_seq })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, ctx.sessionID))
        .all()
        .pipe(Effect.orDie)
      if (promoted.length !== 1 || promoted[0]!.promoted === null)
        throw new Error(`expected exactly one promoted input row, saw ${JSON.stringify(promoted)}`)
    }),
  )
})

describe("prompt admission deferral and resumption", () => {
  simulate("deferred prompt (resume:false) stays admitted until explicit resume", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Deferred prompt settled."))
      // Admit with resume:false: the input sits in "admitted but not promoted" state
      yield* ctx.user.prompt("Deferred after caller cancellation.", { resume: false })
      // Session should stay idle until explicit resume
      yield* Effect.sleep(Duration.millis(100))
      const records = ctx.provider.requests()
      expectRequestCount(records, 0) // No provider call yet
      // Now resume: the deferred input promotes and completes the turn
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const docked = yield* ctx.services.db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, ctx.sessionID))
        .all()
        .pipe(Effect.orDie)
      if (docked.length !== 1) throw new Error(`expected exactly one input row, saw ${docked.length}`)
    }),
  )

  simulate("concurrent prompt and deferred resume ordering", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Concurrent ordering settled."))
      // Prompt1 with resume:false (deferred), then prompt2 with resume:true (immediate),
      // then explicit resume: the ordering should be preserved in the transcript.
      yield* ctx.user.prompt("First (deferred).", { resume: false })
      yield* ctx.user.prompt("Second (immediate).")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 1)
      const userTexts = requestUserTexts(records[0]!.request)
      if (!userTexts.includes("First (deferred).")) throw new Error("First deferred prompt not in request")
      if (!userTexts.includes("Second (immediate).")) throw new Error("Second prompt not in request")
    }),
  )
})
