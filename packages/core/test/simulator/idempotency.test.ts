/**
 * Simulator suite: durable prompt identity under exact retries.
 *
 * Real callers mint the message ID client-side (the desktop composer, the SDK, any HTTP client
 * that has to retry a request whose response it never saw), so `V2Session.prompt` takes an
 * optional `id` and reconciles a repeat of that identity instead of admitting a second message.
 * The contract lives in `V2Session.admitAtBoundary` (src/session.ts) over `SessionInput`:
 *
 *   - an ID that already has an identity row -> return the stored `Admitted`, admit nothing new,
 *     as long as `SessionInput.equivalentIdentity` holds (same kind, session, prompt payload,
 *     delivery, agent and model);
 *   - anything about the payload that differs -> `Session.PromptConflictError`, and the first
 *     admission is left untouched;
 *   - the reconciliation is under `operations.withLock(sessionID)`, so concurrent callers racing
 *     the same ID serialize into one durable row rather than one row each.
 *
 * These scenarios pin all four windows a retry can land in — before the drain promotes the row,
 * while the turn is running, after it settled, and concurrently with itself — and every one of
 * them asserts the *observable* consequence a duplicate would have: an extra user message in the
 * projected transcript, an extra durable input row, or an extra provider request carrying the
 * same text twice on the wire.
 *
 * Harness note: `ctx.user.prompt(text, { id })` forwards a client-minted identity and returns the
 * durable `Admitted` record, which is what these scenarios assert on (admittedSeq/promotedSeq must
 * be reproduced by a retry, not re-minted). The conflict cases still call
 * `ctx.services.session.prompt` directly — the same pattern `lifecycle.test.ts` uses — because
 * `user.prompt` orDies its error channel and the typed failure is the thing under test.
 *
 * Retries here always use the caller's real shape (`resume` left at its default) so the wake a
 * repeat admission registers is part of what is under test: it must find nothing pending and
 * therefore issue no provider request. Scenarios that deliberately dock input use `resume: false`
 * and say so.
 *
 * GAP (deliberately not covered here): a caller that is *cancelled* mid-admission — an HTTP
 * client that disconnects between `SessionInput.admit` publishing and the response being written
 * — cannot be staged without a harness primitive for aborting an in-flight admission. See the
 * gap block at the bottom of concurrency.test.ts.
 */
import { describe } from "bun:test"
import { eq } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionInputTable } from "@turenlabs/core/session/sql"
import { reply, replyWithTool, requestUserTexts, simulate, type RequestRecord, type ScenarioContext } from "./harness"

const inputRows = (ctx: ScenarioContext) =>
  ctx.services.db
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, ctx.sessionID))
    .all()
    .pipe(Effect.orDie)

const userMessages = (ctx: ScenarioContext) =>
  ctx.services.store.context(ctx.sessionID).pipe(
    Effect.orDie,
    Effect.map((messages) => messages.filter((message): message is SessionMessage.User => message.type === "user")),
  )

const expectRequestCount = (records: ReadonlyArray<RequestRecord>, expected: number, label: string) => {
  if (records.length !== expected)
    throw new Error(
      `[${label}] expected ${expected} provider request(s), saw ${records.length}: ` +
        JSON.stringify(records.map((record) => record.label ?? "unlabeled")),
    )
}

const expectUserTexts = (label: string, record: RequestRecord | undefined, expected: ReadonlyArray<string>) => {
  if (!record) throw new Error(`[${label}] request was never issued`)
  const actual = requestUserTexts(record.request)
  if (actual.length !== expected.length || actual.some((text, index) => text !== expected[index]))
    throw new Error(`[${label}] user texts ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

const expectSingleAdmission = (ctx: ScenarioContext, id: SessionMessage.ID, label: string) =>
  Effect.gen(function* () {
    const rows = yield* inputRows(ctx)
    if (rows.length !== 1 || rows[0]!.id !== id)
      throw new Error(
        `[${label}] expected exactly one durable input row (${id}), saw ${JSON.stringify(rows.map((row) => row.id))}`,
      )
    const users = yield* userMessages(ctx)
    if (users.length !== 1 || users[0]!.id !== id)
      throw new Error(
        `[${label}] expected exactly one projected user message (${id}), saw ` +
          JSON.stringify(users.map((message) => message.id)),
      )
  })

describe("prompt identity: exact retries", () => {
  // The retry lands while the row is still docked (`resume: false` on both calls, so nothing has
  // claimed a drain). The second admission must find the identity row, return the *same*
  // `admittedSeq`, and leave the row unpromoted — a second row here would be delivered as a
  // second user message the moment the drain starts.
  simulate("an exact retry before promotion returns the docked row and admits nothing new", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_sim_idem_predrain")
      const text = "Admit this exactly once."

      const first = yield* ctx.user.prompt(text, { id, resume: false })
      const retried = yield* ctx.user.prompt(text, { id, resume: false })
      if (first.id !== id || retried.id !== id)
        throw new Error(`expected both admissions to carry ${id}, saw ${first.id} and ${retried.id}`)
      if (retried.admittedSeq !== first.admittedSeq)
        throw new Error(`expected a stable admission sequence, saw ${first.admittedSeq} then ${retried.admittedSeq}`)
      if (first.promotedSeq !== undefined || retried.promotedSeq !== undefined)
        throw new Error("resume:false admissions must stay docked, not promoted")

      const docked = yield* inputRows(ctx)
      if (docked.length !== 1) throw new Error(`expected one docked input row, saw ${docked.length}`)

      ctx.provider.enqueue(reply("Handled the retried admission once.", { label: "resumed" }))
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 1, "exact retry before promotion")
      // The strongest duplication check available: the wire itself carries the text once.
      expectUserTexts("resumed request", records[0], [text])
      yield* expectSingleAdmission(ctx, id, "exact retry before promotion")
    }),
  )

  // The retry lands mid-turn, after the drain promoted the row and while `sim_slow` holds the
  // turn open. The admission must observe the *promoted* row (promotedSeq set) and return it; the
  // wake it registers coalesces into the live entry and must not produce a third request.
  simulate("an exact retry while the turn is running returns the promoted row", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_sim_idem_running")
      const text = "Run the slow tool exactly once."

      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 500 }, { label: "opening" }),
        reply("Finished after the tool.", { label: "continuation" }),
      )
      const first = yield* ctx.user.prompt(text, { id })
      yield* ctx.phase.whenToolRunning("sim_slow")

      const retried = yield* ctx.user.prompt(text, { id })
      if (retried.id !== id || retried.admittedSeq !== first.admittedSeq)
        throw new Error(
          `expected the mid-turn retry to reconcile, saw ${retried.id}@${retried.admittedSeq} ` +
            `against ${first.id}@${first.admittedSeq}`,
        )
      if (retried.promotedSeq === undefined)
        throw new Error("a retry during execution must observe the row the drain already promoted")

      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      // Exactly the tool turn and its continuation: the retry's wake found nothing pending, so the
      // coalesced successor drain (force = false) returned without a provider request.
      expectRequestCount(ctx.provider.requests(), 2, "exact retry during execution")
      yield* expectSingleAdmission(ctx, id, "exact retry during execution")
    }),
  )

  // The retry lands after the session settled idle — the shape a client produces when it times
  // out waiting for a response that actually succeeded. The identity row is still active, so the
  // completed admission comes back and the wake must not re-run the turn.
  simulate("an exact retry after the turn settled returns the completed row and re-runs nothing", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_sim_idem_settled")
      const text = "Do this work exactly once."

      ctx.provider.enqueue(reply("Handled once.", { label: "opening" }))
      const first = yield* ctx.user.prompt(text, { id })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const retried = yield* ctx.user.prompt(text, { id })
      if (retried.id !== id || retried.admittedSeq !== first.admittedSeq)
        throw new Error(`expected the post-settlement retry to reconcile, saw ${retried.id}@${retried.admittedSeq}`)
      if (retried.promotedSeq === undefined)
        throw new Error("a retry after completion must report the promoted row, not a fresh admission")

      // Grace so the retry's wake has actually run its (force = false) drain: an erroneous
      // second turn would have consumed a behavior and died on the empty queue by now.
      yield* Effect.sleep(Duration.millis(250))
      expectRequestCount(ctx.provider.requests(), 1, "exact retry after completion")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      yield* expectSingleAdmission(ctx, id, "exact retry after completion")
    }),
  )
})

describe("prompt identity: conflicting reuse", () => {
  // `SessionInput.equivalentIdentity` compares the whole payload, so a caller that reuses an ID
  // for anything else is a bug in the caller, not a retry. Both the text and the delivery mode
  // are checked here because they fail through different comparisons (`matchesPrompt` vs. the
  // delivery equality in `SessionInput.equivalent`), and the original admission must survive both.
  simulate("reusing a message ID with different content or delivery is a conflict", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_sim_idem_conflict")
      const text = "Original instruction."
      const base = { id, sessionID: ctx.sessionID, prompt: Prompt.make({ text }), resume: false } as const

      yield* ctx.user.prompt(text, { id, resume: false })

      // The conflict path goes through the service directly: `user.prompt` orDies its error
      // channel, and the typed failure is exactly what is under test here.
      const textConflict = yield* ctx.services.session
        .prompt({ ...base, prompt: Prompt.make({ text: "Rewritten instruction." }) })
        .pipe(Effect.flip)
      if (textConflict._tag !== "Session.PromptConflictError")
        throw new Error(`expected a prompt identity conflict for a changed payload, saw ${textConflict._tag}`)

      const deliveryConflict = yield* ctx.services.session.prompt({ ...base, delivery: "queue" }).pipe(Effect.flip)
      if (deliveryConflict._tag !== "Session.PromptConflictError")
        throw new Error(`expected a prompt identity conflict for a changed delivery, saw ${deliveryConflict._tag}`)

      // A rejected reuse must not have disturbed the admission it collided with.
      const rows = yield* inputRows(ctx)
      if (rows.length !== 1) throw new Error(`expected the conflicts to admit nothing, saw ${rows.length} row(s)`)
      if (rows[0]!.prompt.text !== text)
        throw new Error(`expected the original payload to survive, saw ${JSON.stringify(rows[0]!.prompt.text)}`)
      if (rows[0]!.delivery !== "steer")
        throw new Error(`expected the original delivery to survive, saw ${rows[0]!.delivery}`)

      ctx.provider.enqueue(reply("Ran the original instruction.", { label: "resumed" }))
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      expectUserTexts("resumed request", ctx.provider.requests()[0], [text])
      yield* expectSingleAdmission(ctx, id, "conflicting reuse")
    }),
  )
})

describe("prompt identity: concurrent exact admissions", () => {
  // Six callers race the same identity. `V2Session.prompt` runs under a per-session operation
  // lock, so exactly one of them reaches `SessionInput.admit` and the other five reconcile
  // against the row it wrote — every caller must come back with the same admittedSeq. Without
  // the lock the losers would take the `existing === undefined` branch too and the projector's
  // `LifecycleConflict` would surface as a conflict error (or, worse, a duplicated turn).
  simulate("concurrent admissions of one message ID serialize into a single durable row", (ctx) =>
    Effect.gen(function* () {
      const id = SessionMessage.ID.make("msg_sim_idem_concurrent")
      const text = "Admit me exactly once, whoever gets there first."

      const admissions = yield* Effect.all(
        Array.from({ length: 6 }, () => ctx.user.prompt(text, { id, resume: false })),
        { concurrency: "unbounded" },
      )
      const identities = new Set(admissions.map((admitted) => `${admitted.id}@${admitted.admittedSeq}`))
      if (identities.size !== 1)
        throw new Error(`expected one shared admission identity, saw ${JSON.stringify([...identities])}`)
      if (admissions.some((admitted) => admitted.id !== id))
        throw new Error("a concurrent admission returned a different message ID")

      const rows = yield* inputRows(ctx)
      if (rows.length !== 1) throw new Error(`expected six concurrent admissions to write one row, saw ${rows.length}`)

      ctx.provider.enqueue(reply("Ran the single admission.", { label: "resumed" }))
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const records = ctx.provider.requests()
      expectRequestCount(records, 1, "concurrent exact admissions")
      expectUserTexts("resumed request", records[0], [text])
      yield* expectSingleAdmission(ctx, id, "concurrent exact admissions")
    }),
  )
})
