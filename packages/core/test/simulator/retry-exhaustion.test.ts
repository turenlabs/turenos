/**
 * Simulator suite: the session-level provider retry ladder, end to end.
 *
 * `SessionRunnerRetry.decide` (src/session/runner/retry.ts) owns the *user-visible* retry — the
 * one that exists because a provider answered "come back later". Its contract, and what each
 * scenario below pins:
 *
 *   - only `RateLimit` (429) and `ProviderInternal` (500/503/504/529) are session-retried;
 *     `Transport` is left to `RequestExecutor` and is not replayed here;
 *   - `MAX_ATTEMPTS = 8`, checked as `attempt >= maxAttempts` *before* scheduling the next one, so
 *     a turn gets nine provider attempts in total: the original plus eight retries;
 *   - the ladder is gated on `!publisher.hasAssistantStarted()` in runner/llm.ts — once a single
 *     content frame is durable, replaying would duplicate it, so even a textbook-retryable 429 is
 *     terminal;
 *   - every scheduled wait publishes `SessionEvent.Retried`, which the projector turns into a
 *     durable `retry` status row stamped with `SessionStatus.owner`.
 *
 * Determinism: the backoff for a failure that carries `retryAfterMs` is that number verbatim
 * (`delayFor` honours a provider deadline in full), so the fast ladders here use `retryAfterMs: 0`
 * and complete in milliseconds instead of the 2s/4s/8s header-less schedule. The one scenario that
 * needs a *wide* window to act inside uses `retryAfterMs: 30_000` and synchronizes on the durable
 * retry row rather than on wall-clock guesses.
 *
 * Overlap note: `lifecycle.test.ts` already asserts nine immediate rate limits settle failed, and
 * `turn-matrix.test.ts` covers interrupting a retry backoff. This suite adds the reason coverage
 * (500/503 alongside 429), both sides of the MAX_ATTEMPTS boundary, the post-content gate, and
 * the recovery half — what `V2Session.recover` does to a live retry versus a crashed one.
 */
import { describe } from "bun:test"
import { eq } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { LLMError, ProviderInternalReason, RateLimitReason } from "@turenlabs/llm"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionTable } from "@turenlabs/core/session/sql"
import {
  reply,
  requestUserTexts,
  simulate,
  type RequestRecord,
  type ScenarioBehavior,
  type ScenarioContext,
} from "./harness"

/** A 429 that fails the stream before any event. `retryAfterMs` is the literal backoff. */
const rateLimited = (attempt: number, retryAfterMs = 0): ScenarioBehavior => ({
  label: `429-${attempt}`,
  events: [],
  failAfter: {
    count: 0,
    error: new LLMError({
      module: "simulator",
      method: "stream",
      reason: new RateLimitReason({ message: `Rate limited attempt ${attempt}`, retryAfterMs }),
    }),
  },
})

/** A 5xx that fails the stream before any event; the other half of `isSessionRetryable`. */
const providerInternal = (status: number, attempt: number, retryAfterMs = 0): ScenarioBehavior => ({
  label: `${status}-${attempt}`,
  events: [],
  failAfter: {
    count: 0,
    error: new LLMError({
      module: "simulator",
      method: "stream",
      reason: new ProviderInternalReason({
        message: `Provider ${status} on attempt ${attempt}`,
        status,
        retryAfterMs,
      }),
    }),
  },
})

const rateLimitError = (message: string) =>
  new LLMError({
    module: "simulator",
    method: "stream",
    reason: new RateLimitReason({ message, retryAfterMs: 0 }),
  })

const statusRow = (ctx: ScenarioContext) =>
  ctx.services.db
    .select({
      status: SessionTable.status,
      status_owner: SessionTable.status_owner,
      status_attempt: SessionTable.status_attempt,
      status_message: SessionTable.status_message,
      status_next: SessionTable.status_next,
      time_compacting: SessionTable.time_compacting,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, ctx.sessionID))
    .get()
    .pipe(Effect.orDie)

/**
 * Parks until the durable row says the run is inside the backoff of a specific attempt AND the
 * expected number of provider requests have been served. Synchronizing on the row (rather than a
 * sleep) is what makes "act during the third retry wait" deterministic.
 */
const whileRetryPending = (ctx: ScenarioContext, expected: { readonly attempt: number; readonly requests: number }) =>
  Effect.gen(function* () {
    yield* ctx.step(`poll(status=retry attempt=${expected.attempt})`)
    const startedAt = Date.now()
    while (true) {
      const row = yield* statusRow(ctx)
      if (
        row?.status === "retry" &&
        row.status_attempt === expected.attempt &&
        ctx.provider.requests().length === expected.requests
      ) {
        if (row.status_owner === null) throw new Error("a live retry row must name its owning process")
        return
      }
      if (Date.now() - startedAt > 6_000)
        throw new Error(
          `session never parked in retry attempt ${expected.attempt} ` +
            `(status=${row?.status ?? "missing"} attempt=${row?.status_attempt ?? "null"} ` +
            `requests=${ctx.provider.requests().length})`,
        )
      yield* Effect.sleep(Duration.millis(10))
    }
  })

const expectRequestLabels = (records: ReadonlyArray<RequestRecord>, expected: ReadonlyArray<string>, label: string) => {
  const actual = records.map((record) => record.label ?? "unlabeled")
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
    throw new Error(`[${label}] request labels ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

const assistants = (ctx: ScenarioContext) =>
  ctx.services.store.context(ctx.sessionID).pipe(
    Effect.orDie,
    Effect.map((messages) =>
      messages.filter((message): message is SessionMessage.Assistant => message.type === "assistant"),
    ),
  )

describe("retry ladder: typed failures that buy another attempt", () => {
  // One of each session-retryable reason, back to back. All three failures happen before the
  // publisher starts an assistant, so none of them writes anything durable to the transcript: the
  // fourth attempt succeeds and the session ends with a single clean assistant message. The last
  // request also proves the prompt is sent once, not accumulated across attempts.
  simulate("a 429, a 500 and a 503 each buy another attempt and the fourth succeeds", (ctx) =>
    Effect.gen(function* () {
      const text = "Ride out three retryable provider failures."
      ctx.provider.enqueue(
        rateLimited(1),
        providerInternal(500, 2),
        providerInternal(503, 3),
        reply("Recovered on the fourth attempt.", { label: "recovered" }),
      )
      yield* ctx.user.prompt(text)
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })

      const records = ctx.provider.requests()
      expectRequestLabels(records, ["429-1", "500-2", "503-3", "recovered"], "typed retry ladder")
      if (ctx.provider.queued() !== 0)
        throw new Error(`expected every behavior to be consumed, saw ${ctx.provider.queued()}`)
      if (requestUserTexts(records[3]!.request).join("|") !== text)
        throw new Error(`the recovered attempt carried ${JSON.stringify(requestUserTexts(records[3]!.request))}`)

      const durable = yield* assistants(ctx)
      if (durable.length !== 1)
        throw new Error(`retried attempts must write nothing durable; saw ${durable.length} assistant message(s)`)
      if (durable[0]!.error !== undefined)
        throw new Error(`expected a clean assistant after recovery, saw ${JSON.stringify(durable[0]!.error)}`)
    }),
  )

  // The boundary from below: `decide` refuses only once `attempt >= 8`, so eight retries are
  // legal and the ninth *attempt* is allowed to run. Nine requests, settled idle.
  simulate("eight consecutive retries are allowed and the ninth attempt succeeds", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        ...Array.from({ length: 8 }, (_, index) => rateLimited(index + 1)),
        reply("Recovered on the ninth attempt.", { label: "recovered" }),
      )
      yield* ctx.user.prompt("Spend the entire retry budget, then succeed.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 9 })

      const records = ctx.provider.requests()
      if (records.length !== 9) throw new Error(`expected nine provider attempts, saw ${records.length}`)
      if (records.at(-1)?.label !== "recovered")
        throw new Error(`expected the ninth attempt to be the recovery, saw ${records.at(-1)?.label}`)
      if (ctx.provider.queued() !== 0)
        throw new Error(`expected every behavior to be consumed, saw ${ctx.provider.queued()} queued`)

      const durable = yield* assistants(ctx)
      if (durable.length !== 1 || durable[0]!.error !== undefined)
        throw new Error(`expected one clean assistant after eight retries, saw ${durable.length}`)
    }),
  )
})

describe("retry ladder: exhaustion", () => {
  // The boundary from above, with the 5xx reason (lifecycle.test.ts pins the same wall with
  // 429s). The ninth failure arrives with `attempt === 8`, `decide` returns undefined, and the
  // turn settles failed carrying the provider's own message. No tenth behavior is queued, so a
  // tenth request would die loudly on the empty queue rather than pass silently.
  simulate("the ninth consecutive 503 exhausts the budget and settles failed", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(...Array.from({ length: 9 }, (_, index) => providerInternal(503, index + 1)))
      yield* ctx.user.prompt("Exhaust the retry budget on provider internals.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 9 })

      if (ctx.provider.requests().length !== 9)
        throw new Error(`expected nine provider attempts, saw ${ctx.provider.requests().length}`)
      if (ctx.provider.queued() !== 0)
        throw new Error(`expected every 503 to be consumed, saw ${ctx.provider.queued()} queued`)

      const durable = yield* assistants(ctx)
      if (durable.length !== 1) throw new Error(`expected one failed assistant record, saw ${durable.length}`)
      // The terminal message is the provider's last word, not a paraphrase — and naming attempt 9
      // proves the failure that ended the turn is the one the budget refused to retry.
      if (!/on attempt 9/.test(durable[0]!.error?.message ?? ""))
        throw new Error(`expected the ninth failure to be terminal, saw ${JSON.stringify(durable[0]!.error ?? null)}`)
    }),
  )

  // The replay gate. A 429 is retryable by every other measure, but a content frame has already
  // opened the assistant, so `hasAssistantStarted()` closes the ladder and the failure settles the
  // turn immediately (the buffered delta is still flushed to `Text.Ended` on the way out, which is
  // exactly the fragment a replay would have duplicated). The canary behavior is the assertion: a
  // replayed attempt would have consumed it.
  simulate("a retryable failure after content exists is terminal and never replays", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Partial answer before the rate limit.", {
          label: "partial-then-429",
          chunks: 4,
          interEventDelayMs: 15,
          // step-start, text-start, one delta — the assistant is durably started with text — then 429.
          failAfter: { count: 3, error: rateLimitError("Rate limited after content landed") },
        }),
        reply("A replay would have consumed this.", { label: "canary" }),
      )
      yield* ctx.user.prompt("Fail after content has landed.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 1 })

      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected exactly one attempt, saw ${ctx.provider.requests().length}`)
      if (ctx.provider.queued() !== 1)
        throw new Error("the retryable failure was replayed after content already existed")

      const durable = yield* assistants(ctx)
      if (durable.length !== 1) throw new Error(`expected one assistant record, saw ${durable.length}`)
      const streamed = durable[0]!.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      if (streamed.length === 0) throw new Error("expected the content that closed the retry ladder to be durable")
      if (durable[0]!.error === undefined)
        throw new Error("expected the post-content rate limit to settle the assistant as failed")
    }),
  )
})

describe("retry ladder: recovery", () => {
  // Recovery must never disturb a retry that a live drain still owns. The run is parked in the
  // backoff of its *third* attempt (a 30s provider deadline, honoured verbatim), the coordinator
  // still holds the session, and `recover` has to report "running" and change nothing. Then the
  // interrupt path is checked too: the run exits, `recordUnstartedInterruption` writes the
  // terminal, and a second `recover` is a no-op that never replays the un-run attempt.
  simulate("recover reports a live retry backoff as running and leaves the row alone", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        rateLimited(1),
        rateLimited(2),
        rateLimited(3, 30_000),
        reply("Never reached.", { label: "unreached" }),
      )
      yield* ctx.user.prompt("Park inside the third retry backoff.")
      yield* whileRetryPending(ctx, { attempt: 3, requests: 3 })

      const outcome = yield* ctx.services.session.recover(ctx.sessionID).pipe(Effect.orDie)
      if (outcome.status !== "running")
        throw new Error(`expected recover to defer to the live drain, saw ${JSON.stringify(outcome)}`)
      const during = yield* statusRow(ctx)
      if (during?.status !== "retry" || during.status_owner === null)
        throw new Error(`recover disturbed a live retry row: ${JSON.stringify(during)}`)

      yield* ctx.user.interrupt()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 3 })
      if (ctx.provider.requests().length !== 3)
        throw new Error(`the parked attempt must never run, saw ${ctx.provider.requests().length} requests`)
      if (ctx.provider.queued() !== 1)
        throw new Error(`expected the unreached reply to stay queued, saw ${ctx.provider.queued()}`)

      const after = yield* ctx.services.session.recover(ctx.sessionID).pipe(Effect.orDie)
      if (after.status !== "idle")
        throw new Error(`expected recovery of a settled session to be a no-op, saw ${JSON.stringify(after)}`)
      if (ctx.provider.requests().length !== 3) throw new Error("recovery replayed a provider request")
    }),
  )

  // A killed process is the one failure an in-process harness cannot stage: the coordinator
  // always runs the drain's `onExit`, and that now clears any `retry` row this process still owns
  // (`settleAbandonedRetry`). So the crash is staged where it is actually observable — the
  // durable row a dead process leaves behind: status "retry", a countdown nobody is counting, and
  // a `status_owner` that no live drain claims. `V2Session.recover` is the only path that repairs
  // it (src/session.ts, the `session.status === "retry"` branch), and it must do so without
  // replaying the request the dead process was about to make.
  simulate("a retry row abandoned by a dead process is repaired by recover", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(rateLimited(1), rateLimited(2), reply("Third attempt recovered.", { label: "recovered" }))
      yield* ctx.user.prompt("Retry twice, then finish.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      yield* ctx.step("stage(crashed retry row)")
      yield* ctx.services.db
        .update(SessionTable)
        .set({
          status: "retry",
          status_owner: "proc_simulator_crashed",
          status_attempt: 4,
          status_message: "Rate limited attempt 4",
          status_next: Date.now() + 30_000,
        })
        .where(eq(SessionTable.id, ctx.sessionID))
        .run()
        .pipe(Effect.orDie)

      const outcome = yield* ctx.services.session.recover(ctx.sessionID).pipe(Effect.orDie)
      // Nothing is pending and the stale run is not resumed, so recovery schedules no successor.
      if (outcome.status !== "idle")
        throw new Error(`expected recovery of an abandoned retry to settle idle, saw ${JSON.stringify(outcome)}`)

      const repaired = yield* statusRow(ctx)
      if (repaired?.status !== "interrupted")
        throw new Error(`expected the crashed row to become "interrupted", saw ${JSON.stringify(repaired)}`)
      if (repaired.status_owner !== null)
        throw new Error(`a repaired row must name no owner, saw ${repaired.status_owner}`)
      if (repaired.status_attempt !== null || repaired.status_next !== null)
        throw new Error(`the abandoned countdown must be cleared, saw ${JSON.stringify(repaired)}`)
      if (ctx.provider.requests().length !== 3)
        throw new Error(`recovery replayed the dead process's attempt, saw ${ctx.provider.requests().length} requests`)
    }),
  )
})
