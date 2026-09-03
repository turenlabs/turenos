import { LLMEvent, Model, type LLMRequest } from "@turenlabs/llm"
import { route } from "@turenlabs/llm/protocols/openai-chat"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionCompaction } from "../src/session/compaction"
import { SessionMessage } from "../src/session/message"
import { TextPart } from "../src/session/prompt"
import { SessionSchema } from "../src/session/schema"
import { DateTime, Effect, Semaphore, Stream } from "effect"

const RUNS = 7
const PROVIDER_DELAY_MS = 250
const SUMMARY_FIRST_TOKEN_MS = 25
const LEDGER_FACT = "- packages/core/src/session/compaction.ts owns compaction orchestration"
const created = DateTime.makeUnsafe(0)
const sessionID = SessionSchema.ID.make("ses_compaction_benchmark")
const model = Model.make({
  id: "benchmark-model",
  provider: "benchmark-provider",
  route: route.with({ limits: { context: 200_000, output: 8_192 } }),
})
const modelRef = ModelV2.Ref.make({
  id: ModelV2.ID.make("benchmark-model"),
  providerID: ProviderV2.ID.make("benchmark-provider"),
})
const summary = `## Objective
- Improve compaction latency

## Important Details
- Preserve the durable fact ledger

## Work State
### Completed
- Benchmarked the current path

### Active
- Reduce wall-clock latency

### Blocked
- (none)

## Next Move
1. Verify the optimized path
2. Run correctness tests

## Relevant Files
- packages/core/src/session/compaction.ts

## Durable Memories
- Compaction preserves summary and ledger output`
const entries = [
  {
    seq: 1,
    message: SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_compaction_benchmark_user"),
      type: "user",
      text: "Improve compaction without losing durable facts",
      parts: [
        TextPart.make({ id: "prt_compaction_benchmark_user", text: "Improve compaction without losing durable facts" }),
      ],
      time: { created },
    }),
  },
  {
    seq: 2,
    message: SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_compaction_benchmark_assistant"),
      type: "assistant",
      agent: "build",
      model: modelRef,
      content: [{ type: "text", id: "prt_compaction_benchmark_assistant", text: "Investigated the compaction path" }],
      time: { created },
    }),
  },
]

const benchmark = async (permits: number) => {
  let providerCalls = 0
  let committedLedger: readonly string[] = []
  const semaphore = Semaphore.makeUnsafe(permits)
  const compaction = SessionCompaction.make({
    events: {
      publish: ((definition: { readonly type: string }, data: Record<string, unknown>) =>
        Effect.sync(() => {
          if (definition.type === "session.next.compaction.ended")
            committedLedger = (data["ledger"] as readonly string[] | undefined) ?? []
          return data
        })) as never,
    } as never,
    llm: {
      stream: (request: LLMRequest) => {
        providerCalls++
        const extraction = JSON.stringify(request.messages).includes("Extract every durable, checkable fact")
        const response = extraction
          ? Stream.fromEffect(
              Effect.sleep(`${PROVIDER_DELAY_MS} millis`).pipe(
                Effect.as(LLMEvent.textDelta({ id: "ledger", text: LEDGER_FACT })),
              ),
            )
          : Stream.concat(
              Stream.fromEffect(
                Effect.sleep(`${SUMMARY_FIRST_TOKEN_MS} millis`).pipe(
                  Effect.as(LLMEvent.textDelta({ id: "summary", text: "## Objective\n" })),
                ),
              ),
              Stream.fromEffect(
                Effect.sleep(`${PROVIDER_DELAY_MS - SUMMARY_FIRST_TOKEN_MS} millis`).pipe(
                  Effect.as(LLMEvent.textDelta({ id: "summary", text: summary.slice("## Objective\n".length) })),
                ),
              ),
            )
        return Stream.fromEffect(semaphore.take(1)).pipe(
          Stream.flatMap(() => Stream.concat(response, Stream.fromArray([LLMEvent.finish({ reason: "stop" })]))),
          Stream.ensuring(semaphore.release(1)),
        )
      },
    },
    config: Effect.succeed([]),
  })
  const measure = async () => {
    const calls = providerCalls
    committedLedger = []
    const started = performance.now()
    const outcome = await Effect.runPromise(compaction.compact({ sessionID, entries, model }))
    if (!outcome.ok) throw new Error(`Compaction failed: ${outcome.reason}`)
    if (!committedLedger.includes(LEDGER_FACT)) throw new Error("Compaction did not commit the extracted ledger fact")
    return { elapsed: performance.now() - started, calls: providerCalls - calls }
  }

  await measure()
  const results = [await measure()]
  for (let index = 1; index < RUNS; index++) results.push(await measure())
  if (results.some((result) => result.calls !== 2))
    throw new Error("Compaction did not make exactly two provider calls")
  const elapsed = results.map((result) => result.elapsed).toSorted((left, right) => left - right)
  return {
    median: elapsed[Math.floor(elapsed.length / 2)]!,
    minimum: elapsed[0]!,
    maximum: elapsed.at(-1)!,
  }
}

const serial = await benchmark(1)
const overlapped = await benchmark(2)
const reduction = 1 - overlapped.median / serial.median

console.log(`Compaction latency benchmark (${RUNS} runs, ${PROVIDER_DELAY_MS}ms simulated per provider call)`)
console.log(
  `serial control: ${serial.median.toFixed(1)}ms (${serial.minimum.toFixed(1)}-${serial.maximum.toFixed(1)}ms)`,
)
console.log(
  `overlapped: ${overlapped.median.toFixed(1)}ms (${overlapped.minimum.toFixed(1)}-${overlapped.maximum.toFixed(1)}ms)`,
)
console.log(`latency reduction: ${(reduction * 100).toFixed(1)}%`)
console.log(`speedup: ${(serial.median / overlapped.median).toFixed(2)}x`)
console.log("provider calls: 2 per compaction; ended ledger payload verified")
