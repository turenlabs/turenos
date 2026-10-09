import { clean, emit, isoTime, type Run } from "./context"
import { usage } from "./errors"
import { whole } from "./options"
import { activeIDs, endedState, inBatches, pendingFor, stateOf, type State } from "./state"
import { folderSessionList } from "../working-folders"
import { listingFolder } from "./folder"

export type Summary = {
  id: string
  sessionID: string
  title: string
  directory: string
  parentID: string | null
  state: State
  updated: string
}

/** The sessions of the folder the command runs in (or `--dir`), else of every folder, newest first. */
export async function sessions(run: Run) {
  if (run.positionals.length)
    throw usage("Usage: turen-tui sessions [--dir D | --everywhere] [--limit N] [--all]")
  const limit = whole("limit", run.values.limit, 30, 1, 100)
  const archived = run.values.all ? undefined : false
  const client = run.connection.client
  const folder = await listingFolder(run)
  const [found, running] = await Promise.all([
    folder
      ? folderSessionList(client, folder, { limit, archived })
      : client.sessions.list({ limit, order: "desc", archived }).then((page) => page.data),
    activeIDs(run.connection),
  ])
  // Only a running session can be waiting for input, so only those are asked.
  // The others are asked how their latest turn ended, so a failed or stopped turn does not read as idle.
  const states = new Map(
    await inBatches(
      found,
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
  const list = found.map(
    (session): Summary => ({
      id: session.id,
      sessionID: session.id,
      title: session.title,
      directory: session.location.directory,
      parentID: session.parentID ?? null,
      state: states.get(session.id) ?? "idle",
      updated: isoTime(session.time.updated),
    }),
  )
  const where = folder ? clean(folder.directory, 1000) : undefined
  return emit(
    run,
    { folder: folder?.directory ?? null, sessions: list },
    [
      // A listing narrowed to one folder names it, with how to widen it.
      ...(where ? [`folder ${where} · --everywhere lists every folder`] : []),
      ...(list.length ? list.map(line) : [where ? "No sessions in this folder." : "No sessions."]),
    ].join("\n"),
  )
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
