/**
 * Deterministic keep-window sweep: how much fact recall does the verbatim tail alone buy per
 * token, at each `keep.tokens` setting? No LLM involved — this isolates the tail from the
 * summary. EXPERIMENT ONLY.
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { Token } from "../../../../src/util/token"
import {
  extractFacts,
  items,
  load,
  recall,
  serializeElided,
  serializeMessage,
  splitIndex,
  wireTokens,
  SCRATCH,
  type Entry,
} from "./lib"

const THRESHOLD = 44_000
const MAX_GEN = 9
const BUDGETS = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]
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

const boundaries = (entries: readonly Entry[]) => {
  const result: number[] = []
  let total = 0
  let next = THRESHOLD
  for (let index = 0; index < entries.length; index++) {
    total += wireTokens(entries[index]!.message)
    if (total >= next) {
      result.push(index + 1)
      next += THRESHOLD
      if (result.length >= MAX_GEN) break
    }
  }
  return result
}

const rows: any[] = []
for (const session of SESSIONS) {
  const entries = load(session)
  const marks = boundaries(entries)
  if (marks.length === 0) continue
  const factsAll = marks.map((cut) => extractFacts(entries.slice(0, cut)))
  for (const budget of BUDGETS) {
    let tailStartIdx = 0
    for (let generation = 1; generation <= marks.length; generation++) {
      const cut = marks[generation - 1]!
      const window = entries.slice(tailStartIdx, cut)
      const list = items(window, serializeMessage)
      if (list.length === 0) break
      const { split } = splitIndex(list, { tokens: budget, turns: 2 })
      const nextTailStart = tailStartIdx + (list[split]?.index ?? window.length)
      const tail = entries.slice(nextTailStart, cut)
      const text = tail
        .map((entry) => serializeMessage(entry.message))
        .filter(Boolean)
        .join("\n\n")
      const elided = tail
        .map((entry) => serializeElided(entry.message))
        .filter(Boolean)
        .join("\n\n")
      rows.push({
        session,
        budget,
        generation,
        tailMessages: tail.length,
        tailTokens: tail.reduce((sum, entry) => sum + wireTokens(entry.message), 0),
        tailTokensElided: Token.estimate(elided),
        recallAll: recall(factsAll[generation - 1]!, text).pct,
        recallGen1: recall(factsAll[0]!, text).pct,
        recallAllElided: recall(factsAll[generation - 1]!, elided).pct,
      })
      tailStartIdx = nextTailStart
    }
  }
  console.error(`swept ${session}`)
}

mkdirSync(`${SCRATCH}/results`, { recursive: true })
writeFileSync(`${SCRATCH}/results/sweep.json`, JSON.stringify(rows))

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
console.log(
  "| keep.tokens | median tail msgs | median tail tokens | median recall (tail only) | recall per 1k tok | median elided tail tokens | elided recall |",
)
console.log("|---|---|---|---|---|---|---|")
for (const budget of BUDGETS) {
  const list = rows.filter((r) => r.budget === budget)
  const tokens = median(list.map((r) => r.tailTokens))
  const rec = median(list.map((r) => r.recallAll))
  console.log(
    `| ${budget} | ${median(list.map((r) => r.tailMessages))} | ${Math.round(tokens)} | ${(rec * 100).toFixed(1)}% | ${((rec * 1000) / Math.max(1, tokens)).toFixed(4)} | ${Math.round(median(list.map((r) => r.tailTokensElided)))} | ${(median(list.map((r) => r.recallAllElided)) * 100).toFixed(1)}% |`,
  )
}
