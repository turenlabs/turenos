import type { AutomationWorkflow } from "./api"

export type WorkflowStep = AutomationWorkflow["steps"][number]

/**
 * Builder-local step wrapper. `key` is the stable identity for selection and list
 * rendering; `id` is the user-visible binding reference derived from the step name,
 * so renaming a step changes its `id` while `key` survives.
 */
export type StepDraft = WorkflowStep & { key: string }

let draftSequence = 0
const draftKey = () => `draft_${++draftSequence}`

/** Derives an expression-safe binding ID (server pattern: ^[A-Za-z][A-Za-z0-9_-]*$) from a step name. */
export function deriveStepID(name: string, taken: Iterable<string>) {
  const used = new Set(taken)
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+$/, "") || "step"
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}_${suffix}`)) suffix++
  return `${base}_${suffix}`
}

export function agentDraft(taken: Iterable<string>, name = "Agent task", prompt = ""): StepDraft {
  return { key: draftKey(), id: deriveStepID(name, taken), type: "agent", name, prompt }
}

export function skillDraft(taken: Iterable<string>, name = "Run skill"): StepDraft {
  return { key: draftKey(), id: deriveStepID(name, taken), type: "skill", name, skill: "", instructions: "" }
}

/** Wraps persisted workflow steps for the builder, reusing their stored IDs as stable keys. */
export function toDrafts(steps: readonly WorkflowStep[]): StepDraft[] {
  return steps.map((step) => ({ ...step, key: draftKey() }))
}

/** Strips builder-local keys before persisting. */
export function toWorkflowSteps(drafts: readonly StepDraft[]): WorkflowStep[] {
  return drafts.map(({ key: _key, ...step }) => step)
}

/** Rewrites `{{ steps.<previousID>.… }}` references to a renamed step without touching other bindings. */
export function rewriteBindings(template: string, previousID: string, nextID: string) {
  if (previousID === nextID) return template
  const escaped = previousID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return template.replace(
    new RegExp(`({{\\s*steps\\.)${escaped}((?:\\.[A-Za-z][A-Za-z0-9_-]*)+\\s*}})`, "g"),
    `$1${nextID}$2`,
  )
}

/**
 * Renames one step and re-derives its binding ID, rewriting every template that
 * referenced the old ID so existing bindings keep resolving after the rename.
 */
export function renameStep(steps: readonly StepDraft[], key: string, name: string): StepDraft[] {
  const target = steps.find((step) => step.key === key)
  if (!target) return [...steps]
  const nextID = deriveStepID(
    name,
    steps.filter((step) => step.key !== key).map((step) => step.id),
  )
  return steps.map((step) => {
    const rewritten =
      step.type === "agent"
        ? { ...step, prompt: rewriteBindings(step.prompt, target.id, nextID) }
        : { ...step, instructions: rewriteBindings(step.instructions, target.id, nextID) }
    return step.key === key ? { ...rewritten, id: nextID, name } : rewritten
  })
}

/** One-line node summary for the canvas card. */
export function stepSummary(step: StepDraft) {
  if (step.type === "skill") return step.skill || "Choose a skill"
  const line = step.prompt.split("\n").find((value) => value.trim())
  return line?.trim() || "Describe what this step should do"
}
