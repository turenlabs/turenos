/**
 * Simulator suite: steer/queue delivery semantics under timing pressure.
 *
 * Promotion contract under test (src/session/runner/llm.ts + src/session/input.ts):
 *   - Steers are promoted at turn start (`promoteSteers`, admitted_seq <= the step's inbox
 *     cutoff, ascending admission order) — a steer admitted before the drain's first request
 *     lands in THAT turn's request.
 *   - A steer admitted mid-stream forces one continuation step of the same drain
 *     (`needsContinuation = hasPendingSteer`), so it lands in the next request.
 *   - Queued input is promoted one row per successor turn (`promoteNextQueued`, LIMIT 1,
 *     ascending admission order), and only when no steer is pending — steers always land first.
 *   - `prompt({ resume: false })` admits without waking: the row sits admitted-not-promoted
 *     (promoted_seq NULL) with the session idle until `session.resume()` force-claims a drain.
 *
 * Timing pressure is applied with inter-chunk delays (60ms gaps) so "mid-stream" admissions have
 * a wide deterministic window, and with `resume: false` staging where an admission must
 * deterministically precede the first request. Note the wire format carries no steer/queue
 * markers — a promoted input is an ordinary user message, so every assertion is over
 * `requestUserTexts` order and request counts, per scenario. Where a slow machine could legally
 * shift a boundary (a "mid-stream" steer landing after the stream finished instead starts a
 * successor turn), the asserted request shapes are identical either way, so the expectations
 * remain honest.
 *
 * Every scenario ends in `invariants.settled` with expect "idle": all delivery flows here finish
 * with every admitted input promoted and every reply completed — nothing fails or is interrupted.
 */
import { describe } from "bun:test"
import { SessionInputTable } from "@turenlabs/core/session/sql"
import { eq } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { reply, requestUserTexts, simulate, type RequestRecord } from "./harness"

const expectUserTexts = (label: string, record: RequestRecord | undefined, expected: ReadonlyArray<string>) => {
  if (!record) throw new Error(`[delivery] ${label}: request was never issued`)
  const actual = requestUserTexts(record.request)
  if (actual.length !== expected.length || actual.some((text, index) => text !== expected[index]))
    throw new Error(`[delivery] ${label}: user texts ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

const expectRequestCount = (records: ReadonlyArray<RequestRecord>, expected: number) => {
  if (records.length !== expected)
    throw new Error(
      `[delivery] expected ${expected} provider request(s), saw ${records.length}: ` +
        JSON.stringify(records.map((record) => record.label ?? "unlabeled")),
    )
}

describe("delivery: steer", () => {
  // Both inputs are staged with resume:false so their admission deterministically precedes the
  // drain's first request; resume() then force-claims the drain and turn-start promoteSteers
  // promotes both rows (ascending admission order) into the opening request. Justified
  // expectation: idle after exactly one request carrying both texts — nothing about this flow can
  // fail, and a second request would mean the steer missed the turn-start promotion.
  simulate("steer admitted before the first request lands in that turn's request", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Handled both instructions.", { label: "opening" }))
      yield* ctx.user.prompt("Start the work.", { resume: false })
      yield* ctx.user.prompt("Steer before start.", { delivery: "steer", resume: false })
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 1)
      expectUserTexts("opening request", records[0], ["Start the work.", "Steer before start."])
    }),
  )

  // The opening stream holds ~300ms of inter-chunk gaps after first byte, so the steer is
  // admitted mid-stream; the drain then runs one continuation step whose request carries the
  // steer. Justified expectation: idle after exactly two requests — opening without the steer,
  // continuation with it.
  simulate("steer admitted mid-stream lands in the next step's request of the same drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Opening answer.", { chunks: 6, interEventDelayMs: 60, label: "opening" }),
        reply("Steered answer.", { label: "continuation" }),
      )
      yield* ctx.user.prompt("Start the work.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.user.prompt("Change of course.", { delivery: "steer" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 2)
      expectUserTexts("opening request", records[0], ["Start the work."])
      expectUserTexts("continuation request", records[1], ["Start the work.", "Change of course."])
    }),
  )

  // Two steers admitted back-to-back inside the same stream window share one boundary: the next
  // step's promoteSteers promotes both (both admitted_seq precede the step's cutoff), in
  // admission order. Justified expectation: idle after exactly two requests, the second carrying
  // both steers in order — a third request would mean the boundary split them.
  simulate("rapid double-steer before the next boundary promotes both in order", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Opening answer.", { chunks: 8, interEventDelayMs: 60, label: "opening" }),
        reply("Both steers handled.", { label: "continuation" }),
      )
      yield* ctx.user.prompt("Start the work.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.user.prompt("Steer one.", { delivery: "steer" })
      yield* ctx.user.prompt("Steer two.", { delivery: "steer" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 2)
      expectUserTexts("opening request", records[0], ["Start the work."])
      expectUserTexts("continuation request", records[1], ["Start the work.", "Steer one.", "Steer two."])
    }),
  )
})

describe("delivery: queue", () => {
  // A queued message never merges into the live turn: the opening request keeps only the original
  // prompt, the turn completes, and the successor turn promotes the queued row. Justified
  // expectation: idle after exactly two requests, with the queued text absent from the first and
  // present in the second.
  simulate("queue admitted mid-turn is absent from the current turn and promoted in the successor", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Opening answer.", { chunks: 6, interEventDelayMs: 60, label: "opening" }),
        reply("Queued follow-up handled.", { label: "successor" }),
      )
      yield* ctx.user.prompt("Start the work.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.user.prompt("Do this after.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 2)
      expectUserTexts("opening request", records[0], ["Start the work."])
      expectUserTexts("successor request", records[1], ["Start the work.", "Do this after."])
    }),
  )

  // promoteNextQueued is LIMIT 1 in admission order, so two queued messages drain as two
  // successor turns, one message each. Justified expectation: idle after exactly three requests
  // with the queue texts appearing one per request, oldest first.
  simulate("multiple queued messages deliver one per successor turn in admission order", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Opening answer.", { chunks: 6, interEventDelayMs: 60, label: "opening" }),
        reply("First queued handled.", { label: "successor-1" }),
        reply("Second queued handled.", { label: "successor-2" }),
      )
      yield* ctx.user.prompt("Start the work.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.user.prompt("Queue first.", { delivery: "queue" })
      yield* ctx.user.prompt("Queue second.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 3)
      expectUserTexts("opening request", records[0], ["Start the work."])
      expectUserTexts("first successor", records[1], ["Start the work.", "Queue first."])
      expectUserTexts("second successor", records[2], ["Start the work.", "Queue first.", "Queue second."])
    }),
  )

  // Steer and queue admitted together in the same stream window: the steer forces a continuation
  // step of the live drain (queue still withheld — queue promotion only runs when no steer is
  // pending), and the queue is promoted by the following turn. Justified expectation: idle after
  // exactly three requests — steer text arrives in request 2, queue text only in request 3.
  simulate("steer + queue admitted together: steer lands first, queue in the following turn", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Opening answer.", { chunks: 6, interEventDelayMs: 60, label: "opening" }),
        reply("Steer handled.", { label: "continuation" }),
        reply("Queue handled.", { label: "successor" }),
      )
      yield* ctx.user.prompt("Start the work.")
      yield* ctx.phase.afterFirstByte()
      yield* ctx.user.prompt("Steer now.", { delivery: "steer" })
      yield* ctx.user.prompt("Queue later.", { delivery: "queue" })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 3)
      expectUserTexts("opening request", records[0], ["Start the work."])
      expectUserTexts("continuation request", records[1], ["Start the work.", "Steer now."])
      expectUserTexts("successor request", records[2], ["Start the work.", "Steer now.", "Queue later."])
    }),
  )
})

describe("delivery: deferred resume", () => {
  // resume:false admits without waking (session.ts guards the wake on `input.resume !== false`),
  // so the input row sits admitted-not-promoted and the session never leaves idle — the first
  // settle uses minRequests 0 + allowPendingInput because the docked row is the deliberate state,
  // after a 200ms grace so an erroneous wake would have surfaced as a request. resume() then
  // force-claims a drain that promotes the row. Justified expectations: idle both times — first
  // because nothing ever ran, then because the single resumed turn completes cleanly.
  simulate("resume:false docks input admitted-not-promoted; resume() drains it", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Resumed and done.", { label: "resumed" }))
      yield* ctx.user.prompt("Do this when I say.", { resume: false })
      yield* Effect.sleep(Duration.millis(200))
      expectRequestCount(ctx.provider.requests(), 0)
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 0, allowPendingInput: true })

      const docked = yield* ctx.services.db
        .select({
          promoted: SessionInputTable.promoted_seq,
          cancelled: SessionInputTable.time_cancelled,
          delivery: SessionInputTable.delivery,
        })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, ctx.sessionID))
        .all()
        .pipe(Effect.orDie)
      if (docked.length !== 1) throw new Error(`[delivery] expected exactly one docked input row, saw ${docked.length}`)
      if (docked[0]!.promoted !== null)
        throw new Error(`[delivery] resume:false input was promoted eagerly (promoted_seq=${docked[0]!.promoted})`)
      if (docked[0]!.cancelled !== null) throw new Error("[delivery] resume:false input was cancelled, not docked")

      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 1)
      expectUserTexts("resumed request", records[0], ["Do this when I say."])
    }),
  )
})
