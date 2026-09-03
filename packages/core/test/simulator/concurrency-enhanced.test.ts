/**
 * Simulator suite: concurrent coordination using new harness helpers.
 *
 * Enhanced scenarios using concurrentCallers(), demonstrating clean test patterns
 * for coordinator serialization, wake coalescing, and concurrent same-Session behavior.
 */

import { describe } from "bun:test"
import { Effect } from "effect"
import { SessionMessage } from "@turenlabs/core/session/message"
import { reply, requestUserTexts, simulate } from "./harness"

describe("concurrency: coordinator serialization", () => {
  /**
   * Multiple concurrent resume calls to the same Session serialize cleanly.
   *
   * This tests the coordinator's guarantee that concurrent resume() calls for one
   * Session all join the same drain and receive consistent results.
   */
  simulate("concurrent resumeWithCancel calls serialize to one drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Single drain serves all joiners.", { interEventDelayMs: 20 }))
      yield* ctx.user.prompt("Start.", { resume: false })

      // 5 concurrent callers all try to resume the same session.
      const results = yield* ctx.phase.concurrentCallers(5, ({ index }) =>
        Effect.gen(function* () {
          yield* ctx.user.resumeWithCancel()
          return index
        }),
      )
      if (results.length !== 5) throw new Error(`expected 5 joiners, got ${results.length}`)

      // Verify they all settled against one drain (one request).
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected 1 shared drain, saw ${ctx.provider.requests().length} requests`)
    }),
  )

  /**
   * A wake storm after a turn has ended costs nothing.
   *
   * `pendingWake` is a boolean, so eight wakes collapse into at most one successor drain, and that
   * drain runs with `force = false` — finding an empty inbox it returns without touching the
   * provider (runner/llm.ts, the `!input.force && !hasSteer && ...` guard). "Without extra
   * requests" therefore means exactly one request in total, not one request per storm.
   */
  simulate("wake storm via concurrentCallers coalesces without extra requests", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("First turn."))
      yield* ctx.user.prompt("Start.")
      yield* ctx.phase.afterProviderEnd()

      // 8 concurrent wakeNoResume calls.
      yield* ctx.phase.concurrentCallers(8, () => ctx.user.wakeNoResume())

      // Settle and verify the storm bought no provider turn at all.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected 1 request (coalesced wakes cost nothing), saw ${ctx.provider.requests().length}`)
      if (ctx.provider.queued() !== 0)
        throw new Error(`expected every behavior to be consumed, saw ${ctx.provider.queued()} queued`)
    }),
  )

  /**
   * Rapid steer admissions via concurrentCallers preserve order without loss.
   *
   * Tests that fast concurrent steers all land, deduplicate correctly, and
   * execute in their durable admission order.
   */
  /**
   * Rapid concurrent steers all land, exactly once each, in their durable admission order.
   *
   * The *number* of provider turns the storm buys is deliberately not asserted: steers admitted
   * while a drain is live are carried by `promoteSteers` into one continuation, so the count is a
   * function of how the storm interleaves with the settling turn. What must hold regardless is the
   * part a request count cannot prove — no steer is dropped, none is delivered twice, and the order
   * the model sees is the order the per-session admission lock assigned (`admittedSeq`), not the
   * order the unbounded callers happened to fire in.
   */
  simulate("rapid concurrent steers preserve admission order", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("First response."), reply("Steer 1."), reply("Steer 2."), reply("Steer 3."))
      yield* ctx.user.prompt("Start.")
      yield* ctx.phase.afterProviderEnd()

      // 3 concurrent steers with distinct payloads.
      const admitted = yield* ctx.phase.concurrentCallers(3, ({ index }) =>
        ctx.user.prompt(`Steer ${index + 1}.`, { delivery: "steer" }),
      )

      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      // History accumulates, so the last request carries every steer that ever landed.
      const delivered = requestUserTexts(ctx.provider.requests().at(-1)!.request)
      for (const text of ["Steer 1.", "Steer 2.", "Steer 3."]) {
        const seen = delivered.filter((candidate) => candidate === text).length
        if (seen !== 1) throw new Error(`expected ${JSON.stringify(text)} to reach the model exactly once, saw ${seen}`)
      }
      const byAdmission = [...admitted]
        .sort((left, right) => left.admittedSeq - right.admittedSeq)
        .map((row) => row.prompt.text)
      const asDelivered = delivered.filter((text) => byAdmission.includes(text))
      if (asDelivered.join("|") !== byAdmission.join("|"))
        throw new Error(
          `steers reached the model as ${JSON.stringify(asDelivered)} ` +
            `but were admitted as ${JSON.stringify(byAdmission)}`,
        )
    }),
  )

  /**
   * Concurrent queue admissions deduplicate by ID when identical.
   *
   * Tests that multiple callers admitting the exact same message (same ID, text, etc.)
   * result in one durable row and consistent results to all callers.
   */
  simulate("concurrent identical queue admissions deduplicate", (ctx) =>
    Effect.gen(function* () {
      // Two behaviors: the opening turn, and the one turn the deduplicated queue item earns. A
      // second promotion of the same message would need a third and die loudly on the empty queue.
      ctx.provider.enqueue(reply("Response."), reply("Queued item handled once."))
      yield* ctx.user.prompt("Initial.")
      yield* ctx.phase.afterProviderEnd()

      // All 3 callers admit the exact same message (same ID, text, delivery).
      const messageID = SessionMessage.ID.make("msg_test_concurrent_queue")
      const admitted = yield* ctx.phase.concurrentCallers(3, () =>
        ctx.user.prompt("Queued item", {
          id: messageID,
          delivery: "queue",
        }),
      )

      // All 3 should return the same admitted row (seq numbers, etc.).
      if (!admitted.every((a) => a.id === admitted[0]!.id && a.admittedSeq === admitted[0]!.admittedSeq))
        throw new Error("concurrent admissions did not return identical rows")

      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      if (ctx.provider.requests().length !== 2)
        throw new Error(
          `expected 2 requests (the opening turn and one deduplicated queue item), ` +
            `saw ${ctx.provider.requests().length}`,
        )
    }),
  )
})

describe("concurrency: independent root sessions", () => {
  /**
   * Two independent root sessions run concurrently without head-of-line blocking.
   *
   * This is a critical production invariant: the coordinator must allow unrelated
   * sessions to overlap, not serialize globally.
   *
   * Note: The simulator single-harness design means we test serialization within one
   * session; testing truly parallel independent roots requires multi-harness setup.
   * This scenario documents the intent but is limited by harness architecture.
   */
  simulate.skip("(architectural limitation) two independent sessions overlap concurrently", (ctx) =>
    Effect.gen(function* () {
      // Current simulator harness: one context, one sessionID per test.
      // True parallel-session testing requires:
      //   - Two independent makeContext() calls
      //   - Two separate provider queues (or shared with request filtering)
      //   - Assertions on interleaved request log order
      //
      // This is a known limitation of the single-harness model.
      // Lower-level coordinator tests cover this.
      yield* Effect.fail(
        new Error("multi-session harness not implemented; see coordinator.test.ts for lower-level coverage"),
      )
    }),
  )
})
