/**
 * Simulator suite: caller cancellation distinct from session interruption.
 *
 * Tests the critical production boundary where an HTTP client disconnect or cancelled
 * caller join must NOT interrupt the process-owned drain. The drain's ownership lives in
 * the coordinator's fiber set; only an explicit session.interrupt() stops it.
 *
 * Scenarios:
 * - Caller cancellation mid-turn does not stop the drain; execution continues.
 * - Wake storm coalesces when signaled without claiming the drain.
 * - Concurrent resumeWithCancel joiners settle despite partial cancellations.
 */

import { describe } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber } from "effect"
import { SessionInputTable } from "@turenlabs/core/session/sql"
import { reply, replyWithTool, simulate, type ResumeError } from "./harness"

describe("disconnect: caller cancellation", () => {
  /**
   * Caller cancellation mid-turn does not stop the drain.
   *
   * Setup: slow provider reply with inter-event delays.
   * Action: Call resumeWithCancel, wait for first byte, then interrupt the join deferred.
   * Verify: The drain continues to completion; only 1 provider request; full response lands.
   */
  simulate("caller cancellation mid-turn does not stop the drain", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        reply("Full response delivered despite caller disconnect.", {
          chunks: 4,
          interEventDelayMs: 50,
          label: "slow-reply",
        }),
      )
      yield* ctx.user.prompt("Start the work.")

      // Join the drain with an interruptible deferred, then cancel it.
      const join = yield* ctx.user.resumeWithCancel()
      yield* ctx.phase.afterFirstByte()

      // Fork a fiber that awaits the deferred, then interrupt it (the fiber, not the drain).
      const joinFiber = yield* Effect.forkChild(Deferred.await(join))
      yield* Effect.sleep("10 millis") // Let the fiber start waiting
      yield* Fiber.interrupt(joinFiber)

      // The drain should continue despite the caller's interruption.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Verify the full message was delivered. The provider request only carries what was sent
      // *to* the model, so the reply is read back off the durable transcript instead.
      const records = ctx.provider.requests()
      if (records.length !== 1) throw new Error(`expected 1 request, saw ${records.length}`)
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const text = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
      if (!text.includes("Full response"))
        throw new Error(`response was not fully delivered, saw ${JSON.stringify(text)}`)
    }),
  )

  /**
   * Wake storm coalesces mid-turn without extra requests.
   *
   * Setup: Tool + continuation reply.
   * Action: Admit, wait for tool, then fire 5 concurrent wakeNoResume calls.
   * Verify: No extra provider requests; all coalesce into the tool's existing turn.
   */
  simulate("wake storm coalesces mid-turn without spawning extra requests", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(replyWithTool("sim_slow", { ms: 100 }), reply("Wakes coalesced and continued."))
      yield* ctx.user.prompt("Run tool then respond.")
      yield* ctx.phase.whenToolRunning("sim_slow")

      // Fire 5 concurrent wakeNoResume calls.
      const results = yield* ctx.phase.concurrentCallers(5, () => ctx.user.wakeNoResume())
      if (results.length !== 5) throw new Error(`expected 5 results, saw ${results.length}`)

      // Settle and verify no extra requests were made (tool turn only).
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      const records = ctx.provider.requests()
      if (records.length !== 2) throw new Error(`expected 2 requests (tool + continuation), saw ${records.length}`)
    }),
  )

  /**
   * Concurrent resumeWithCancel joiners settle despite partial cancellations.
   *
   * Setup: Slow provider reply.
   * Action: Admit with resume:false, fork 4 resumeWithCancel joiners, wait for first byte, interrupt 2.
   * Verify: All 4 joiners started with one drain; 2 cancelled independently; remaining 2 settle.
   */
  simulate("concurrent resumeWithCancel joiners settle despite partial cancellations", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("All joiners settle.", { interEventDelayMs: 30 }))
      yield* ctx.user.prompt("Start work.", { resume: false })

      // Fork 4 resumeWithCancel joiners. Collect first, then fork the awaits from *this* fiber:
      // `Effect.forkChild` attaches to whichever fiber is running, and a fiber spawned by a
      // concurrent `Effect.all` finishes the instant its body returns, taking every child with it.
      const joinDeferreds: { deferred: Deferred.Deferred<void, ResumeError>; fiber: Fiber.Fiber<void, ResumeError> }[] =
        []
      for (let caller = 0; caller < 4; caller++) {
        const deferred = yield* ctx.user.resumeWithCancel()
        const fiber = yield* Effect.forkChild(Deferred.await(deferred))
        joinDeferreds.push({ deferred, fiber })
      }

      // Wait for all 4 to join the same drain (confirmed by first byte in one request).
      yield* ctx.phase.afterFirstByte()

      // Cancel 2 of the 4 joiners' await fibers.
      yield* Fiber.interrupt(joinDeferreds[0]!.fiber)
      yield* Fiber.interrupt(joinDeferreds[1]!.fiber)

      // The remaining 2 should still settle with the drain.
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Verify only 1 provider request (all 4 shared one drain).
      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected 1 shared drain, saw ${ctx.provider.requests().length} requests`)
    }),
  )

  /**
   * A caller that disconnects the instant after it resumes does not lose its input.
   *
   * Setup: one admitted-but-undocked prompt and a reply.
   * Action: Admit with `resume: false`, resume, cancel the join fiber before the first byte.
   * Verify: the drain the caller started is process-owned, so it runs to completion — the input is
   * promoted exactly once and the turn settles idle with nobody listening.
   *
   * (Asserting "no request was made" here would contradict the whole suite: `session.resume` claims
   * under `Effect.uninterruptible` precisely so that a disconnected HTTP client cannot abandon a
   * turn it already paid for. Only `session.interrupt` stops a drain.)
   */
  simulate("disconnect right after resuming does not lose the input", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Delivered to nobody in particular.", { chunks: 3, interEventDelayMs: 20 }))
      const admitted = yield* ctx.user.prompt("Message to persist.", { resume: false })

      // Try to join and immediately cancel.
      const join = yield* ctx.user.resumeWithCancel()
      const joinFiber = yield* Effect.forkChild(Deferred.await(join))
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(joinFiber)

      // The orphaned drain still settles the session (and `settled` phase 3 proves no admitted
      // row was left neither promoted nor cancelled).
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      const inputs = yield* ctx.services.db
        .select({ id: SessionInputTable.id, promoted: SessionInputTable.promoted_seq })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, ctx.sessionID))
        .all()
        .pipe(Effect.orDie)
      if (inputs.length !== 1) throw new Error(`expected 1 admitted input, saw ${inputs.length}`)
      if (inputs[0]!.id !== admitted.id)
        throw new Error(`the drain promoted a different input than the caller admitted`)
      if (inputs[0]!.promoted === null) throw new Error(`the disconnected caller's input was never promoted`)
      if (ctx.provider.requests().length !== 1)
        throw new Error(`expected exactly 1 request, saw ${ctx.provider.requests().length}`)
    }),
  )
})
