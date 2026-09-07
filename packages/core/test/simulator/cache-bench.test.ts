/**
 * Prompt-cache benchmark. Runs scripted sessions through the real runner with
 * a cache-emulating mock provider (`./cache-emulator`) that compiles every
 * request through the real `applyCachePolicy` + protocol body builder and
 * attaches emulated Anthropic/OpenAI `Usage` to each `step-finish` — so the
 * real usage pipeline (publisher -> projector -> usage tables) is exercised.
 *
 * Run: bun test test/simulator/cache-bench.test.ts
 *
 * Metrics per scenario x provider (turn requests only; summarizer tracked separately):
 *   hitP50/hitP99 — cache-read / input-token ratio percentiles
 *   billedP50/billedP99 — modeled billed kilotokens per request (rate multipliers applied)
 *   maxReqKTok — largest single request in kilotokens (overflow proximity)
 *   compact — LLM compactions triggered (cache invalidations)
 *
 * Absolute numbers are MODELED (bytes/4 tokenizer, approximated rate tables
 * and minimums — see cache-emulator.ts). Variant deltas and distribution
 * shapes are the decision signal, not CI thresholds.
 */
import { afterAll, describe } from "bun:test"
import { Duration, Effect } from "effect"
import type { LLMRequest } from "@turenlabs/llm"
import { SessionGoal } from "@turenlabs/core/session/goal"
import { makeCacheEmulator, quantile, type CacheProviderKind, type UsageEmulator } from "./cache-emulator"
import { reply, replyWithTool, requestUserTexts, simulate, type ScenarioContext } from "./harness"

const summarizerRequest = (request: LLMRequest) =>
  requestUserTexts(request).some((text) => text.includes("anchored summary"))
const ledgerRequest = (request: LLMRequest) => request.system.some((part) => part.text.includes("fact extractor"))
const turnRequest = (request: LLMRequest) => !summarizerRequest(request) && !ledgerRequest(request)

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

const PROVIDERS: ReadonlyArray<CacheProviderKind> = ["anthropic", "openai"]

interface Scenario {
  readonly name: string
  readonly turns: number
  readonly arm: (ctx: ScenarioContext, turn: number) => void
  readonly modelContextLimit?: { context?: number; output?: number }
  readonly summarizers?: number
  /** Extra turn behaviors: each compaction restarts its turn as a new request. */
  readonly extraTurns?: number
  /** Expect a warm cache: some post-first turn request must show cache reads. */
  readonly expectWarmCache?: boolean
  readonly compaction?: { auto?: boolean }
  /** Goal-loop scenario: one kickoff turn, then continuation drains with no new input. */
  readonly goal?: { objective: string; continuations: number }
  readonly retainedText?: string
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    // Chat-heavy control: static prefix + growing prose. Both providers should
    // show high hit ratios after the first turn.
    name: "chat",
    turns: 8,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(reply(`Answer ${turn}. ${"prose reply segment. ".repeat(400)}`, { match: turnRequest })),
    expectWarmCache: true,
  },
  {
    // Growing unique tool-output tail: the rolling breakpoint advances every
    // turn, so part of each request is always fresh.
    name: "tool-growth",
    turns: 10,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(
        replyWithTool("sim_huge", { bytes: 40_000 + turn * 17 }, { match: turnRequest }),
        reply(`Read ${turn} digested.`, { match: turnRequest }),
      ),
    expectWarmCache: true,
  },
  {
    // Byte-identical re-reads: dedup transitions clear old copies once, then
    // the prefix stabilizes. Measures post-transition steady state.
    name: "reread",
    turns: 10,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(
        replyWithTool("sim_huge", { bytes: 40_000 }, { match: turnRequest }),
        reply(`Read ${turn} digested.`, { match: turnRequest }),
      ),
    expectWarmCache: true,
  },
  {
    // Forces auto compaction on a small window: each compaction is a full
    // cache invalidation. Measures invalidation cost, not steady state.
    name: "compact",
    turns: 8,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(
        replyWithTool("sim_huge", { bytes: 40_000 + turn * 17 }, { match: turnRequest }),
        reply(`Read ${turn} digested.`, { match: turnRequest }),
      ),
    modelContextLimit: { context: 60_000 },
    summarizers: 3,
    extraTurns: 4,
  },
  {
    // Sustained prune pressure without compaction: sim_big outputs pass the
    // durable cap whole (~56KB each), so occupancy crosses the 75% prune gate
    // around turn 11 and every new reduction breaks the prefix mid-history.
    // Measures prune-churn cost in isolation.
    name: "pressure",
    turns: 14,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(
        replyWithTool("sim_big", { bytes: 56_000 + turn * 17 }, { match: turnRequest }),
        reply(`Read ${turn} digested.`, { match: turnRequest }),
      ),
    compaction: { auto: false },
    expectWarmCache: true,
  },
  {
    // Active-goal loop: continuation drains append a fresh goal note every
    // turn with no new user input. Prior-turn notes persist inside the frame,
    // so overlay count should grow ~1/turn — pure denominator bloat.
    name: "goal",
    turns: 6,
    arm: () => {},
    goal: {
      objective: "Migrate the remaining call sites to the new API and verify with the full test suite.",
      continuations: 6,
    },
    retainedText: "CACHE-goal-0",
    expectWarmCache: true,
  },
]

type Row = {
  scenario: string
  provider: CacheProviderKind
  requests: number
  hitP50: number
  hitP99: number
  billedP50k: number
  billedP99k: number
  maxReqKTok: number
  compact: number
  summaryKTok: number
  toolsKTok: number
  extPct: number
  breaks: string
  avgBp: number
  overlays: number
  ovGrowth: number
  retained: boolean
}
const rows: Row[] = []
const violations: string[] = []

const percent = (ratio: number) => Math.round(ratio * 1000) / 10
const kTok = (tokens: number) => Math.round(tokens / 100) / 10

/**
 * Goal-loop driver: one kickoff turn, then an active goal whose continuation
 * drains run with no new input until the script completes the goal. The loop
 * length is demand-driven (poll, then complete), so extra replies are armed
 * generously and the exact request count is allowed to float.
 */
const runGoalLoop = Effect.fn("cacheBench.goalLoop")(function* (
  ctx: ScenarioContext,
  goal: NonNullable<Scenario["goal"]>,
) {
  ctx.provider.enqueue(reply("Kickoff acknowledged.", { match: turnRequest }))
  yield* ctx.user.prompt("CACHE-goal-0: start the work.")
  yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
  yield* ctx.services.goals.create({
    sessionID: ctx.sessionID,
    objective: SessionGoal.Objective.make(goal.objective),
  })
  for (let i = 0; i < goal.continuations + 6; i++)
    ctx.provider.enqueue(reply(`Goal progress ${i}. ${"work segment. ".repeat(200)}`, { match: turnRequest }))
  yield* ctx.user.resume()
  const want = 1 + goal.continuations
  const deadline = Date.now() + 20_000
  while (ctx.provider.requests().length < want) {
    if (Date.now() > deadline)
      return yield* Effect.die(`goal loop stalled at ${ctx.provider.requests().length}/${want} requests`)
    yield* Effect.sleep(Duration.millis(50))
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = yield* ctx.services.goals.get(ctx.sessionID)
    if (current?.status !== "active") break
    const done = yield* ctx.services.goals
      .status({ sessionID: ctx.sessionID, goalID: current.id, expectedRevision: current.revision, status: "complete" })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
    if (done) break
  }
  yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: want })
})

const measure = (
  scenario: Scenario,
  provider: CacheProviderKind,
  emulator: UsageEmulator,
  ctx: ScenarioContext,
  finalInstruction: string,
) => {
  const records = emulator.records()
  const turns = records.filter((record) => record.conversation === "turn")
  const overhead = records.filter((record) => record.conversation !== "turn")
  const compactions = records.filter((record) => record.conversation === "summary").length
  for (const record of records) {
    if (record.input < 0 || record.cacheRead < 0 || record.cacheWrite < 0 || record.output < 0)
      violations.push(`${scenario.name}/${provider}: negative usage field`)
    if (record.cacheRead + record.cacheWrite > record.input)
      violations.push(`${scenario.name}/${provider}: cache exceeds input`)
  }
  if (scenario.expectWarmCache && !turns.slice(1).some((record) => record.cacheRead > 0))
    violations.push(`${scenario.name}/${provider}: warm cache expected but no request showed cache reads`)
  if (process.env.BENCH_TRACE) {
    console.log(
      `[trace] ${scenario.name}/${provider} inputs(kTok):`,
      turns.map((record) => kTok(record.input)).join(","),
    )
    const lastRequest = ctx.provider.requests().at(-1)?.request
    const toolSizes: number[] = []
    for (const message of lastRequest?.messages ?? [])
      for (const part of message.content) {
        if (part.type !== "tool-result") continue
        const value = part.result.value
        toolSizes.push(typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0))
      }
    console.log(
      `[trace] ${scenario.name}/${provider} last-request tool-result sizes:`,
      toolSizes.map((size) => `${Math.round(size / 1024)}KB`).join(","),
    )
    const firstTool = (() => {
      for (const message of lastRequest?.messages ?? [])
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          const value = part.result.value
          return typeof value === "string" ? value : JSON.stringify(value)
        }
      return ""
    })()
    console.log(
      `[trace] ${scenario.name}/${provider} sample tool-result len=${firstTool.length} head=${JSON.stringify(firstTool.slice(0, 120))} tail=${JSON.stringify(firstTool.slice(-160))}`,
    )
  }
  const hits = turns.map((record) => record.hitRatio)
  const billed = turns.map((record) => record.billed)
  const causes = new Map<string, number>()
  for (const record of turns) {
    if (record.breakCause === "extension") continue
    causes.set(record.breakCause, (causes.get(record.breakCause) ?? 0) + 1)
  }
  const extensions = turns.filter((record) => record.extension).length
  rows.push({
    scenario: scenario.name,
    provider,
    requests: turns.length,
    hitP50: percent(quantile(hits, 0.5)),
    hitP99: percent(quantile(hits, 0.99)),
    billedP50k: kTok(quantile(billed, 0.5)),
    billedP99k: kTok(quantile(billed, 0.99)),
    maxReqKTok: kTok(turns.reduce((max, record) => Math.max(max, record.input + record.output), 0)),
    compact: compactions,
    summaryKTok: kTok(overhead.reduce((total, record) => total + record.input + record.output, 0)),
    toolsKTok: kTok(turns.at(-1)?.toolsTokens ?? 0),
    extPct: turns.length === 0 ? 0 : Math.round((extensions / turns.length) * 100),
    breaks: [...causes].map(([cause, count]) => `${cause}x${count}`).join(",") || "-",
    avgBp:
      turns.length === 0
        ? 0
        : Math.round((turns.reduce((total, record) => total + record.breakpoints, 0) / turns.length) * 10) / 10,
    overlays: turns.at(-1)?.overlays ?? 0,
    ovGrowth: (turns.at(-1)?.overlays ?? 0) - (turns.at(0)?.overlays ?? 0),
    retained: requestUserTexts(ctx.provider.requests().at(-1)!.request).some((text) => text.includes(finalInstruction)),
  })
}

describe("prompt-cache benchmark", () => {
  for (const provider of PROVIDERS)
    for (const scenario of SCENARIOS) {
      const emulator = makeCacheEmulator(provider)
      simulate(
        `cache ${scenario.name} [${provider}]`,
        (ctx) =>
          Effect.gen(function* () {
            for (let i = 0; i < (scenario.summarizers ?? 1); i++) {
              ctx.provider.enqueue(reply(VALID_SUMMARY, { label: "summarizer", match: summarizerRequest }))
              // Ledger extraction carries no "anchored summary" marker, so without
              // its own behavior it steals a turn reply and pollutes the chain.
              ctx.provider.enqueue(
                reply("- bench fact one\n- bench fact two", { label: "ledger", match: ledgerRequest }),
              )
            }
            if (scenario.goal) {
              yield* runGoalLoop(ctx, scenario.goal)
            } else {
              for (let turn = 1; turn <= scenario.turns + (scenario.extraTurns ?? 0); turn++) scenario.arm(ctx, turn)
              for (let turn = 1; turn <= scenario.turns; turn++) {
                yield* ctx.user.prompt(`CACHE-${scenario.name}-${turn}: continue.`)
                yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: turn })
              }
            }
            // End-to-end proof the emulated usage flowed through the real
            // publisher -> projector path onto the durable transcript.
            const last = (yield* ctx.services.store.context(ctx.sessionID)).findLast(
              (message) => message.type === "assistant",
            )
            if (
              last?.type !== "assistant" ||
              last.tokens === undefined ||
              last.tokens.input + last.tokens.cache.read + last.tokens.cache.write <= 0
            )
              violations.push(`${scenario.name}/${provider}: emulated usage missing from durable transcript`)
            measure(
              scenario,
              provider,
              emulator,
              ctx,
              scenario.retainedText ?? `CACHE-${scenario.name}-${scenario.turns}`,
            )
          }),
        {
          usageEmulator: emulator,
          modelContextLimit: scenario.modelContextLimit,
          ...(scenario.compaction === undefined ? {} : { compaction: scenario.compaction }),
        },
      )
    }

  afterAll(() => {
    for (const provider of PROVIDERS) {
      console.log(`cache-bench [${provider}]`)
      console.table(rows.filter((row) => row.provider === provider))
    }
    const broken = rows.filter((row) => !row.retained)
    if (broken.length > 0)
      violations.push(`retention violated: ${broken.map((row) => `${row.scenario}/${row.provider}`).join(", ")}`)
    if (violations.length > 0) throw new Error(`cache-bench violations:\n${violations.join("\n")}`)
  })
})
