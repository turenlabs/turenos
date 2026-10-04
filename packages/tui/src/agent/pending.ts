import { emit, type Run } from "./context"
import { usage } from "./errors"
import { requestsText } from "./requests"
import { activeIDs, getSession, idArgument, inBatches, pendingFor, type Pending } from "./state"

export async function pending(run: Run) {
  if (run.positionals.length > 1) throw usage("Usage: turen-tui pending [<session>]")
  const sessionID = run.positionals[0]
  const found = sessionID ? await one(run, idArgument(sessionID, "ses_", "The session")) : await everyRunning(run)
  return emit(
    run,
    found,
    requestsText(found, run.flags) || (sessionID ? "Nothing is pending." : "Nothing is pending in a running session."),
  )
}

async function one(run: Run, sessionID: string) {
  await getSession(run.connection, sessionID)
  return pendingFor(run.connection, sessionID)
}

async function everyRunning(run: Run): Promise<Pending> {
  const results = await inBatches([...(await activeIDs(run.connection))], 8, (id) => pendingFor(run.connection, id))
  return {
    permissions: results.flatMap((result) => result.permissions),
    questions: results.flatMap((result) => result.questions),
  }
}
