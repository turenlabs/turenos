import { httpStatus } from "../server"
import { inFolder, type Folder } from "../working-folders"
import { clean, emit, type Run } from "./context"
import { usage } from "./errors"
import { listingFolder } from "./folder"
import { requestsText } from "./requests"
import { activeIDs, getSession, idArgument, inBatches, pendingFor, type Pending } from "./state"

export async function pending(run: Run) {
  if (run.positionals.length > 1) throw usage("Usage: turen-tui pending [<session>] [--dir D | --everywhere]")
  const sessionID = run.positionals[0]
  if (sessionID && (run.values.dir !== undefined || run.values.everywhere))
    throw usage("--dir and --everywhere apply only without a session.")
  const folder = sessionID ? undefined : await listingFolder(run)
  const found = sessionID ? await one(run, idArgument(sessionID, "ses_", "The session")) : await everyRunning(run, folder)
  const where = folder ? ` in ${clean(folder.directory, 1000)}` : ""
  return emit(
    run,
    { ...found, ...(sessionID ? {} : { folder: folder?.directory ?? null }) },
    requestsText(found, run.flags) ||
      (sessionID ? "Nothing is pending." : `Nothing is pending in a running session${where}.`),
  )
}

async function one(run: Run, sessionID: string) {
  await getSession(run.connection, sessionID)
  return pendingFor(run.connection, sessionID)
}

/** The requests of every running session, or of those in the folder; a session deleted meanwhile has none. */
async function everyRunning(run: Run, folder: Folder | undefined): Promise<Pending> {
  const running = [...(await activeIDs(run.connection))]
  const shown = folder
    ? (await inBatches(running, 8, (id) => inView(run, folder, id))).filter((id) => id !== undefined)
    : running
  const results = await inBatches(shown, 8, (id) => pendingFor(run.connection, id))
  return {
    permissions: results.flatMap((result) => result.permissions),
    questions: results.flatMap((result) => result.questions),
  }
}

async function inView(run: Run, folder: Folder, sessionID: string) {
  const session = await run.connection.client.sessions.get({ sessionID }).catch((error: unknown) => {
    if (httpStatus(error) === 404) return undefined
    throw error
  })
  return session && inFolder(folder, session) ? sessionID : undefined
}
