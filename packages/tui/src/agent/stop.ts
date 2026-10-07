import { httpStatus } from "../server"
import { emit, type Run } from "./context"
import { AgentError } from "./errors"
import { takes } from "./options"
import { activeIDs, activeTaskStatuses, idArgument } from "./state"

export async function stop(run: Run) {
  const sessionID = idArgument(takes("stop", run.positionals, ["session"])[0], "ses_", "The session")
  // An idle session has nothing to interrupt; a turn that ends after this check just makes the call a no-op.
  const running = (await activeIDs(run.connection)).has(sessionID)
  if (running) await run.connection.client.sessions.interrupt({ sessionID })
  const done = running ? `interrupted ${sessionID}` : `${sessionID} was not running`
  const verb = running ? "interrupted" : "was not running"
  if (!run.values.tasks) return emit(run, { ok: true, session: sessionID, running }, done)
  const tasks = await cancelActiveTasks(run, sessionID)
  const summary = `${tasks.cancelled} cancelled, ${tasks.failed} failed, ${tasks.gone} not listed`
  const older = tasks.more ? " Older tasks beyond the first 50 were not checked." : ""
  if (tasks.failed)
    throw new AgentError(`Session ${sessionID} ${verb}; tasks: ${summary}. Run the command again to retry.${older}`)
  return emit(run, { ok: true, session: sessionID, running, tasks }, `${done}; tasks: ${summary}.${older}`)
}

/** The dashboard's /kill semantics: 404 and 409 mean the task finished or changed since the listing. */
async function cancelActiveTasks(run: Run, sessionID: string) {
  const client = run.connection.client
  const listed = await client.sessions.taskList({ sessionID, limit: 50 })
  const active = [...new Map([...listed.data, ...listed.active].map((task) => [task.id, task])).values()].filter(
    (task) => activeTaskStatuses.includes(task.status),
  )
  const outcomes = await Promise.all(
    active.map((task) =>
      client.sessions
        .taskCancel({ sessionID, taskID: task.id, expectedRevision: task.revision })
        .then(() => "cancelled" as const)
        .catch((error: unknown) => {
          const status = httpStatus(error)
          return status === 404 || status === 409 ? ("gone" as const) : ("failed" as const)
        }),
    ),
  )
  const count = (outcome: string) => outcomes.filter((item) => item === outcome).length
  return { cancelled: count("cancelled"), failed: count("failed"), gone: count("gone"), more: !!listed.cursor.next }
}
