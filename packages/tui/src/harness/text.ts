import { display } from "../messages"
import type { Session } from "../server"
import { label } from "../state"
import type { Proposal, State } from "./actions"

export function describe(session: Session, harness: State) {
  const snapshot = harness.snapshot
  const runs = harness.reviewerRuns.toSorted((a, b) => b.timestamp - a.timestamp)
  const counts = Object.entries(
    Object.groupBy(harness.proposals, (proposal) => proposal.status) as Record<string, Proposal[]>,
  ).map(([status, items]) => `${items.length} ${status}`)
  return display(
    [
      `For: ${label(session.title || session.id, 100)}`,
      snapshot
        ? `Snapshot v${snapshot.version} · ${snapshot.status} · from ${snapshot.source} · validation ${snapshot.validation.status}`
        : "No harness snapshot yet.",
      ...(snapshot?.validation.errors.length ? [`Errors: ${snapshot.validation.errors.join("; ")}`] : []),
      "",
      `TOOLS (${snapshot?.tools.length ?? 0})`,
      ...(snapshot?.tools.map(toolLine) ?? []),
      `GUIDANCE (${snapshot?.guidance?.length ?? 0})`,
      ...(snapshot?.guidance?.map(guidanceLine) ?? []),
      "",
      `PROPOSALS${counts.length ? ` · ${counts.join(" · ")}` : " · none yet"}`,
      ...harness.proposals
        .toSorted((a, b) => b.timestamps.created - a.timestamps.created)
        .slice(0, 8)
        .map((proposal) => `  [${proposal.status}] ${label(proposal.summary, 200)}`),
      "",
      `REVIEWER · ${runs.length ? `${runs.length} recent runs` : "no runs yet"}`,
      ...runs
        .slice(0, 5)
        .map(
          (run) =>
            `  ${new Date(run.timestamp).toLocaleString()} · ${run.outcome.replaceAll("_", " ")}${run.detail ? ` — ${label(run.detail, 200)}` : ""}`,
        ),
    ].join("\n"),
    16000,
  )
}

/** The confirmation body, and whether it left out part of the proposal (extra changes or the 16,000-character cut). */
export function proposalText(proposal: Proposal) {
  const text = [
    label(proposal.summary, 1000),
    `Against v${proposal.baseVersion} · ${proposal.status} · validation ${proposal.validation.status}`,
    ...proposal.validation.errors.map((error) => `  ! ${label(error, 300)}`),
    ...proposal.validation.warnings.map((warning) => `  ~ ${label(warning, 300)}`),
    ...(proposal.changes.length ? ["", `CHANGES (${proposal.changes.length})`] : []),
    ...proposal.changes
      .slice(0, 20)
      .map(
        (change) =>
          `  ${change.operation} ${label(change.path, 200)}${change.summary ? ` — ${label(change.summary, 200)}` : ""}`,
      ),
    ...(proposal.changes.length > 20 ? [`  … ${proposal.changes.length - 20} more changes not shown`] : []),
    ...(proposal.tools?.length ? ["", `TOOLS (${proposal.tools.length})`] : []),
    ...(proposal.tools ?? []).map(toolLine),
    ...(proposal.guidance?.length ? ["", `GUIDANCE (${proposal.guidance.length})`] : []),
    ...(proposal.guidance ?? []).map(guidanceLine),
  ].join("\n")
  return { text: display(text, 16000), cut: proposal.changes.length > 20 || text.length > 16000 }
}

function toolLine(tool: NonNullable<Proposal["tools"]>[number]) {
  return `  ${label(tool.name, 64)}${tool.readOnly ? " · read-only" : ""}${tool.enabled ? "" : " · disabled"} — ${label(tool.description, 200)}`
}

function guidanceLine(item: NonNullable<Proposal["guidance"]>[number]) {
  return `  • ${label(item.directive, 300)}${item.appliesTo ? ` (${label(item.appliesTo, 120)})` : ""}`
}
