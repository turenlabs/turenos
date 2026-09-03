/**
 * A/B experiment: compaction strategies over real production sessions. EXPERIMENT ONLY.
 *
 *   bun packages/core/test/simulator/experiments/compaction-ab/run.ts [--sessions a,b] [--gens 9]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { fitPrompt } from "../../../../src/session/compaction"
import { Token } from "../../../../src/util/token"
import {
  buildPrompt,
  complete,
  extractFacts,
  factCount,
  items,
  llmStats,
  load,
  pool,
  recall,
  serializeElided,
  serializeMessage,
  splitIndex,
  validSummary,
  wireTokens,
  SCRATCH,
  type Entry,
  type Facts,
  type Msg,
} from "./lib"

/** Simulated model: 64k context, 20k buffer -> the gate fires at 44k occupied wire tokens. */
const CONTEXT = 64_000
const BUFFER = 20_000
const THRESHOLD = CONTEXT - BUFFER
const SUMMARY_OUTPUT = 4_096
const MARGIN = 256
const PROMPT_CHARS = (CONTEXT - SUMMARY_OUTPUT - MARGIN) * 4
const KEEP_TOKENS = 8_000
const KEEP_TURNS = 2
const TAIL_HEAVY_TOKENS = 32_000
const TAIL_HEAVY_TURNS = 8
const LEDGER_MAX_CHARS = 24_000

const SYSTEM =
  'You are a transcript summarizer, not an assistant. You never converse, never use tools, never comment. Your entire output is the requested Markdown document and nothing else. The first line of your output MUST be exactly "## Objective". Never write a preamble, a sign-off, or any text outside the template.'
const LEDGER_SYSTEM =
  "You are a fact extractor, not an assistant. You never converse, never use tools, never comment. Your entire output is a flat bullet list, one fact per line starting with '- '. The first character of your output MUST be '-'. No headings, no preamble, no prose."
const LEDGER_PROMPT = `Extract every durable, checkable fact from the transcript below. Include, verbatim and exactly as written:
- absolute and relative file paths that were read, written, or discussed
- exact error strings and failing commands
- explicit user instructions, decisions, constraints and preferences
- identifiers: function names, symbol names, session/task/message ids, config keys

One fact per line, prefixed with "- ". Preserve exact spelling of paths, symbols and identifiers. At most 60 lines. No duplicates. No prose.

<transcript>
`

const SESSIONS = [
  "ses_0556315fcffeHvjtgPFxsBHx0o",
  "ses_049daee7dffeJTiQoU6MdKewtB",
  "ses_050b609adffezXIJGkMV4KeSDM",
  "ses_03f74452cffduLwSn4VRoNaG1L",
  "ses_041679e13ffdiPterDp0sHrwF5",
  "ses_04797a900ffe9w2drITJ0OtdBi",
  "ses_050344a2cffe66piKLHcymP9sn",
  "ses_05108d761ffe56ZB8U33Zwpja5",
]

const argOf = (name: string) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`))
  return found?.slice(name.length + 3)
}
const MAX_GEN = Number(argOf("gens") ?? 9)
const targets = (argOf("sessions") ?? SESSIONS.join(",")).split(",")

type Strategy = "A-baseline" | "B-noncompounding" | "C-ledger" | "D-tailheavy" | "E-toolelided"
const STRATEGIES: Strategy[] = ["A-baseline", "B-noncompounding", "C-ledger", "D-tailheavy", "E-toolelided"]

type Sample = {
  session: string
  strategy: Strategy
  generation: number
  contextTokens: number
  stateTokens: number
  tailTokens: number
  durableBytes: number
  cumulativeDurableBytes: number
  promptTokens: number
  recallAll: number
  recallAged: number
  recallGen1: number
  stateRecallAll: number
  stateRecallAged: number
  stateRecallGen1: number
  recallInstructions: number
  factsAll: number
  factsAged: number
  factsGen1: number
  valid: boolean
  wallMs: number
  degenerate: boolean
  forcedByCurrentTurn: number
}

const boundaries = (entries: readonly Entry[], max: number) => {
  const result: number[] = []
  let total = 0
  let next = THRESHOLD
  for (let index = 0; index < entries.length; index++) {
    total += wireTokens(entries[index]!.message)
    if (total >= next) {
      result.push(index + 1)
      next += THRESHOLD
      if (result.length >= max) break
    }
  }
  return result
}

const tailTokensOf = (entries: readonly Entry[], from: number, to: number, elided: boolean) =>
  entries
    .slice(from, to)
    .reduce(
      (sum, entry) => sum + (elided ? Token.estimate(serializeElided(entry.message)) : wireTokens(entry.message)),
      0,
    )

const tailTextOf = (entries: readonly Entry[], from: number, to: number, serializer: (m: Msg) => string) =>
  entries
    .slice(from, to)
    .map((entry) => serializer(entry.message))
    .filter(Boolean)
    .join("\n\n")

const runStrategy = async (
  session: string,
  strategy: Strategy,
  entries: readonly Entry[],
  marks: readonly number[],
  facts: { all: Facts[]; aged: Facts[]; gen1: Facts },
) => {
  const samples: Sample[] = []
  const serializer = strategy === "E-toolelided" ? serializeElided : serializeMessage
  const keep =
    strategy === "D-tailheavy"
      ? { tokens: TAIL_HEAVY_TOKENS, turns: TAIL_HEAVY_TURNS }
      : { tokens: KEEP_TOKENS, turns: KEEP_TURNS }
  let summary: string | undefined
  let ledger: string[] = []
  let tailStartIdx = 0
  let cumulative = 0

  for (let generation = 1; generation <= marks.length; generation++) {
    const started = Date.now()
    const cut = marks[generation - 1]!
    const windowStart = strategy === "B-noncompounding" ? 0 : tailStartIdx
    const window = entries.slice(windowStart, cut)
    const list = items(window, serializer)
    if (list.length === 0) break
    const { split, degenerate, forcedByCurrentTurn } = splitIndex(list, keep)
    const head = list
      .slice(0, split)
      .map((item) => item.text)
      .join("\n\n")
    if (!head) break
    const nextTailStart = windowStart + (list[split]?.index ?? window.length)

    let state: string
    let prompt: string
    if (strategy === "C-ledger") {
      const fittedLedger = fitPrompt(
        { previousSummary: undefined, priorRecent: undefined, head },
        PROMPT_CHARS - LEDGER_PROMPT.length - 40,
      )
      // `fitPrompt` wraps in the summary template; for the ledger we want the raw head only.
      const ledgerHead = fittedLedger.elided
        ? fittedLedger.prompt.slice(-Math.min(PROMPT_CHARS, fittedLedger.prompt.length))
        : head
      const extractPrompt = `${LEDGER_PROMPT}${ledgerHead}\n</transcript>`
      const summarizePrompt = fitPrompt(
        { previousSummary: undefined, priorRecent: undefined, head },
        PROMPT_CHARS,
      ).prompt
      prompt = summarizePrompt
      const [added, segment] = await Promise.all([
        complete(LEDGER_SYSTEM, extractPrompt),
        complete(SYSTEM, summarizePrompt),
      ])
      summary = segment
      const lines = added
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- ") && line.length > 6)
      for (const line of lines) if (!ledger.includes(line)) ledger.push(line)
      // Append-only within a bounded window: oldest entries are evicted, never rewritten.
      while (ledger.join("\n").length > LEDGER_MAX_CHARS) ledger.shift()
      state = `## Anchored ledger (append-only)\n${ledger.join("\n")}\n\n## Newest segment\n${segment}`
    } else {
      const fitted = fitPrompt(
        {
          previousSummary: strategy === "B-noncompounding" ? undefined : summary,
          priorRecent: undefined,
          head,
        },
        PROMPT_CHARS,
      )
      prompt = fitted.prompt
      summary = await complete(SYSTEM, prompt)
      state = summary
    }

    const tailText = tailTextOf(entries, nextTailStart, cut, serializer)
    const context = `${state}\n\n${tailText}`
    const stateTokens = Token.estimate(state)
    const tailTokens = tailTokensOf(entries, nextTailStart, cut, strategy === "E-toolelided")
    mkdirSync(`${SCRATCH}/results/states`, { recursive: true })
    writeFileSync(`${SCRATCH}/results/states/${session}.${strategy}.g${generation}.md`, state)
    const durableBytes = Buffer.byteLength(state)
    cumulative += durableBytes
    const all = recall(facts.all[generation - 1]!, context)
    const aged = recall(facts.aged[generation - 1]!, context)
    const gen1 = recall(facts.gen1, context)
    // Durable state only: isolates what summarization preserved from what the verbatim tail
    // trivially carries. This is the metric the compounding hypothesis is actually about.
    const stateAll = recall(facts.all[generation - 1]!, state)
    const stateAged = recall(facts.aged[generation - 1]!, state)
    const stateGen1 = recall(facts.gen1, state)

    samples.push({
      session,
      strategy,
      generation,
      contextTokens: stateTokens + tailTokens,
      stateTokens,
      tailTokens,
      durableBytes,
      cumulativeDurableBytes: cumulative,
      promptTokens: Token.estimate(prompt),
      recallAll: all.pct,
      recallAged: aged.pct,
      recallGen1: gen1.pct,
      stateRecallAll: stateAll.pct,
      stateRecallAged: stateAged.pct,
      stateRecallGen1: stateGen1.pct,
      recallInstructions: all.instructions.total === 0 ? 1 : all.instructions.hit / all.instructions.total,
      factsAll: all.total,
      factsAged: aged.total,
      factsGen1: gen1.total,
      valid: strategy === "C-ledger" ? validSummary(summary ?? "") : validSummary(state),
      wallMs: Date.now() - started,
      degenerate,
      forcedByCurrentTurn,
    })
    tailStartIdx = nextTailStart
  }
  return samples
}

const main = async () => {
  const out: Sample[] = []
  const meta: any[] = []
  for (const session of targets) {
    const started = Date.now()
    const entries = load(session)
    const marks = boundaries(entries, MAX_GEN)
    if (marks.length === 0) {
      meta.push({ session, skipped: "never reaches the compaction threshold" })
      continue
    }
    const truncated = entries.slice(0, marks[marks.length - 1]!)
    const factsAll = marks.map((cut) => extractFacts(entries.slice(0, cut)))
    const factsAged = marks.map((_, index) => (index === 0 ? factsAll[0]! : factsAll[index - 1]!))
    const gen1 = factsAll[0]!
    meta.push({
      session,
      messages: entries.length,
      replayed: truncated.length,
      generations: marks.length,
      marks,
      factsPerGeneration: factsAll.map(factCount),
      messageWireTokens: (() => {
        const sizes = truncated.map((entry) => wireTokens(entry.message)).sort((a, b) => a - b)
        const at = (q: number) => sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))] ?? 0
        return {
          p50: at(0.5),
          p90: at(0.9),
          p99: at(0.99),
          max: sizes[sizes.length - 1] ?? 0,
          over8k: sizes.filter((v) => v > 8000).length,
        }
      })(),
      wireTokensReplayed: truncated.reduce((sum, entry) => sum + wireTokens(entry.message), 0),
    })
    console.error(
      `[${session}] ${marks.length} generations, ${truncated.length}/${entries.length} messages, facts ${factCount(gen1)}..${factCount(factsAll[factsAll.length - 1]!)}`,
    )
    const results = await pool(STRATEGIES, 5, (strategy) =>
      runStrategy(session, strategy, entries, marks, { all: factsAll, aged: factsAged, gen1 }),
    )
    for (const list of results) out.push(...list)
    console.error(
      `[${session}] done in ${((Date.now() - started) / 1000).toFixed(0)}s, llm ${JSON.stringify(llmStats())}`,
    )
  }
  mkdirSync(`${SCRATCH}/results`, { recursive: true })
  writeFileSync(`${SCRATCH}/results/${argOf("out") ?? "samples"}.json`, JSON.stringify({ meta, samples: out }, null, 2))
  console.error(`wrote ${out.length} samples; llm ${JSON.stringify(llmStats())}`)
}

await main()
