import type { LoopRun } from "./api"
import { parseEventPaths, type TriggerDraft } from "./trigger"

export type StepState = "done" | "active" | "failed" | "pending"

export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: "done",
  active: "running",
  failed: "failed",
  pending: "pending",
}

export const STEP_STATE_TONE: Record<StepState, string> = {
  done: "bg-v2-state-bg-success text-v2-state-fg-success",
  active: "bg-v2-state-bg-warning text-v2-state-fg-warning",
  failed: "bg-v2-state-bg-danger text-v2-state-fg-danger",
  pending: "bg-v2-background-bg-layer-03 text-v2-text-text-muted",
}

export const latestRunTone = (status: LoopRun["status"]) =>
  status === "failed"
    ? "text-v2-state-fg-danger"
    : status === "succeeded"
      ? "text-v2-text-text-muted"
      : "text-v2-state-fg-warning"

export const currentStepIndex = (run: LoopRun) => {
  const index = Number(run.currentStep)
  return Number.isInteger(index) && index >= 0 ? index : 0
}

export const isActiveRun = (run: LoopRun) => run.status === "running" || run.status === "claimed"

/** Steps in workflow order; outputs from removed step IDs trail in received order. */
export const orderedStepOutputs = (run: LoopRun, steps: readonly { id: string }[]) => {
  const entries = Object.entries(run.outputs)
  const order = new Map(steps.map((step, index) => [step.id, index]))
  return entries.toSorted(([a], [b]) => (order.get(a) ?? entries.length) - (order.get(b) ?? entries.length))
}

/**
 * Per-step state is inferred: the backend records completed outputs plus the
 * run-level `currentStep` (count of completed steps, so also the failed/active
 * index), never a per-step status of its own.
 */
export const stepState = (run: LoopRun, stepID: string, index: number): StepState => {
  if (run.outputs[stepID] !== undefined) return "done"
  if (run.status === "failed" && currentStepIndex(run) === index) return "failed"
  if (isActiveRun(run) && currentStepIndex(run) === index) return "active"
  return "pending"
}

/** The step a failed run stopped at: `currentStep` names the step with no output. */
export const failedStep = (run: LoopRun, steps: readonly { id: string; name: string }[]) => {
  if (run.status !== "failed") return
  const index = currentStepIndex(run)
  const step = steps[index]
  return { index, name: step?.name || step?.id || `step ${index + 1}` }
}

/** Total card count: workflow steps win, then output count, then a single slot. */
export const runTotal = (run: LoopRun, steps: readonly { id: string }[]) =>
  steps.length || Object.keys(run.outputs).length || 1

/** Active-run progress line: "Step X of N · name", clamped to the total. */
export const runProgressLabel = (run: LoopRun, steps: readonly { id: string; name: string }[]) => {
  if (!isActiveRun(run)) return
  const total = runTotal(run, steps)
  const at = Math.min(currentStepIndex(run) + 1, total)
  const name = steps[currentStepIndex(run)]?.name
  return `Step ${at} of ${total}${name ? ` · ${name}` : ""}`
}

/** Failed-run callout line, naming the step the run stopped at. */
export const failedCallout = (run: LoopRun, steps: readonly { id: string; name: string }[]) => {
  const failed = failedStep(run, steps)
  if (!failed) return
  return `Failed at step ${failed.index + 1} · ${failed.name}${run.error ? `: ${run.error}` : ""}`
}

/** Card identity for one output entry: workflow name/index, or the raw step ID. */
export const stepDisplay = (
  stepID: string,
  steps: readonly { id: string; name: string }[],
  total: number,
) => ({
  name: steps.find((step) => step.id === stepID)?.name || stepID,
  index: Math.max(
    steps.findIndex((step) => step.id === stepID),
    0,
  ),
  total,
})

/** Latest-run state for a canvas step node, inferred from outputs + currentStep. */
export const stepChipFor = (run: LoopRun, stepID: string, index: number) => {
  const state = stepState(run, stepID, index)
  return { label: STEP_STATE_LABEL[state], tone: STEP_STATE_TONE[state] }
}

/** One-line canvas summary of the configured trigger. */
export const triggerSummary = (draft: TriggerDraft) => {
  if (draft.kind === "cron") return draft.cronExpression.trim() ? `Cron ${draft.cronExpression.trim()}` : "Cron · not set"
  if (draft.kind === "file-change") {
    const count = parseEventPaths(draft.eventPaths).length
    return count ? `On file change · ${count} path${count === 1 ? "" : "s"}` : "On file change · not set"
  }
  if (draft.kind === "session-end") return "On session end"
  return `Every ${draft.interval || "Not set"}`
}
