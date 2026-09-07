import type { LoopInfo, LoopRun } from "./api"
import { currentStepIndex, failedStep, isActiveRun, orderedStepOutputs, runTotal } from "./run-view"

export type LatestRun = {
  readonly loopID: string
  readonly loopName: string
  readonly steps: StepRef
  readonly run: LoopRun
}

export type StepRef = readonly { readonly id: string; readonly name: string }[]

const EXCERPT_MAX = 280

/** Short relative age like the mocks: "2h ago", "3m ago", "live" never appears here. */
export function relativeAgo(now: number, timestamp: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

const countdown = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return "less than a minute"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Sidebar/header next-run line. The server owns the schedule (`nextRunAt` is
 * null for paused automations and event triggers without a pending fire), so
 * this only formats what the server reported.
 */
export function nextRunLabel(automation: Pick<LoopInfo, "status" | "nextRunAt">, now = Date.now()): string | undefined {
  if (automation.status === "paused") return "paused"
  if (automation.status !== "active" || automation.nextRunAt === undefined) return undefined
  const at = Number(automation.nextRunAt)
  if (!Number.isFinite(at)) return undefined
  if (at <= now) return "starting soon"
  return `next run in ${countdown(at - now)}`
}

/** One-line outcome for a run row, mirroring the mock vocabulary. */
export function outcomeLine(run: LoopRun, steps: StepRef): string {
  const total = runTotal(run, steps)
  if (run.status === "failed") {
    const failed = failedStep(run, steps)
    const where = failed ? `step ${failed.index + 1} of ${total}` : `step 1 of ${total}`
    const cause = run.error?.split("\n")[0]?.trim()
    return cause ? `failed · ${where} — ${cause}` : `failed · ${where}`
  }
  if (isActiveRun(run)) {
    const at = Math.min(currentStepIndex(run) + 1, total)
    const via = run.trigger === "scheduled" ? "" : ` · ${run.trigger}`
    return `running · step ${at} of ${total}${via}`
  }
  if (run.status === "succeeded") {
    const done = Math.min(Math.max(Object.keys(run.outputs).length, 1), total)
    return `${done} of ${total} done`
  }
  return run.status
}

/** Final-step output excerpt; falls back to the run error when nothing completed. */
export function finalExcerpt(run: LoopRun, steps: StepRef, max = EXCERPT_MAX): string {
  const entries = orderedStepOutputs(run, steps)
  const last = entries[entries.length - 1]?.[1]
  const raw = last
    ? last.text || (last.json === undefined ? "" : JSON.stringify(last.json, null, 2))
    : (run.error ?? "")
  const text = raw.trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

/** Newest runs across automations, newest first. `runList` already returns newest first. */
export function latestRunsAcross(
  entries: ReadonlyArray<{
    readonly automation: Pick<LoopInfo, "id" | "name" | "workflow">
    readonly runs: readonly LoopRun[]
  }>,
  limit: number,
): LatestRun[] {
  return entries
    .flatMap(({ automation, runs }) => {
      const steps = automation.workflow?.steps.map((step) => ({ id: step.id, name: step.name })) ?? []
      return runs.map((run) => ({ loopID: automation.id, loopName: automation.name, steps, run }))
    })
    .toSorted((a, b) => Number(b.run.scheduledAt) - Number(a.run.scheduledAt))
    .slice(0, Math.max(0, limit))
}
