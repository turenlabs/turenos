import { emit, type Run } from "./context"
import { takes } from "./options"
import { activeIDs, idArgument } from "./state"

export async function stop(run: Run) {
  const sessionID = idArgument(takes("stop", run.positionals, ["session"])[0], "ses_", "The session")
  const running = (await activeIDs(run.connection)).has(sessionID)
  // Core owns cancellation of the entire task tree, including tasks of an idle parent.
  if (running || run.values.tasks) await run.connection.client.sessions.interrupt({ sessionID })
  const done = running ? `interrupted ${sessionID}` : `${sessionID} was not running`
  if (!run.values.tasks) return emit(run, { ok: true, session: sessionID, running }, done)
  return emit(
    run,
    { ok: true, session: sessionID, running, tasks: { status: "cancelled" } },
    `${done}; unfinished subagent tasks cancelled.`,
  )
}
