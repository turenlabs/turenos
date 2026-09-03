/**
 * Context-efficiency benchmark. Not a correctness suite: it runs scripted sessions through the
 * real runner (gate, prune, dedup, compaction, wire assembly) per variant, prints a comparison
 * table, and asserts only sanity invariants — sessions settle and the newest instruction is
 * still reachable in the final request. Numbers drive A/B decisions, not CI thresholds.
 *
 * Run: bun test test/simulator/context-bench.test.ts
 *
 * Metrics per scenario × variant:
 *   wireKB   — cumulative serialized bytes of every provider request (window pressure)
 *   billed   — modeled billed kilotokens: chars/4, longest-common-prefix with the previous
 *              request read at 0.1x (cache read), divergent suffix at 1.25x (cache write).
 *              Charges a technique for the cache breaks it causes, not just bytes saved.
 *   maxReqKB — largest single request (overflow proximity)
 *   compact  — LLM compactions triggered (summarizer requests observed)
 *   retained — newest user instruction present verbatim in the final request
 *
 * Verdict history (keep updated so nobody re-proposes a rejected idea blind):
 *   soft-elide (middle-elide in-window outputs): REJECTED — −8% wire, +4.5% billed; the
 *   elide→sentinel double transition broke the cache prefix twice per message.
 *   early-ckpt (proactive compaction at ~55% occupancy via buffer 90k): REJECTED — inert at
 *   realistic sizes (the gate never fired below its budget), and when it would fire, a
 *   compaction is a full cache invalidation, so firing earlier than pressure demands costs
 *   billed tokens rather than saving them (same economics that killed soft-elide).
 *   dedup (older byte-identical results cleared): ADOPTED as default — −53% wire, −23%
 *   billed, −33% peak on re-read-heavy; exactly neutral elsewhere.
 *   input-prune (stale write/edit/patch bodies cleared, exemption-only): ADOPTED as default —
 *   −64% wire and −72% peak request on edit-heavy (40KB bodies) for +3.4% modeled billed;
 *   cleared bodies are on disk and in the edit's structured diff. Protect-window gating was
 *   tried during restoration and REJECTED at +38% billed: deep-prefix clearings re-bill the
 *   whole suffix, while exemption-only transitions each body once, near the tail.
 *   media-prune (stale pasted screenshots cleared, wire-priced protect budget): ADOPTED as
 *   default — −64% wire, −73% peak request (1051KB→286KB) on screenshot-heavy. The modeled
 *   +28% billed charges image bytes at text rates, which providers do not; the peak-request
 *   reduction is the Luna-class overflow guard this exists for. Cleared images become named
 *   notes so the model can ask for a re-attach.
 */
import { afterAll, describe } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { LLMRequest } from "@turenlabs/llm"
import { reply, replyWithTool, requestUserTexts, simulate, type ScenarioContext, type SimulateOptions } from "./harness"

const summarizerRequest = (request: LLMRequest) =>
  requestUserTexts(request).some((text) => text.includes("anchored summary"))
const turnRequest = (request: LLMRequest) => !summarizerRequest(request)

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

type Row = {
  scenario: string
  variant: string
  wireKB: number
  billedKTok: number
  maxReqKB: number
  compact: number
  retained: boolean
}
const rows: Row[] = []

const lcp = (a: string, b: string) => {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

const VARIANTS: ReadonlyArray<{ name: string; override: NonNullable<SimulateOptions["compaction"]> }> = [
  // The counterfactual column: baseline is the shipped default (dedup on).
  { name: "no-dedup", override: { dedupOutputs: false } },
  { name: "no-input-prune", override: { pruneInputs: false } },
  { name: "no-media-prune", override: { pruneMedia: false } },
  { name: "baseline", override: {} },
]

/**
 * A real PNG from the repo's own assets: `materialize` omits undecodable images entirely
 * (`Image.DecodeError` degrades to a note), so synthetic base64 never reaches the wire and
 * would silently benchmark nothing.
 */
const SCREENSHOT_BASE64 = readFileSync(
  path.join(import.meta.dir, "../../../ui/src/assets/brand/forge-compact-lockup.png"),
).toString("base64")
const screenshot = (name: string) => ({
  uri: `data:image/png;base64,${SCREENSHOT_BASE64}`,
  mime: "image/png",
  name,
})

interface Scenario {
  readonly name: string
  readonly turns: number
  /** Enqueues the provider behaviors for one turn. */
  readonly arm: (ctx: ScenarioContext, turn: number) => void
  /** Options for the turn's prompt (screenshot attachments and the like). */
  readonly promptOptions?: (turn: number) => { readonly files?: ReturnType<typeof screenshot>[] } | undefined
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    // 14 reads, 10 of them byte-identical (the same file re-read across the session). sim_huge
    // output is deterministic in `bytes`, so equal sizes are identical content. Sized so the
    // early-ckpt gate (budget 110k tokens at buffer 90k) genuinely fires near the end while
    // the baseline gate (196k) does not — a smaller scenario makes early-ckpt trivially inert.
    name: "re-read-heavy",
    turns: 14,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(
        replyWithTool("sim_huge", { bytes: turn <= 10 ? 40_000 : 40_000 + turn }, { match: turnRequest }),
        reply(`Read ${turn} digested.`, { match: turnRequest }),
      ),
  },
  {
    // Same shape, all outputs unique. Dedup must be exactly neutral here — any delta is a
    // false positive clearing unique content.
    name: "distinct-reads",
    turns: 10,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(
        replyWithTool("sim_huge", { bytes: 40_000 + turn * 17 }, { match: turnRequest }),
        reply(`Read ${turn} digested.`, { match: turnRequest }),
      ),
  },
  {
    // Chat-heavy control: no tool output at all. Both experiments must be inert.
    name: "chat-control",
    turns: 8,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(reply(`Answer ${turn}. ${"prose reply segment. ".repeat(400)}`, { match: turnRequest })),
  },
  {
    // 12 write-style turns, ~40KB call input apiece: the input-replay blind spot. Outputs tiny,
    // so output pruning and dedup are inert here by construction. Bodies at the 8KB scale sit
    // inside the 40k-token protect window for a dozen turns — recent context is protected by
    // design, so small edit sessions are deliberately untouched; this models a heavy one.
    name: "edit-heavy",
    turns: 12,
    arm: (ctx, turn) =>
      ctx.provider.enqueue(
        replyWithTool("sim_huge", { bytes: 200 + turn, padding: `p${turn}-`.repeat(10_000) }, { match: turnRequest }),
        reply(`Edited file ${turn}.`, { match: turnRequest }),
      ),
  },
  {
    // 10 turns, a fresh screenshot pasted on 8 of them. Every historical image replays its
    // full base64 on every later turn unless media pruning sheds it.
    name: "screenshot-heavy",
    turns: 10,
    arm: (ctx, turn) => ctx.provider.enqueue(reply(`Looked at screenshot ${turn}.`, { match: turnRequest })),
    promptOptions: (turn) => (turn <= 8 ? { files: [screenshot(`shot-${turn}.png`)] } : undefined),
  },
]

const measure = (scenario: string, variant: string, ctx: ScenarioContext, finalInstruction: string) => {
  const records = ctx.provider.requests()
  const bodies = records.map((record) =>
    JSON.stringify({ system: record.request.system, messages: record.request.messages, tools: record.request.tools }),
  )
  let billedChars = 0
  for (let i = 0; i < bodies.length; i++) {
    const prefix = i === 0 ? 0 : lcp(bodies[i]!, bodies[i - 1]!)
    billedChars += prefix * 0.1 + (bodies[i]!.length - prefix) * 1.25
  }
  if (process.env.BENCH_TRACE)
    console.log(
      `[trace] ${scenario}/${variant}:`,
      records.map((record, i) => `${record.label ?? "?"}=${Math.round(bodies[i]!.length / 1024)}KB`).join(" "),
    )
  rows.push({
    scenario,
    variant,
    wireKB: Math.round(bodies.reduce((total, body) => total + body.length, 0) / 1024),
    billedKTok: Math.round(billedChars / 4 / 100) / 10,
    maxReqKB: Math.round(Math.max(...bodies.map((body) => body.length)) / 1024),
    compact: records.filter((record) => summarizerRequest(record.request)).length,
    retained: requestUserTexts(records.at(-1)!.request).some((text) => text.includes(finalInstruction)),
  })
}

describe("context-efficiency benchmark", () => {
  for (const variant of VARIANTS)
    for (const scenario of SCENARIOS)
      simulate(
        `bench ${scenario.name} [${variant.name}]`,
        (ctx) =>
          Effect.gen(function* () {
            ctx.provider.enqueue(reply(VALID_SUMMARY, { label: "summarizer", match: summarizerRequest }))
            for (let turn = 1; turn <= scenario.turns; turn++) scenario.arm(ctx, turn)
            for (let turn = 1; turn <= scenario.turns; turn++) {
              yield* ctx.user.prompt(`BENCH-${scenario.name}-${turn}: continue.`, scenario.promptOptions?.(turn))
              yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: turn })
            }
            measure(scenario.name, variant.name, ctx, `BENCH-${scenario.name}-${scenario.turns}`)
          }),
        { compaction: variant.override },
      )

  afterAll(() => {
    for (const scenario of SCENARIOS) console.table(rows.filter((row) => row.scenario === scenario.name))
    const broken = rows.filter((row) => !row.retained)
    if (broken.length > 0)
      throw new Error(`retention violated: ${broken.map((row) => `${row.scenario}/${row.variant}`).join(", ")}`)
  })
})
