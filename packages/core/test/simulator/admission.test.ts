/**
 * Fourth simulator suite: admission boundaries and retry exhaustion.
 *
 * Where turn-matrix covers provider failures and retry-backoff timing under normal
 * admission flow, and interrupt suite covers interruption phases, this suite focuses
 * on the durable admission layer itself:
 *
 *   - exact-ID retry: same message ID sent twice (idempotency under concurrent callers)
 *   - conflicting retry: same ID, different prompt payload (caller replay conflict detection)
 *   - retry exhaustion: 8 provider attempts hit the bound, turn fails terminally (no 9th retry)
 *   - caller disconnect: interrupt from caller side (session drain survives caller abort)
 *
 * These are admission-layer defects: the turn may fail silently, durably lock, or
 * incorrectly accept a replay that contradicts the first admission. The simulator models
 * caller-side cancellation as a user interrupt; real disconnects would require network
 * simulation (future work, see next-move in the summary).
 */
import { describe } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AuthenticationReason, LLMError, ProviderInternalReason } from "@turenlabs/llm"
import { SessionMessage } from "@turenlabs/core/session/message"
import { reply, simulate, type ScenarioBehavior } from "./harness"
import { SessionInputTable, SessionTable } from "@turenlabs/core/session/sql"

describe("admission: exact-ID retry", () => {
  simulate("same message ID sent twice completes the turn once and returns the same admitted", (ctx) =>
    Effect.gen(function* () {
      const id1 = SessionMessage.ID.make("msg_test_idempotent_001")
      const id2 = SessionMessage.ID.make("msg_test_idempotent_001")
      ctx.provider.enqueue(reply("First prompt completes."))
      yield* ctx.user.prompt("Idempotent turn.", { id: id1 })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Second call with the same ID should return immediately without re-executing.
      // Only one provider request should exist (the first one).
      yield* ctx.user.prompt("Idempotent turn.", { id: id2 })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const userMessages = messages.filter((m) => m.type === "user")
      if (userMessages.length !== 1)
        throw new Error(
          `expected exactly one user message (no duplicate), saw ${userMessages.length}; ` +
            `full transcript: ${messages.map((m) => `${m.type}[${m.id}]`).join(" ")}`,
        )
    }),
  )

  simulate("same message ID with identical payload in a race returns the same admitted", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_test_concurrent_001")
      ctx.provider.enqueue(reply("Concurrent prompt accepted."))
      const p1 = ctx.user.prompt("Concurrent turn.", { id })
      const p2 = ctx.user.prompt("Concurrent turn.", { id })
      yield* Effect.all([p1, p2], { concurrency: 2 })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const records = ctx.provider.requests()
      if (records.length !== 1) throw new Error(`expected exactly one provider request, saw ${records.length}`)
    }),
  )
})

describe("admission: conflicting retry", () => {
  simulate("same message ID with different prompt text returns a PromptConflictError", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_test_conflict_001")
      ctx.provider.enqueue(reply("First prompt accepted."))
      yield* ctx.user.prompt("First prompt text.", { id })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Second call with same ID but different text should fail.
      // (In the harness, session.prompt error is surfaced; actual client would see
      // PromptConflictError. Scenario uses Effect.orDie so the error becomes a test failure.)
      const error = yield* ctx.user.prompt("Different prompt text.", { id }).pipe(Effect.exit)
      if (error._tag !== "Failure")
        throw new Error(`expected PromptConflictError, but second prompt succeeded unexpectedly`)
    }),
  )

  simulate("same message ID with conflicting delivery type returns a PromptConflictError", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_test_delivery_conflict_001")
      ctx.provider.enqueue(reply("First prompt accepted."))
      yield* ctx.user.prompt("Same text.", { id, delivery: "steer" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const error = yield* ctx.user.prompt("Same text.", { id, delivery: "queue" }).pipe(Effect.exit)
      if (error._tag !== "Failure")
        throw new Error(`expected PromptConflictError, but conflicting delivery was accepted`)
    }),
  )
})

/**
 * An Anthropic-style 529 overload as a typed stream failure that fails before any event.
 *
 * `retryAfterMs: 0` is the determinism device `retry-exhaustion.test.ts` documents:
 * `SessionRunnerRetry.delayFor` honours a provider deadline verbatim, so the whole ladder runs in
 * milliseconds. Without one, an overload falls back to `2s, 4s, 8s, 16s, 30s, 30s, ...` on the live
 * clock — over two minutes to exhaust the budget, which no scenario can host. The retry *decision*
 * is identical either way: `ProviderInternal` is session-retryable with the full `MAX_ATTEMPTS`.
 */
const overloaded = (attempt: number): ScenarioBehavior => ({
  label: `529-${attempt}`,
  events: [],
  failAfter: {
    count: 0,
    error: new LLMError({
      module: "simulator",
      method: "stream",
      reason: new ProviderInternalReason({ message: `Overloaded on attempt ${attempt}`, status: 529, retryAfterMs: 0 }),
    }),
  },
})

describe("admission: retry exhaustion", () => {
  // `MAX_ATTEMPTS = 8` bounds *retries*, and `decide` checks `attempt >= maxAttempts` before
  // scheduling the next one, so the budget buys nine attempts in total: the original plus eight
  // retries. The tenth is the one that never runs — the sentinel proves it, because a tenth
  // request would have consumed it instead of leaving it queued.
  simulate("nine attempts exhaust the eight-retry bound; the tenth request never runs", (ctx) =>
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= 9; attempt++) ctx.provider.enqueue(overloaded(attempt))
      // Also enqueue a sentinel that should never be touched.
      ctx.provider.enqueue(reply("This should never run."))

      yield* ctx.user.prompt("Exhaust retries.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 9 })

      const records = ctx.provider.requests()
      if (records.length !== 9) throw new Error(`expected exactly 9 attempts, saw ${records.length}`)

      // Verify the sentinel was never consumed.
      if (ctx.provider.queued() !== 1)
        throw new Error(
          `expected the sentinel reply to remain queued after exhaustion, ` +
            `but ${ctx.provider.queued()} behavior(s) queued`,
        )

      const row = yield* ctx.services.db
        .select({ status: SessionTable.status, status_message: SessionTable.status_message })
        .from(SessionTable)
        .where(eq(SessionTable.id, ctx.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row?.status_message?.includes("Overloaded") && !row?.status_message?.includes("retry"))
        throw new Error(`expected failure message to cite overload/retry, saw: ${row?.status_message}`)
      // The turn ends on the failure the budget refused to retry, not on an earlier one.
      if (!row?.status_message?.includes("attempt 9"))
        throw new Error(`expected the ninth failure to be terminal, saw: ${row?.status_message}`)
    }),
  )

  // A non-retryable failure terminates a retry ladder immediately, even when an earlier provider
  // failure had retry budget remaining.
  simulate("a non-retryable failure terminates an active retry ladder", (ctx) =>
    Effect.gen(function* () {
      const authenticationFailure = (message: string): ScenarioBehavior => ({
        label: `authentication:${message}`,
        events: [],
        failAfter: {
          count: 0,
          error: new LLMError({
            module: "simulator",
            method: "stream",
            reason: new AuthenticationReason({ message, kind: "invalid" }),
          }),
        },
      })
      ctx.provider.enqueue(overloaded(1))
      ctx.provider.enqueue(overloaded(2))
      ctx.provider.enqueue(authenticationFailure("Credentials rejected"))
      // Budget the overload ladder would still have had. None of it may be spent: a request that
      // reaches these proves the transport failure was wrongly replayed.
      for (let attempt = 4; attempt <= 9; attempt++) ctx.provider.enqueue(overloaded(attempt))

      yield* ctx.user.prompt("Mixed transport and rate-limit failures.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 3 })

      if (ctx.provider.requests().length !== 3)
        throw new Error(
          `expected 3 attempts (two retried overloads, then terminal authentication), saw ${ctx.provider.requests().length}`,
        )
      if (ctx.provider.queued() !== 6)
        throw new Error(
          `the authentication failure was replayed into the overload budget, ${ctx.provider.queued()} left`,
        )

      const row = yield* ctx.services.db
        .select({ status: SessionTable.status, status_message: SessionTable.status_message })
        .from(SessionTable)
        .where(eq(SessionTable.id, ctx.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row?.status_message?.includes("Credentials rejected"))
        throw new Error(`expected the authentication failure to be the turn's last word, saw: ${row?.status_message}`)
    }),
  )
})

describe("admission: caller disconnect", () => {
  simulate("user interrupt during the initial prompt settles the turn", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Slow response.", { stallAfter: { count: 1 } }))
      yield* ctx.user.prompt("Prompt with cancellation.")
      // Request #0 — the prompt's own turn — is the one that stalls. Waiting on #1 waits on a
      // request this scenario never makes, which is a hang, not an interrupt test.
      yield* ctx.phase.whileStalled(0)
      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })

      const row = yield* ctx.services.db
        .select({ status: SessionTable.status })
        .from(SessionTable)
        .where(eq(SessionTable.id, ctx.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row?.status !== "failed")
        throw new Error(`expected session to settle with status failed/interrupted, ` + `saw status=${row?.status}`)
    }),
  )

  simulate("queued input survives a caller interrupt and runs after drain resumes", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("First turn."), reply("Second turn after queue."))
      yield* ctx.user.prompt("First prompt.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Queue a second prompt without waking, so it is genuinely sitting admitted-but-not-promoted
      // when the interrupt lands (with a wake, the interrupt would race a drain that may already
      // have promoted it, and the scenario would assert nothing about the queue).
      const queuedID = SessionMessage.ID.make("msg_queued_survives_interrupt")
      yield* ctx.user.prompt("Queued prompt.", { id: queuedID, delivery: "queue", resume: false })

      // Interrupt while the input is docked. An interrupt stops execution; it must not cancel or
      // consume durable input a caller has already been told was accepted.
      yield* ctx.user.interrupt()

      const docked = yield* ctx.services.db
        .select({ promoted: SessionInputTable.promoted_seq, cancelled: SessionInputTable.time_cancelled })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, queuedID))
        .get()
        .pipe(Effect.orDie)
      if (!docked) throw new Error("the interrupt deleted the queued input row")
      if (docked.cancelled !== null) throw new Error("the interrupt cancelled input the caller had been promised")
      if (docked.promoted !== null) throw new Error("the queued input promoted without a resume")

      // The queue should survive the interrupt and be drainable via resume().
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const userMessages = messages.filter((m) => m.type === "user")
      if (userMessages.length !== 2)
        throw new Error(
          `expected 2 user messages (initial + queued), saw ${userMessages.length}; ` +
            `messages: ${userMessages.map((m) => m.id).join(", ")}`,
        )
    }),
  )
})

describe("admission: input row lifecycle", () => {
  simulate("promoted input row has populated promoted_seq", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Turn completed."))
      yield* ctx.user.prompt("Single turn.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const rows = yield* ctx.services.db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, ctx.sessionID))
        .all()
        .pipe(Effect.orDie)
      if (rows.length !== 1) throw new Error(`expected exactly 1 input row, saw ${rows.length}`)
      if (rows[0]!.promoted_seq === null) throw new Error(`expected promoted_seq to be set, but it's null`)
    }),
  )

  simulate("cancelled input row has populated time_cancelled", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("First turn."))
      yield* ctx.user.prompt("First.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const inputID = SessionMessage.ID.make("msg_to_cancel_001")
      yield* ctx.user.prompt("To be cancelled.", { id: inputID, delivery: "queue", resume: false })

      // The input is admitted but not promoted (resume:false). Cancel it.
      yield* ctx.services.session.cancelPendingInput({ sessionID: ctx.sessionID, messageID: inputID })

      const row = yield* ctx.services.db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, inputID))
        .get()
        .pipe(Effect.orDie)
      if (!row) throw new Error(`input row was deleted instead of marked cancelled`)
      if (row.time_cancelled === null) throw new Error(`expected time_cancelled to be set`)
      if (row.promoted_seq !== null) throw new Error(`expected promoted_seq to remain null after cancellation`)
    }),
  )
})
