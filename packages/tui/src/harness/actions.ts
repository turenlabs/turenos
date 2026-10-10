import type { SessionsStateOutput } from "@turenlabs/client"
import type { Connection } from "../server"
import { label } from "../state"

export type State = SessionsStateOutput
export type Proposal = State["proposals"][number]
export type Action =
  | { kind: "approve" | "apply" | "reject"; proposal: Proposal; snapshot?: number }
  | { kind: "reload"; version: number }
  | { kind: "rollback"; version: number }

export function available(harness: State): Action[] {
  return [
    ...harness.proposals.flatMap((proposal): Action[] =>
      proposal.status === "approved"
        ? [
            { kind: "apply", proposal, snapshot: harness.snapshot?.version },
            { kind: "reject", proposal, snapshot: harness.snapshot?.version },
          ]
        : proposal.status === "pending" || proposal.status === "draft"
          ? [
              { kind: "approve", proposal, snapshot: harness.snapshot?.version },
              { kind: "reject", proposal, snapshot: harness.snapshot?.version },
            ]
          : [],
    ),
    ...(harness.snapshot ? [{ kind: "reload" as const, version: harness.snapshot.version }] : []),
    ...(harness.snapshot && harness.snapshot.version > 1
      ? [{ kind: "rollback" as const, version: harness.snapshot.version }]
      : []),
  ]
}

export function title(action: Action) {
  if (action.kind === "reload") return `Reload harness (v${action.version})`
  if (action.kind === "rollback") return `Roll back to v${action.version - 1}`
  const verb = action.kind === "approve" ? "Approve and apply" : action.kind === "apply" ? "Apply" : "Reject"
  return `${verb}: ${label(action.proposal.summary, 80)}`
}

/** True once the server shows the outcome the action asked for. */
export function done(action: Action, harness: State) {
  if ("proposal" in action) {
    const status = harness.proposals.find((item) => item.id === action.proposal.id)?.status
    return action.kind === "reject" ? status === "rejected" : status === "applied"
  }
  return !!harness.snapshot && harness.snapshot.version > action.version && harness.snapshot.source === action.kind
}

/** True while the proposal and snapshot are still exactly what the user reviewed. */
export function still(action: Action, harness: State) {
  if (!("proposal" in action)) return harness.snapshot?.version === action.version
  const current = harness.proposals.find((item) => item.id === action.proposal.id)
  return (
    ["draft", "pending", "approved"].includes(current?.status ?? "") &&
    current?.timestamps.updated === action.proposal.timestamps.updated &&
    current?.baseVersion === action.proposal.baseVersion &&
    harness.snapshot?.version === action.snapshot
  )
}

export async function apply(connection: Connection, sessionID: string, action: Action, harness: State) {
  if (action.kind === "reload") return connection.client.sessions.reload({ sessionID, baseVersion: action.version })
  if (action.kind === "rollback")
    return connection.client.sessions.rollback({
      sessionID,
      baseVersion: action.version,
      version: action.version - 1,
    })
  const proposalID = action.proposal.id
  if (action.kind === "reject") return connection.client.sessions.proposalReject({ sessionID, proposalID })
  // Approval and application are separate server steps; an approved proposal only needs applying.
  if (harness.proposals.find((item) => item.id === proposalID)?.status !== "approved")
    // A retry after a refused apply compares against the approval this write made, not the earlier review.
    action.proposal = await connection.client.sessions.proposalStatus({ sessionID, proposalID, status: "approved" })
  return connection.client.sessions.proposalApply({ sessionID, proposalID })
}
