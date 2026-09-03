import { priceNote } from "./pricing.ts"
import type { RunRecord } from "./types.ts"

export interface HarnessDerived {
  harness: string
  harnessLabel: string
  pairing: string
  model: string
  underlyingModel: string
  pricingKey: string | null
  /** Context tokens for the trivial task — the floor before real work. */
  fixedOverheadContextTokens: number | null
  /**
   * Context of the FIRST provider request on the trivial task: system prompt +
   * tool schemas + one short user message. The purest overhead figure we can
   * measure. Null where the harness does not expose per-request usage.
   */
  firstRequestContextTokens: number | null
  /** Context tokens above the trivial-task floor, per task. */
  marginalContextTokens: Record<string, number | null>
  /** Per-turn context for the 5-turn task, turn 1..N. */
  conversationTurnContextTokens: number[] | null
  /** Least-squares slope of context tokens per additional turn. */
  contextGrowthSlopeTokensPerTurn: number | null
  tasksPassed: number
  tasksAttempted: number
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Least-squares slope of y over x = 0..n-1. */
export function slope(values: number[]): number | null {
  const n = values.length
  if (n < 2) return null
  const meanX = (n - 1) / 2
  const meanY = values.reduce((sum, value) => sum + value, 0) / n
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i += 1) {
    numerator += (i - meanX) * ((values[i] ?? 0) - meanY)
    denominator += (i - meanX) ** 2
  }
  if (denominator === 0) return null
  return numerator / denominator
}

export function derive(runs: RunRecord[]): HarnessDerived[] {
  const byHarness = new Map<string, RunRecord[]>()
  for (const run of runs) {
    const list = byHarness.get(run.harness) ?? []
    list.push(run)
    byHarness.set(run.harness, list)
  }

  const derived: HarnessDerived[] = []
  for (const [harness, list] of byHarness) {
    const first = list[0]
    if (!first) continue
    const scored = list.filter((run) => run.status === "ok" || run.status === "verifier_failed")

    const trivial = scored.filter((run) => run.task === "trivial")
    const fixedOverhead = mean(trivial.map((run) => run.usage.contextTokens))
    const firstRequest = mean(
      trivial
        .map((run) => run.turns[0]?.requests[0]?.usage.contextTokens)
        .filter((value): value is number => typeof value === "number"),
    )

    const marginal: Record<string, number | null> = {}
    for (const task of new Set(scored.map((run) => run.task))) {
      if (task === "trivial") continue
      const taskMean = mean(scored.filter((run) => run.task === task).map((run) => run.usage.contextTokens))
      marginal[task] = taskMean !== null && fixedOverhead !== null ? taskMean - fixedOverhead : null
    }

    // Per-turn context for the conversation task, averaged across repetitions.
    const conversations = scored.filter((run) => run.task === "conversation")
    let perTurn: number[] | null = null
    if (conversations.length > 0) {
      const turnCount = Math.max(...conversations.map((run) => run.turns.length))
      const collected: number[] = []
      for (let i = 0; i < turnCount; i += 1) {
        const values = conversations
          .map((run) => run.turns[i])
          .filter((turn): turn is NonNullable<typeof turn> => Boolean(turn) && turn!.ok)
          .map((turn) => turn.usage.contextTokens)
        const value = mean(values)
        if (value === null) break
        collected.push(Math.round(value))
      }
      perTurn = collected.length > 0 ? collected : null
    }

    derived.push({
      harness,
      harnessLabel: first.harnessLabel,
      pairing: first.pairing,
      model: first.model,
      underlyingModel: first.underlyingModel,
      pricingKey: first.pricingKey,
      fixedOverheadContextTokens: fixedOverhead === null ? null : Math.round(fixedOverhead),
      firstRequestContextTokens: firstRequest === null ? null : Math.round(firstRequest),
      marginalContextTokens: Object.fromEntries(
        Object.entries(marginal).map(([key, value]) => [key, value === null ? null : Math.round(value)]),
      ),
      conversationTurnContextTokens: perTurn,
      contextGrowthSlopeTokensPerTurn: perTurn ? Math.round(slope(perTurn) ?? 0) : null,
      tasksPassed: list.filter((run) => run.status === "ok").length,
      tasksAttempted: list.length,
    })
  }
  return derived
}

function pad(value: string, width: number, align: "left" | "right" = "left") {
  if (value.length >= width) return value
  const filler = " ".repeat(width - value.length)
  return align === "right" ? filler + value : value + filler
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  )
  const aligned = (row: string[]) =>
    row.map((cell, index) => pad(cell, widths[index] ?? 0, index === 0 ? "left" : "right")).join("  ")
  const lines = [aligned(headers), widths.map((width) => "-".repeat(width)).join("  ")]
  for (const row of rows) lines.push(aligned(row))
  return lines.map((line) => `  ${line}`).join("\n")
}

function n(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a"
  return Math.round(value).toLocaleString("en-US")
}

function usd(value: number | null): string {
  if (value === null) return "n/a"
  return `$${value.toFixed(4)}`
}

export function renderReport(runs: RunRecord[], derived: HarnessDerived[]): string {
  const out: string[] = []

  out.push("")
  out.push("PER-RUN RESULTS")
  out.push(
    table(
      [
        "harness",
        "task",
        "rep",
        "status",
        "ctx tok",
        "uncached",
        "cache rd",
        "cache wr",
        "out",
        "reqs",
        "tools",
        "sec",
        "$ model",
      ],
      runs.map((run) => [
        run.harness,
        run.task,
        String(run.repetition),
        run.status === "ok"
          ? "pass"
          : run.status === "verifier_failed"
            ? "FAIL-verify"
            : run.status === "blocked"
              ? "BLOCKED"
              : "ERROR",
        n(run.usage.contextTokens),
        n(run.usage.inputTokens),
        n(run.usage.cacheReadTokens),
        n(run.usage.cacheWriteTokens),
        n(run.usage.outputTokens),
        `${run.providerRequests}${run.providerRequestsExact ? "" : "~"}`,
        String(run.toolCalls),
        (run.wallMs / 1000).toFixed(1),
        usd(run.modeledCostUsd),
      ]),
    ),
  )

  const problems = runs.filter((run) => run.status !== "ok")
  if (problems.length > 0) {
    out.push("")
    out.push("FAILURES AND BLOCKED ARMS (recorded, not dropped)")
    for (const run of problems) {
      out.push(`  ${run.harness}/${run.task}#${run.repetition} [${run.status}] ${run.statusDetail ?? ""}`)
    }
  }

  out.push("")
  out.push("DERIVED METRICS")
  out.push(
    table(
      ["harness", "pairing", "model", "fixed ovh", "1st req ctx", "+search", "+edit", "+conv", "slope/turn", "pass"],
      derived.map((row) => [
        row.harness,
        row.pairing,
        row.model,
        n(row.fixedOverheadContextTokens),
        n(row.firstRequestContextTokens),
        n(row.marginalContextTokens["search"]),
        n(row.marginalContextTokens["edit"]),
        n(row.marginalContextTokens["conversation"]),
        n(row.contextGrowthSlopeTokensPerTurn),
        `${row.tasksPassed}/${row.tasksAttempted}`,
      ]),
    ),
  )
  out.push("")
  out.push("  fixed ovh   = context tokens for the trivial one-file question (the floor)")
  out.push("  1st req ctx = context of the first provider request on that task (system prompt + tools)")
  out.push("  +task       = context tokens for that task above the trivial-task floor")
  out.push("  slope/turn  = least-squares growth in context tokens per extra conversation turn")
  out.push("  ~ on reqs   = approximate count (harness does not expose per-request usage)")

  const conversational = derived.filter((row) => row.conversationTurnContextTokens)
  if (conversational.length > 0) {
    out.push("")
    out.push("CONTEXT GROWTH ACROSS THE 5-TURN CONVERSATION (context tokens per turn)")
    out.push("  Codex reports a running conversation total on every turn, so its per-turn figures")
    out.push("  are differences between consecutive readings. Raw readings are in the JSON as rawUsage.")
    const turnCount = Math.max(...conversational.map((row) => row.conversationTurnContextTokens?.length ?? 0))
    out.push(
      table(
        ["harness", ...Array.from({ length: turnCount }, (_, i) => `turn ${i + 1}`), "total", "slope"],
        conversational.map((row) => {
          const turns = row.conversationTurnContextTokens ?? []
          return [
            row.harness,
            ...Array.from({ length: turnCount }, (_, i) => n(turns[i])),
            n(turns.reduce((sum, value) => sum + value, 0)),
            n(row.contextGrowthSlopeTokensPerTurn),
          ]
        }),
      ),
    )
  }

  const pairings = new Map<string, HarnessDerived[]>()
  for (const row of derived) {
    const list = pairings.get(row.pairing) ?? []
    list.push(row)
    pairings.set(row.pairing, list)
  }
  out.push("")
  out.push("PAIRED COMPARISON (same underlying model — the delta is harness overhead)")
  for (const [pairing, members] of pairings) {
    out.push(`  ${pairing}: ${members.map((member) => `${member.harness} (${member.model})`).join("  vs  ")}`)
    const measured = members.filter((member) => member.fixedOverheadContextTokens !== null)
    if (measured.length < 2) {
      out.push("    INCOMPLETE PAIRING — at least one arm produced no measurement (see BLOCKED/FAILURES above).")
      out.push("    No harness-overhead conclusion is drawn for this pairing.")
      continue
    }
    const baseline = measured.find((member) => !member.harness.startsWith("turen")) ?? measured[0]
    for (const member of measured) {
      if (!baseline || member === baseline) continue
      const mine = member.fixedOverheadContextTokens ?? 0
      const theirs = baseline.fixedOverheadContextTokens ?? 0
      if (theirs === 0) continue
      const ratio = mine / theirs
      const direction = ratio < 1 ? `${(1 / ratio).toFixed(2)}x fewer` : `${ratio.toFixed(2)}x more`
      out.push(
        `    fixed overhead: ${baseline.harness} ${n(theirs)} -> ${member.harness} ${n(mine)} ` +
          `(${member.harness} uses ${direction} context tokens)`,
      )
      for (const task of ["search", "edit", "conversation"]) {
        const mineTask = member.marginalContextTokens[task]
        const theirsTask = baseline.marginalContextTokens[task]
        if (typeof mineTask !== "number" || typeof theirsTask !== "number") continue
        out.push(`    marginal on ${task}: ${baseline.harness} ${n(theirsTask)} -> ${member.harness} ${n(mineTask)}`)
      }
      if (member.contextGrowthSlopeTokensPerTurn !== null && baseline.contextGrowthSlopeTokensPerTurn !== null) {
        out.push(
          `    growth/turn: ${baseline.harness} ${n(baseline.contextGrowthSlopeTokensPerTurn)} -> ` +
            `${member.harness} ${n(member.contextGrowthSlopeTokensPerTurn)}`,
        )
      }
    }
  }

  out.push("")
  out.push("PRICING BASIS (modeled cost only — both external harnesses bill against a subscription here)")
  for (const row of derived) out.push(`  ${row.harness} [${row.underlyingModel}]: ${priceNote(row.pricingKey)}`)

  return out.join("\n")
}
