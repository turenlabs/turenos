import { emit, type Run } from "./context"
import { takes } from "./options"
import { activeIDs, getSession, idArgument, mayBeRunning } from "./state"

export async function stop(run: Run) {
  const sessionID = idArgument(takes("stop", run.positionals, ["session"])[0], "ses_", "The session")
  await getSession(run.connection, sessionID)
  const running = mayBeRunning(await activeIDs(run.connection), sessionID)
  // Core owns cancellation of the entire task tree, including tasks of an idle parent.
  if (running || run.values.tasks) await run.connection.client.sessions.interrupt({ sessionID })
  const done = running ? `interrupted ${sessionID}` : `${sessionID} was not running`
  if (!run.values.tasks) return emit(run, { ok: true, session: sessionID, sessionID, running }, done)
  return emit(
    run,
    { ok: true, session: sessionID, sessionID, running, tasks: { status: "cancelled" } },
    `${done}; unfinished subagent tasks cancelled.`,
  )
}
