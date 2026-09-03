/** Aggregates samples.json into the report tables. EXPERIMENT ONLY. */
import { readFileSync } from "node:fs"
import { SCRATCH } from "./lib"

const data = JSON.parse(readFileSync(`${SCRATCH}/results/samples.json`, "utf8")) as {
  meta: any[]
  samples: any[]
}

const median = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const strategies = [...new Set(data.samples.map((s) => s.strategy))].sort()

const at = (strategy: string, generation: number, field: string) =>
  data.samples.filter((s) => s.strategy === strategy && s.generation === generation).map((s) => s[field] as number)

console.log("## Per-strategy summary (all sessions, all generations)\n")
console.log(
  "| strategy | median ctx tokens | median durable bytes | median summarize prompt tok | recall@g1 | recall@g3 | recall@g6 | recall@g9 | median wall s | valid summaries |",
)
console.log("|---|---|---|---|---|---|---|---|---|---|")
for (const strategy of strategies) {
  const rows = data.samples.filter((s) => s.strategy === strategy)
  const r = (g: number) => {
    const values = at(strategy, g, "recallAll")
    return values.length ? pct(median(values)) : "—"
  }
  console.log(
    `| ${strategy} | ${Math.round(median(rows.map((s) => s.contextTokens)))} | ${Math.round(median(rows.map((s) => s.durableBytes)))} | ${Math.round(median(rows.map((s) => s.promptTokens)))} | ${r(1)} | ${r(3)} | ${r(6)} | ${r(9)} | ${(median(rows.map((s) => s.wallMs)) / 1000).toFixed(1)} | ${rows.filter((s) => s.valid).length}/${rows.length} |`,
  )
}

console.log("\n## Durable-state recall only (summary/ledger, tail excluded) — the compounding test\n")
console.log("| strategy | state recall of gen-1 facts @g1 | @g2 | @g3 | @g4 | @g5 | @g6+ | median state tokens |")
console.log("|---|---|---|---|---|---|---|---|")
for (const strategy of strategies) {
  const rows = data.samples.filter((s) => s.strategy === strategy)
  const g = (n: number) => {
    const values = at(strategy, n, "stateRecallGen1")
    return values.length ? pct(median(values)) : "—"
  }
  const late = rows.filter((s) => s.generation >= 6).map((s) => s.stateRecallGen1 as number)
  console.log(
    `| ${strategy} | ${g(1)} | ${g(2)} | ${g(3)} | ${g(4)} | ${g(5)} | ${late.length ? pct(median(late)) : "—"} | ${Math.round(median(rows.map((s) => s.stateTokens)))} |`,
  )
}

console.log("\n## Recall efficiency\n")
console.log(
  "| strategy | median recall | median ctx tokens | recall per 1k ctx tokens | median aged recall | median instruction recall |",
)
console.log("|---|---|---|---|---|---|")
for (const strategy of strategies) {
  const rows = data.samples.filter((s) => s.strategy === strategy)
  const recall = median(rows.map((s) => s.recallAll as number))
  const tokens = median(rows.map((s) => s.contextTokens as number))
  console.log(
    `| ${strategy} | ${pct(recall)} | ${Math.round(tokens)} | ${((recall * 1000) / Math.max(1, tokens)).toFixed(4)} | ${pct(median(rows.map((s) => s.recallAged as number)))} | ${pct(median(rows.map((s) => s.recallInstructions as number)))} |`,
  )
}

console.log("\n## Degradation curve — recall of generation-1 facts by generation (all sessions)\n")
const maxGen = Math.max(...data.samples.map((s) => s.generation))
console.log(`| strategy | ${Array.from({ length: maxGen }, (_, i) => `g${i + 1}`).join(" | ")} |`)
console.log(`|---|${"---|".repeat(maxGen)}`)
for (const strategy of strategies) {
  const cells = Array.from({ length: maxGen }, (_, i) => {
    const values = at(strategy, i + 1, "recallGen1")
    return values.length ? pct(median(values)) : "—"
  })
  console.log(`| ${strategy} | ${cells.join(" | ")} |`)
}

console.log("\n## Durable-state size by generation (median bytes) — does the summary compound?\n")
console.log(`| strategy | ${Array.from({ length: maxGen }, (_, i) => `g${i + 1}`).join(" | ")} |`)
console.log(`|---|${"---|".repeat(maxGen)}`)
for (const strategy of strategies) {
  const cells = Array.from({ length: maxGen }, (_, i) => {
    const values = at(strategy, i + 1, "durableBytes")
    return values.length ? String(Math.round(median(values))) : "—"
  })
  console.log(`| ${strategy} | ${cells.join(" | ")} |`)
}

console.log("\n## A vs B head-to-head on identical inputs (paired by session+generation)\n")
const paired = data.samples
  .filter((s) => s.strategy === "A-baseline")
  .map((a) => {
    const b = data.samples.find(
      (s) => s.strategy === "B-noncompounding" && s.session === a.session && s.generation === a.generation,
    )
    return b ? { generation: a.generation, a, b } : undefined
  })
  .filter(Boolean) as any[]
console.log("| generation | pairs | A state-recall(gen1) | B state-recall(gen1) | B-A | A wins | B wins | ties |")
console.log("|---|---|---|---|---|---|---|---|")
for (let g = 1; g <= maxGen; g++) {
  const list = paired.filter((p) => p.generation === g)
  if (!list.length) continue
  const av = median(list.map((p) => p.a.stateRecallGen1 as number))
  const bv = median(list.map((p) => p.b.stateRecallGen1 as number))
  console.log(
    `| g${g} | ${list.length} | ${pct(av)} | ${pct(bv)} | ${((bv - av) * 100).toFixed(1)}pp | ${list.filter((p) => p.a.stateRecallGen1 > p.b.stateRecallGen1).length} | ${list.filter((p) => p.b.stateRecallGen1 > p.a.stateRecallGen1).length} | ${list.filter((p) => p.b.stateRecallGen1 === p.a.stateRecallGen1).length} |`,
  )
}
const aAll = paired.map((p) => p.a.stateRecallGen1 as number)
const bAll = paired.map((p) => p.b.stateRecallGen1 as number)
console.log(
  `| ALL | ${paired.length} | ${pct(median(aAll))} | ${pct(median(bAll))} | ${((median(bAll) - median(aAll)) * 100).toFixed(1)}pp | ${paired.filter((p) => p.a.stateRecallGen1 > p.b.stateRecallGen1).length} | ${paired.filter((p) => p.b.stateRecallGen1 > p.a.stateRecallGen1).length} | ${paired.filter((p) => p.b.stateRecallGen1 === p.a.stateRecallGen1).length} |`,
)

console.log("\n## Per-session, strategy A vs best alternative\n")
console.log("| session | gens | A ctx | A recall | best strategy | best ctx | best recall |")
console.log("|---|---|---|---|---|---|---|")
for (const session of [...new Set(data.samples.map((s) => s.session))]) {
  const rows = data.samples.filter((s) => s.session === session)
  const byStrategy = strategies.map((strategy) => {
    const list = rows.filter((s) => s.strategy === strategy)
    return {
      strategy,
      recall: median(list.map((s) => s.recallAll as number)),
      tokens: median(list.map((s) => s.contextTokens as number)),
      gens: list.length,
    }
  })
  const a = byStrategy.find((s) => s.strategy === "A-baseline")!
  const best = [...byStrategy].sort((l, r) => r.recall - l.recall)[0]!
  console.log(
    `| ${session.slice(0, 22)} | ${a.gens} | ${Math.round(a.tokens)} | ${pct(a.recall)} | ${best.strategy} | ${Math.round(best.tokens)} | ${pct(best.recall)} |`,
  )
}

console.log("\n## Meta\n")
for (const entry of data.meta) console.log(JSON.stringify(entry))
const forced = data.samples.map((s) => s.forcedByCurrentTurn as number).filter((v) => v > 0)
console.log(
  `\npreserveCurrentTurn clamp: fires on ${forced.length}/${data.samples.length} checkpoints, median extra tail ${Math.round(median(forced))} tokens, max ${Math.max(0, ...forced)}`,
)
console.log(
  `total wall: ${(data.samples.reduce((sum, s) => sum + s.wallMs, 0) / 1000 / 60).toFixed(1)} strategy-minutes`,
)
