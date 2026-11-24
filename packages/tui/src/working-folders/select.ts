import { httpStatus, type Connection } from "../server"
import type { DashboardState } from "../state"
import { folderKey, inFolder, type Folder } from "./folder"

/** The server answered that it cannot list the folder. */
export class FolderNotFound extends Error {
  constructor() {
    super("Folder not found on the server.")
    this.name = "FolderNotFound"
  }
}

/**
 * A folder the server can read, with its project, so the session list can include the project's worktrees.
 * Unreadable folders are refused here: they would only fail later, as an HTTP 500 on session creation.
 */
export async function resolveFolder(client: Connection["client"], directory: string, local = false): Promise<Folder> {
  const resolved = folderKey(directory, local)
  const request = { signal: AbortSignal.timeout(10_000) }
  const [location] = await Promise.all([
    client.location.get({ location: { directory: resolved } }, request),
    client.files.list({ location: { directory: resolved } }, request).catch((error: unknown) => {
      const status = httpStatus(error)
      if (status === undefined || status === 401 || status === 403) throw error
      throw new FolderNotFound()
    }),
  ])
  return {
    directory: resolved,
    ...(local ? { local: true } : {}),
    project: { id: location.project.id, directory: location.project.directory },
  }
}

/**
 * Where new work starts: a folder just opened, else the selected session's folder while that session is in view,
 * else the dashboard's folder, else the server's own location.
 */
export function defaultDirectory(state: DashboardState) {
  const snapshot = state.snapshot
  const session = snapshot?.sessions.find((item) => item.id === state.selected)
  const shown = session && (!state.folder || inFolder(state.folder, session)) ? session : undefined
  return (
    state.workingDirectory ?? shown?.location.directory ?? state.folder?.directory ?? snapshot?.location.directory ?? ""
  )
}

/** Open working folders without recent sessions, named under the list; none while the dashboard shows one folder. */
export function emptyWorkingFolders(state: DashboardState) {
  const snapshot = state.snapshot
  const folders = snapshot?.workingFolders
  if (state.folder || !snapshot || !folders?.length) return []
  const occupied = new Set<string>()
  for (const directory of new Set(snapshot.sessions.map((session) => session.location.directory))) {
    const path = folderKey(directory)
    occupied.add(path)
    for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
      occupied.add(path.slice(0, end))
      occupied.add(path.slice(0, end + 1)) // POSIX and drive roots retain the slash.
    }
  }
  return folders.filter((directory) => !occupied.has(folderKey(directory)))
}
