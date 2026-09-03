/**
 * End-to-end context-accounting regressions, through the real runner loop.
 *
 * Every scenario here is a distilled production failure: gpt-5.6-luna died with
 * `context_length_exceeded` at ~79k *reported* tokens because shell dumps and stale tool
 * output were priced at their bounded summarization size (~2KB) instead of their wire size
 * (up to 1MB). These tests pin the whole chain — accumulation, gate, compaction cut,
 * overflow recovery, prune — not any single function.
 *
 * Restored after a shared-worktree overwrite; the prune scenario uses distinct tool outputs
 * because dedup (default-on since) would otherwise clear the older copy first.
 */
import { describe } from "bun:test"
import { Effect } from "effect"
import type { LLMRequest } from "@turenlabs/llm"
import { contextOverflow, reply, replyWithTool, requestUserTexts, simulate } from "./harness"

const summarizerRequest = (request: LLMRequest) =>
  requestUserTexts(request).some((text) => text.includes("anchored summary"))
/**
 * The fact-extraction call a successful compaction makes after the summary.
 *
 * A compaction is two provider calls, not one: the summary, then the extraction whose bullets are
 * appended to the checkpoint's durable-fact ledger. Scenarios that script a compaction have to
 * script both, and every turn behaviour has to exclude both or the extraction silently eats the
 * reply meant for the turn that follows it.
 */
const ledgerRequest = (request: LLMRequest) =>
  requestUserTexts(request).some((text) => text.includes("Extract every durable, checkable fact"))
const turnRequest = (request: LLMRequest) => !summarizerRequest(request) && !ledgerRequest(request)
const ledgerReply = () => reply("- the checkpoint carries this fact", { label: "ledger", match: ledgerRequest })

const expectEqual = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected)
    throw new Error(`expected ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const VALID_SUMMARY = `## Objective
- Continue the task

## Important Details
- (none)

## Work State
### Completed
- (none)

### Active
- Continue

### Blocked
- (none)

## Next Move
1. Continue
2. (none)

## Relevant Files
- (none)

## Durable Memories
- (none)`

/** Bytes that overflow the simulator model's window when priced honestly. */
const DUMP_BYTES = 400_000

describe("context accounting end to end", () => {
  // The luna scenario: terminal sqlite dumps accumulate outside any assistant message, then
  // the user prompts again. The old gate priced each dump at ~500 tokens and shipped the
  // request into a provider overflow; the wire-priced gate must compact BEFORE the provider
  // ever sees an oversized request.
  simulate("shell dumps trigger the gate before the provider overflows", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("First reply.", { match: turnRequest }))
      yield* ctx.user.prompt("Start here.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      // Three 400KB dumps ≈ 300k wire tokens against the 200k window, invisible to the old gate.
      for (const index of [1, 2, 3])
        yield* ctx.user.shell(`sqlite3 forge-dev.db 'select * from event' # ${index}`, "x".repeat(DUMP_BYTES))

      ctx.provider.enqueue(
        reply(VALID_SUMMARY, { label: "summarizer", match: summarizerRequest }),
        ledgerReply(),
        reply("Answered after checkpoint.", { label: "continuation", match: turnRequest }),
      )
      yield* ctx.user.prompt("Now answer this.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const records = ctx.provider.requests()
      // The gate must fire before any oversized wire request: the summarizer runs, then the
      // continuation — and no request may carry the raw dumps.
      expectEqual(
        "summarizer ran before the turn",
        records.some((record) => record.label === "summarizer"),
        true,
      )
      const oversized = records.filter((record) => JSON.stringify(record.request.messages).length > DUMP_BYTES)
      expectEqual("no request shipped the raw dumps", oversized.length, 0)
      expectEqual(
        "user got an answer after the checkpoint",
        requestUserTexts(records.at(-1)!.request).some((text) => text.includes("Now answer this.")),
        true,
      )
    }),
  )

  // The recovery half of the luna failure: if the provider still rejects with
  // context_length_exceeded (estimate missed, backend window smaller than cataloged), the
  // runner must compact once and finish the turn — not settle terminally.
  simulate("provider context_length_exceeded recovers and answers", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Warmup reply.", { match: turnRequest }))
      yield* ctx.user.prompt("Warm up.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })

      ctx.provider.enqueue(
        contextOverflow(),
        reply(VALID_SUMMARY, { label: "summarizer", match: summarizerRequest }),
        ledgerReply(),
        reply("Recovered and answered.", { label: "recovered", match: turnRequest }),
      )
      yield* ctx.user.prompt("Trigger the overflow.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })

      const records = ctx.provider.requests()
      expectEqual(
        "summarizer ran after the overflow",
        records.some((record) => record.label === "summarizer"),
        true,
      )
      const finalTexts = requestUserTexts(records.at(-1)!.request)
      expectEqual(
        "rebuilt request carries the checkpoint",
        finalTexts.some((text) => text.includes("<conversation-checkpoint>")),
        true,
      )
      expectEqual(
        "the prompt survived recovery verbatim",
        finalTexts.some((text) => text.includes("Trigger the overflow.")),
        true,
      )
    }),
  )

  // "I assume this won't clear even with a compact": after a checkpoint, the next wire
  // request must actually be small — the dumps cut behind throughSeq, not preserved in a tail.
  simulate("post-compaction requests shrink to the checkpoint, not the dumps", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(reply("Seeded.", { match: turnRequest }))
      yield* ctx.user.prompt("Seed history.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      // Two dumps: one is ~100k wire tokens, under the ~196k gate budget of the simulator
      // model; the pair is what forces the checkpoint this scenario is about.
      yield* ctx.user.shell("sqlite3 forge-dev.db 'select * from session_message'", "y".repeat(DUMP_BYTES))
      yield* ctx.user.shell("sqlite3 forge-dev.db 'select * from event'", "z".repeat(DUMP_BYTES))

      ctx.provider.enqueue(
        reply(VALID_SUMMARY, { label: "summarizer", match: summarizerRequest }),
        ledgerReply(),
        reply("Post-checkpoint answer.", { match: turnRequest }),
      )
      yield* ctx.user.prompt("Continue past the dump.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 3 })

      const last = ctx.provider.requests().at(-1)!
      const wireBytes = JSON.stringify(last.request.messages).length
      if (wireBytes > 100_000)
        throw new Error(`post-compaction request still carries the dump: ${wireBytes} bytes on the wire`)
    }),
  )

  // Prune-by-default: stale tool output sheds without any compaction — the cheap path that
  // keeps full summarization rare. The durable store truncates each preview to roughly 21KB, so
  // twelve are needed to cross the 40k protect window plus the 20k minimum. Distinct source
  // lengths keep their truncation markers distinct, so dedup cannot claim them — this scenario
  // pins prune, not dedup.
  simulate("prune sheds stale tool output without a compaction", (ctx) =>
    Effect.gen(function* () {
      const TOOL_TURNS = 12
      for (let turn = 1; turn <= TOOL_TURNS; turn++)
        ctx.provider.enqueue(
          replyWithTool("sim_huge", { bytes: 44_000 + turn }, { match: turnRequest }),
          reply(`Tool turn ${turn} done.`, { match: turnRequest }),
        )
      ctx.provider.enqueue(
        reply("Seventh turn.", { match: turnRequest }),
        reply("Eighth turn.", { match: turnRequest }),
      )
      for (let turn = 1; turn <= TOOL_TURNS; turn++) {
        yield* ctx.user.prompt(`Produce big tool result ${turn}.`)
        yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: turn * 2 })
      }
      yield* ctx.user.prompt("Next.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: TOOL_TURNS * 2 + 1 })
      yield* ctx.user.prompt("And again.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: TOOL_TURNS * 2 + 2 })

      const records = ctx.provider.requests()
      expectEqual(
        "no compaction happened",
        records.some((record) => summarizerRequest(record.request)),
        false,
      )
      const finalMessages = JSON.stringify(records.at(-1)!.request.messages)
      expectEqual(
        "sentinel replaced the stale output",
        finalMessages.includes("[Old tool result content cleared]"),
        true,
      )
      // The shed is real: the protect window keeps roughly the newest three previews, so the
      // final request must be materially smaller than all six.
      const lastBytes = finalMessages.length
      if (lastBytes > 200_000)
        throw new Error(`prune left the stale previews on the wire: ${lastBytes} bytes in the final request`)
    }),
  )
})
