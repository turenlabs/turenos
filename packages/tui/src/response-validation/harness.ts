import { array, choice, invalid, numeric, object, optional, string, unique } from "./primitives"

// Only what the harness view displays; patches and tool sources are never rendered.
export function harnessRoute(route: string[], data: unknown) {
  if (route.length === 3) return harnessState(object(data))
  if (route[3] === "proposal" && route[5] !== "apply") return harnessProposal(data)
  return harnessSnapshot(data)
}

function harnessState(state: Record<string, unknown>) {
  optional(state.snapshot, harnessSnapshot)
  unique(array(state.proposals, 128), harnessProposal)
  array(state.reviewerRequests, 32).forEach((value) => string(object(value).request, 4000))
  for (const value of array(state.reviewerRuns, 50)) {
    const run = object(value)
    string(run.reviewerSessionID, 128)
    choice(run.outcome, [
      "unchanged",
      "no_output",
      "unparseable",
      "duplicate",
      "proposed",
      "applied",
      "unsafe",
      "failed",
      "timeout",
    ])
    optional(run.detail, (value) => string(value, 4000))
    numeric(run.timestamp)
  }
}

function harnessSnapshot(value: unknown) {
  const item = object(value)
  if (!Number.isSafeInteger(numeric(item.version)) || Number(item.version) < 1) invalid("harness version")
  choice(item.status, ["active", "superseded", "rolledBack"])
  choice(item.source, ["default", "proposal", "reload", "rollback"])
  harnessContent(item)
}

function harnessProposal(value: unknown) {
  const item = object(value)
  string(item.id, 128)
  if (!Number.isSafeInteger(numeric(item.baseVersion)) || Number(item.baseVersion) < 0) invalid("harness base version")
  string(item.summary, 4000)
  choice(item.status, ["draft", "pending", "approved", "applied", "rejected", "failed"])
  optional(item.appliedVersion, numeric)
  harnessContent(item)
}

function harnessContent(item: Record<string, unknown>) {
  for (const value of array(item.changes ?? [], 128)) {
    const change = object(value)
    string(change.path, 4096)
    choice(change.operation, ["add", "modify", "delete"])
    optional(change.summary, (value) => string(value, 4000))
  }
  for (const value of array(item.tools ?? [], 64)) {
    const tool = object(value)
    string(tool.name, 64)
    string(tool.description, 2000)
    if (typeof tool.enabled !== "boolean" || typeof tool.readOnly !== "boolean") invalid("harness tool")
  }
  for (const value of array(item.guidance ?? [], 24)) {
    const guidance = object(value)
    string(guidance.directive, 600)
    optional(guidance.appliesTo, (value) => string(value, 4096))
  }
  const validation = object(item.validation)
  choice(validation.status, ["pending", "passed", "failed"])
  for (const key of ["errors", "warnings"]) array(validation[key], 64).forEach((value) => string(value, 2000))
}
