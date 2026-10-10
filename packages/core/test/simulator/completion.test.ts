import { expect } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@turenlabs/core/event"
import { SessionEvent } from "@turenlabs/schema/session-event"
import { LLMError, LLMEvent, RateLimitReason } from "@turenlabs/llm"
import { reply, replyWithTool, simulate, transportError } from "./harness"

const observe = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const outcomes: unknown[] = []
  const unsubscribe = yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type === SessionEvent.ExecutionSettled.type) outcomes.push(event.data)
    }),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  return outcomes
})

simulate("completion observes the whole execution including queued stop turns and coalesced wakes", (ctx) =>
  Effect.gen(function* () {
    const outcomes = yield* observe
    ctx.provider.enqueue(
      reply("Intermediate stop.", { chunks: 6, interEventDelayMs: 30 }),
      reply("Finished queue.", { chunks: 6, interEventDelayMs: 30 }),
    )
    yield* ctx.user.prompt("Start work.")
    yield* ctx.phase.afterFirstByte()
    yield* ctx.user.prompt("Continue after this response.", { delivery: "queue" })
    yield* ctx.phase.afterFirstByte(1)
    expect(outcomes).toEqual([])
    yield* ctx.user.wakeNoResume()
    yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
    expect(outcomes).toEqual([{ sessionID: ctx.sessionID, outcome: "success" }])
    yield* ctx.services.session.resumePending(ctx.sessionID)
    expect(outcomes).toHaveLength(1)
    // A later prompt is a new execution, even though the Session ID is unchanged.
    ctx.provider.enqueue(reply("Second execution."))
    yield* ctx.user.prompt("New work.")
    yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })
    expect(outcomes).toEqual([
      { sessionID: ctx.sessionID, outcome: "success" },
      { sessionID: ctx.sessionID, outcome: "success" },
    ])
  }),
)

simulate("tool-call turns publish only the final execution completion", (ctx) =>
  Effect.gen(function* () {
    const outcomes = yield* observe
    ctx.provider.enqueue(
      replyWithTool("sim_slow", { ms: 0 }),
      reply("After tools.", { chunks: 6, interEventDelayMs: 30 }),
    )
    yield* ctx.user.prompt("Use a tool.")
    yield* ctx.phase.afterFirstByte(1)
    expect(outcomes).toEqual([])
    yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
    expect(outcomes).toEqual([{ sessionID: ctx.sessionID, outcome: "success" }])
  }),
)

simulate("recovered provider retry publishes success, not intermediate failure", (ctx) =>
  Effect.gen(function* () {
    const outcomes = yield* observe
    ctx.provider.retrySequence(
      [
        new LLMError({
          module: "simulator",
          method: "stream",
          reason: new RateLimitReason({ message: "retry", retryAfterMs: 0 }),
        }),
      ],
      reply("Recovered.", { chunks: 6, interEventDelayMs: 30 }),
    )
    yield* ctx.user.prompt("Retry safely.")
    yield* ctx.phase.afterFirstByte(1)
    expect(outcomes).toEqual([])
    yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
    expect(outcomes).toEqual([{ sessionID: ctx.sessionID, outcome: "success" }])
  }),
)

for (const framed of [false, true]) {
  simulate(`terminal ${framed ? "provider frame" : "transport error"} publishes failure once`, (ctx) =>
    Effect.gen(function* () {
      const outcomes = yield* observe
      ctx.provider.enqueue(
        framed
          ? {
              label: "terminal-frame",
              events: [LLMEvent.providerError({ message: "Terminal rejection", retryable: false })],
            }
          : {
              label: "terminal-transport",
              events: [],
              failAfter: { count: 0, error: transportError() },
            },
      )
      yield* ctx.user.prompt("Fail terminally.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "failed", minRequests: 1 })
      expect(outcomes).toEqual([{ sessionID: ctx.sessionID, outcome: "failure" }])
      yield* ctx.services.session.resumePending(ctx.sessionID)
      expect(outcomes).toHaveLength(1)
    }),
  )
}

simulate("interruption emits neither success nor failure completion", (ctx) =>
  Effect.gen(function* () {
    const outcomes = yield* observe
    ctx.provider.enqueue(reply("Interrupted.", { stallAfter: { count: 3 } }))
    yield* ctx.user.prompt("Stay active.")
    yield* ctx.phase.afterFirstByte()
    yield* ctx.user.interrupt()
    yield* ctx.invariants.settled(ctx.sessionID, { expect: "interrupted", minRequests: 1 })
    expect(outcomes).toEqual([])
  }),
)
