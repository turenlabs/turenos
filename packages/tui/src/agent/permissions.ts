import { emit, waitLine, type Run } from "./context"
import { AgentError, usage } from "./errors"
import { takes } from "./options"
import { idArgument, sessionGone } from "./state"

export async function approve(run: Run) {
  return decide(run, "approve", run.values.always ? "always" : "once")
}

export async function reject(run: Run) {
  return decide(run, "reject", "reject")
}

async function decide(run: Run, verb: string, reply: "once" | "always" | "reject") {
  const names = takes(verb, run.positionals, ["session", "permission-id"])
  const sessionID = idArgument(names[0], "ses_", "The session")
  const requestID = idArgument(names[1], "", "The permission ID")
  const client = run.connection.client
  const request = (await client.permissions.list({ sessionID }).catch(sessionGone(sessionID))).find(
    (item) => item.id === requestID,
  )
  if (!request)
    throw new AgentError(
      `Permission ${requestID} is not pending for session ${sessionID}; it may already be resolved. Check: turen-tui pending ${sessionID}${run.flags}`,
    )
  // The server saves its own rule for "always", so it is offered only when the request names one.
  if (reply === "always" && !request.save?.length)
    throw usage("This request offers no rule to save, so --always does not apply. Approve it once instead.")
  await client.permissions.reply({ sessionID, requestID, reply })
  return emit(
    run,
    { ok: true, session: sessionID, sessionID, permission: requestID, reply },
    [
      `${reply === "reject" ? `rejected ${requestID}` : `approved ${requestID} (${reply})`} · session ${sessionID}`,
      waitLine(run, sessionID),
    ].join("\n"),
  )
}
