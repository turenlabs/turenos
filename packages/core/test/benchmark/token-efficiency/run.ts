#!/usr/bin/env bun
/**
 * Token-efficiency benchmark: TurenOS vs Claude Code vs Codex.
 *
 * Run it:
 *   bun run packages/core/test/benchmark/token-efficiency/run.ts --dry-run
 *   bun run packages/core/test/benchmark/token-efficiency/run.ts --yes
 *   bun run packages/core/test/benchmark/token-efficiency/run.ts --harness turen-claude-code,claude-code --task trivial --yes
 *
 * This spends real tokens against real accounts. It always prints an estimate
 * and requires --yes (or an interactive confirmation) before doing so.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { claudeCode } from "./src/harness/claude-code.ts"
import { codex } from "./src/harness/codex.ts"
import { turenClaudeCode, turenOpenai } from "./src/harness/turen.ts"
import { modelCost } from "./src/pricing.ts"
import { derive, renderReport } from "./src/report.ts"
import { TASKS } from "./src/tasks.ts"
import {
  addUsage,
  emptyUsage,
  subtractUsage,
  type Harness,
  type RunRecord,
  type Task,
  type TurnRecord,
  type Usage,
} from "./src/types.ts"
import { BENCH_DIR, materializeWorkspace, scratchRoot } from "./src/workspace.ts"

const HARNESSES: Harness[] = [claudeCode, turenClaudeCode, codex, turenOpenai]

/**
 * Rough per-run context-token expectations used only for the pre-flight cost
 * estimate. They are seeded from observed runs and are explicitly labelled as
 * an estimate; nothing downstream ever reads them.
 */
const ESTIMATE_CONTEXT_TOKENS: Record<string, number> = {
  trivial: 40_000,
  search: 70_000,
  edit: 80_000,
  conversation: 250_000,
}

interface Options {
  harnesses: string[]
  tasks: string[]
  repetitions: number
  yes: boolean
  dryRun: boolean
  timeoutMs: number
  outDir: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    harnesses: HARNESSES.map((harness) => harness.id),
    tasks: TASKS.map((task) => task.id),
    repetitions: 1,
    yes: false,
    dryRun: false,
    timeoutMs: 300_000,
    outDir: path.join(BENCH_DIR, "results"),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      i += 1
      return value
    }
    switch (arg) {
      case "--harness":
        options.harnesses = next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
        break
      case "--task":
        options.tasks = next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
        break
      case "--repetitions":
        options.repetitions = Number.parseInt(next(), 10)
        break
      case "--timeout":
        options.timeoutMs = Number.parseInt(next(), 10) * 1000
        break
      case "--out":
        options.outDir = path.resolve(next())
        break
      case "--yes":
      case "-y":
        options.yes = true
        break
      case "--dry-run":
        options.dryRun = true
        break
      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown flag: ${arg}`)
    }
  }
  const unknownHarness = options.harnesses.filter((id) => !HARNESSES.some((harness) => harness.id === id))
  if (unknownHarness.length) throw new Error(`unknown harness(es): ${unknownHarness.join(", ")}`)
  const unknownTask = options.tasks.filter((id) => !TASKS.some((task) => task.id === id))
  if (unknownTask.length) throw new Error(`unknown task(s): ${unknownTask.join(", ")}`)
  if (!Number.isFinite(options.repetitions) || options.repetitions < 1) throw new Error("--repetitions must be >= 1")
  return options
}

function printHelp() {
  console.log(`token-efficiency benchmark

  --harness <ids>      comma-separated: ${HARNESSES.map((h) => h.id).join(", ")}
  --task <ids>         comma-separated: ${TASKS.map((t) => t.id).join(", ")}
  --repetitions <n>    repetitions per (harness, task). default 1
  --timeout <sec>      per-turn timeout. default 300
  --out <dir>          results directory. default <bench>/results
  --dry-run            print the plan and the estimate, run nothing
  --yes, -y            skip the confirmation prompt
`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const selectedHarnesses = HARNESSES.filter((harness) => options.harnesses.includes(harness.id))
  const selectedTasks = TASKS.filter((task) => options.tasks.includes(task.id))

  console.log("TOKEN-EFFICIENCY BENCHMARK")
  console.log("")
  console.log("Fair-pairing design: cross-provider numbers confound model with harness, so")
  console.log("harnesses are compared within a pairing that holds the underlying model fixed.")
  for (const pairing of new Set(selectedHarnesses.map((harness) => harness.pairing))) {
    const members = selectedHarnesses.filter((harness) => harness.pairing === pairing)
    console.log(
      `  ${pairing}: ${members.map((member) => `${member.id} -> ${member.model} (${member.underlyingModel})`).join("  |  ")}`,
    )
  }
  console.log("")

  // Availability precheck, so we never spend money on an arm that cannot run.
  const availability = new Map<string, { ok: true } | { ok: false; reason: string }>()
  for (const harness of selectedHarnesses) {
    const status = await harness.available()
    availability.set(harness.id, status)
    console.log(`  ${status.ok ? "available" : "BLOCKED  "}  ${harness.id}${status.ok ? "" : ` — ${status.reason}`}`)
  }
  console.log("")

  const runnable = selectedHarnesses.filter((harness) => availability.get(harness.id)?.ok)

  let estimatedTokens = 0
  let estimatedUsd = 0
  let anyUnpriced = false
  for (const harness of runnable) {
    for (const task of selectedTasks) {
      const context = (ESTIMATE_CONTEXT_TOKENS[task.id] ?? 60_000) * options.repetitions
      estimatedTokens += context
      const cost = modelCost(harness.pricingKey, {
        // Estimate assumes a cache-heavy profile: most prompt tokens are reads.
        inputTokens: context * 0.15,
        cacheReadTokens: context * 0.8,
        cacheWriteTokens: context * 0.05,
        outputTokens: context * 0.01,
        reasoningTokens: 0,
        contextTokens: context,
      })
      if (cost === null) anyUnpriced = true
      else estimatedUsd += cost
    }
  }

  console.log("ESTIMATE (rough, from previously observed runs — not a measurement)")
  console.log(`  runs:              ${runnable.length * selectedTasks.length * options.repetitions}`)
  console.log(`  context tokens:  ~ ${Math.round(estimatedTokens).toLocaleString("en-US")}`)
  console.log(
    `  modeled cost:    ~ $${estimatedUsd.toFixed(2)}${anyUnpriced ? " (+ unpriced arms, see PRICING BASIS)" : ""}`,
  )
  console.log("  Note: Claude Code and Codex are billed against subscriptions on this machine,")
  console.log("        so the real marginal dollar cost is 0 and the true budget is rate limit.")
  console.log("")

  if (options.dryRun) {
    console.log("--dry-run: stopping before spending anything.")
    return
  }
  if (!options.yes) {
    console.log("Refusing to spend tokens without --yes. Re-run with --yes to proceed.")
    process.exit(2)
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  console.log(`scratch root: ${scratchRoot()}`)
  console.log(`run id:       ${runId}`)
  console.log("")

  const runs: RunRecord[] = []

  for (const harness of selectedHarnesses) {
    const status = availability.get(harness.id)
    for (const task of selectedTasks) {
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        if (status && !status.ok) {
          // Record the blocked arm rather than silently dropping the row.
          runs.push(blockedRun(harness, task, repetition, status.reason))
          continue
        }
        const record = await executeRun({ harness, task, repetition, runId, options })
        runs.push(record)
        const label = `${harness.id}/${task.id}#${repetition}`
        console.log(
          `  ${label.padEnd(42)} ${record.status.padEnd(15)} ctx=${record.usage.contextTokens.toLocaleString("en-US")} ` +
            `out=${record.usage.outputTokens} reqs=${record.providerRequests} ${(record.wallMs / 1000).toFixed(1)}s`,
        )
      }
    }
  }

  const derived = derive(runs)
  console.log(renderReport(runs, derived))

  mkdirSync(options.outDir, { recursive: true })
  const outFile = path.join(options.outDir, `${runId}.json`)
  writeFileSync(
    outFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        startedAt: new Date().toISOString(),
        host: { platform: process.platform, arch: process.arch, bun: Bun.version },
        options: {
          harnesses: options.harnesses,
          tasks: options.tasks,
          repetitions: options.repetitions,
          timeoutMs: options.timeoutMs,
        },
        harnesses: selectedHarnesses.map((harness) => ({
          id: harness.id,
          label: harness.label,
          pairing: harness.pairing,
          model: harness.model,
          underlyingModel: harness.underlyingModel,
          pricingKey: harness.pricingKey,
          usageIsCumulative: harness.usageIsCumulative,
          availability: availability.get(harness.id),
        })),
        tasks: selectedTasks.map((task) => ({
          id: task.id,
          label: task.label,
          measures: task.measures,
          needsWrite: task.needsWrite,
          turns: task.turns.length,
        })),
        runs,
        derived,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  console.log("")
  console.log(`results written to ${outFile}`)

  const hardFailures = runs.filter((run) => run.status === "harness_error")
  if (hardFailures.length > 0) process.exitCode = 1
}

function blockedRun(harness: Harness, task: Task, repetition: number, reason: string): RunRecord {
  return {
    harness: harness.id,
    harnessLabel: harness.label,
    pairing: harness.pairing,
    model: harness.model,
    underlyingModel: harness.underlyingModel,
    pricingKey: harness.pricingKey,
    task: task.id,
    taskLabel: task.label,
    repetition,
    status: "blocked",
    statusDetail: reason,
    workspace: "",
    startedAt: new Date().toISOString(),
    wallMs: 0,
    usage: emptyUsage(),
    providerRequests: 0,
    providerRequestsExact: true,
    toolCalls: 0,
    reportedCostUsd: null,
    modeledCostUsd: null,
    turns: [],
  }
}

async function executeRun(args: {
  harness: Harness
  task: Task
  repetition: number
  runId: string
  options: Options
}): Promise<RunRecord> {
  const { harness, task, repetition, runId, options } = args
  const runKey = `${harness.id}__${task.id}__r${repetition}`
  const workspace = materializeWorkspace(runId, runKey)
  const startedAt = new Date().toISOString()

  const turns: TurnRecord[] = []
  let usage = emptyUsage()
  let providerRequests = 0
  let providerRequestsExact = true
  let toolCalls = 0
  let wallMs = 0
  let reportedCost: number | null = null
  let sessionId: string | null = null
  let status: RunRecord["status"] = "ok"
  let statusDetail: string | null = null
  // Running total previously reported by a cumulative-usage harness, so each
  // turn's own cost can be recovered by differencing.
  let previousCumulative: Usage = emptyUsage()

  for (const [turnIndex, turn] of task.turns.entries()) {
    const outcome = await harness.run({
      workspace,
      prompt: turn.prompt,
      sessionId,
      multiTurn: task.turns.length > 1,
      allowWrite: task.needsWrite,
      runKey,
      runId,
      timeoutMs: options.timeoutMs,
    })

    const rawUsage = outcome.usage
    const turnUsage = harness.usageIsCumulative ? subtractUsage(rawUsage, previousCumulative) : rawUsage
    if (harness.usageIsCumulative && outcome.ok) previousCumulative = rawUsage

    usage = addUsage(usage, turnUsage)
    providerRequests += outcome.providerRequests
    providerRequestsExact = providerRequestsExact && outcome.providerRequestsExact
    toolCalls += outcome.toolCalls
    wallMs += outcome.wallMs
    if (outcome.reportedCostUsd !== null) reportedCost = (reportedCost ?? 0) + outcome.reportedCostUsd
    if (outcome.sessionId) sessionId = outcome.sessionId

    if (!outcome.ok) {
      turns.push({
        ...outcome,
        usage: turnUsage,
        rawUsage,
        turnIndex,
        prompt: turn.prompt,
        verifierPass: false,
        verifierDetail: "not run",
      })
      status = "harness_error"
      statusDetail = outcome.error
      // A broken turn poisons the rest of the conversation; stop here and
      // record what actually happened.
      break
    }

    const verdict = turn.verify({ text: outcome.text, workspace })
    turns.push({
      ...outcome,
      usage: turnUsage,
      rawUsage,
      turnIndex,
      prompt: turn.prompt,
      verifierPass: verdict.pass,
      verifierDetail: verdict.detail,
    })
    if (!verdict.pass && status === "ok") {
      status = "verifier_failed"
      statusDetail = `turn ${turnIndex + 1}: ${verdict.detail}`
    }
  }

  return {
    harness: harness.id,
    harnessLabel: harness.label,
    pairing: harness.pairing,
    model: harness.model,
    underlyingModel: harness.underlyingModel,
    pricingKey: harness.pricingKey,
    task: task.id,
    taskLabel: task.label,
    repetition,
    status,
    statusDetail,
    workspace,
    startedAt,
    wallMs,
    usage,
    providerRequests,
    providerRequestsExact,
    toolCalls,
    reportedCostUsd: reportedCost,
    modeledCostUsd: modelCost(harness.pricingKey, usage),
    turns,
  }
}

await main()
