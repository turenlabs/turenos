import { checkDirectory } from "../response-validation"
import { clean, emit, isoTime, type Run } from "./context"
import { usage } from "./errors"
import { whole } from "./options"
import { activeIDs, endedState, inBatches, pendingFor, stateOf, type State } from "./state"

export type Summary = {
  id: string
  title: string
  directory: string
  parentID: string | null
  state: State
  updated: string
}

export async function sessions(run: Run) {
  if (run.positionals.length) throw usage("Usage: turen-tui sessions [--dir D] [--limit N] [--all]")
  const limit = whole("limit", run.values.limit, 30, 1, 100)
  const directory = run.values.dir
  if (directory !== undefined) validDirectory(directory)
  const client = run.connection.client
  const [page, running] = await Promise.all([
    client.sessions.list({ limit, order: "desc", archived: run.values.all ? undefined : false, directory }),
    activeIDs(run.connection),
  ])
  // Only a running session can be waiting for input, so only those are asked.
  // The others are asked how their latest turn ended, so a failed or stopped turn does not read as idle.
  const states = new Map(
    await inBatches(
      page.data,
      8,
      async (session) =>
        [
          session.id,
          running.has(session.id)
            ? stateOf(true, await pendingFor(run.connection, session.id))
            : await endedState(run.connection, session.id),
        ] as const,
    ),
  )
  const list = page.data.map(
    (session): Summary => ({
      id: session.id,
      title: session.title,
      directory: session.location.directory,
      parentID: session.parentID ?? null,
      state: states.get(session.id) ?? "idle",
      updated: isoTime(session.time.updated),
    }),
  )
  return emit(run, { sessions: list }, list.length ? list.map(line).join("\n") : "No sessions.")
}

function line(session: Summary) {
  return [
    session.id,
    session.state,
    `updated ${session.updated}`,
    clean(session.directory, 1000),
    `parent ${session.parentID ?? "-"}`,
    clean(session.title, 200),
  ].join(" · ")
}

export function validDirectory(directory: string) {
  try {
    checkDirectory(directory)
  } catch {
    throw usage("--dir must be an absolute directory on the server.")
  }
}
