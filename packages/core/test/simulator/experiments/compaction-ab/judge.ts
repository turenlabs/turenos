/**
 * Semantic recall check on a stratified sample, using the same cheap model (claude-haiku-4-5)
 * that produced the summaries. Tests whether facts the deterministic substring scorer marked
 * MISSED are in fact still recoverable in paraphrase. EXPERIMENT ONLY.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { complete, extractFacts, load, pool, wireTokens, SCRATCH, type Entry, type Facts } from "./lib"

const THRESHOLD = 44_000
const MAX_GEN = 9
const SAMPLE_FACTS = 12

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

const flatten = (facts: Facts) => [
  ...[...facts.instructions].map((value) => ({ kind: "instruction", value })),
  ...[...facts.paths].map((value) => ({ kind: "path", value })),
  ...[...facts.errors].map((value) => ({ kind: "error", value })),
  ...[...facts.identifiers].map((value) => ({ kind: "identifier", value })),
]

const JUDGE_SYSTEM =
  "You are a strict evaluator. You never converse and never explain. Your entire output is one line of comma-separated 1/0 values, one per numbered fact, in order."

const main = async () => {
  const files = readdirSync(`${SCRATCH}/results/states`)
  const targets: { session: string; strategy: string; generation: number; file: string }[] = []
  for (const file of files) {
    const match = /^(ses_[^.]+)\.([A-E]-[a-z]+)\.g(\d+)\.md$/.exec(file)
    if (!match) continue
    const generation = Number(match[3])
    // Stratified: generations 1, 3, 6, 9 only.
    if (![1, 3, 6, 9].includes(generation)) continue
    targets.push({ session: match[1]!, strategy: match[2]!, generation, file })
  }
  const factsBySession = new Map<string, Facts>()
  for (const session of new Set(targets.map((t) => t.session))) {
    const entries = load(session)
    const marks = boundaries(entries)
    factsBySession.set(session, extractFacts(entries.slice(0, marks[0] ?? entries.length)))
  }

  const results = await pool(targets, 4, async (target) => {
    const state = readFileSync(`${SCRATCH}/results/states/${target.file}`, "utf8")
    const facts = flatten(factsBySession.get(target.session)!)
    // Deterministic stratified pick so the sample is reproducible.
    const step = Math.max(1, Math.floor(facts.length / SAMPLE_FACTS))
    const picked = facts.filter((_, index) => index % step === 0).slice(0, SAMPLE_FACTS)
    if (picked.length === 0) return undefined
    const deterministic: number[] = picked.map((fact) =>
      state.toLowerCase().includes(fact.value.trim().toLowerCase()) ? 1 : 0,
    )
    const prompt = `Below is a compacted context an AI agent would resume work from, followed by facts that were present in the original uncompacted conversation.

For each numbered fact, answer 1 if the fact is still recoverable from the compacted context — stated verbatim, paraphrased, or unambiguously implied — and 0 if the compacted context gives no way to recover it.

Output exactly ${picked.length} comma-separated values, nothing else.

<compacted-context>
${state.slice(0, 60_000)}
</compacted-context>

<facts>
${picked.map((fact, index) => `${index + 1}. [${fact.kind}] ${fact.value}`).join("\n")}
</facts>`
    const answer = await complete(JUDGE_SYSTEM, prompt)
    const parsed = answer
      .replace(/[^01,]/g, "")
      .split(",")
      .filter((value) => value === "0" || value === "1")
      .map(Number)
    if (parsed.length !== picked.length) return undefined
    return {
      ...target,
      n: picked.length,
      deterministic: deterministic.reduce((a, b) => a + b, 0) / picked.length,
      semantic: parsed.reduce((a, b) => a + b, 0) / picked.length,
    }
  })

  const rows = results.filter(Boolean) as any[]
  writeFileSync(`${SCRATCH}/results/judge.json`, JSON.stringify(rows, null, 2))
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
  console.log("| strategy | judged samples | deterministic recall | semantic recall (haiku judge) |")
  console.log("|---|---|---|---|")
  for (const strategy of [...new Set(rows.map((r) => r.strategy))].sort()) {
    const list = rows.filter((r) => r.strategy === strategy)
    console.log(
      `| ${strategy} | ${list.length} | ${(mean(list.map((r) => r.deterministic)) * 100).toFixed(1)}% | ${(mean(list.map((r) => r.semantic)) * 100).toFixed(1)}% |`,
    )
  }
  console.log("\n| generation | deterministic | semantic |")
  console.log("|---|---|---|")
  for (const generation of [1, 3, 6, 9]) {
    const list = rows.filter((r) => r.generation === generation)
    if (!list.length) continue
    console.log(
      `| g${generation} | ${(mean(list.map((r) => r.deterministic)) * 100).toFixed(1)}% | ${(mean(list.map((r) => r.semantic)) * 100).toFixed(1)}% |`,
    )
  }
}

await main()
