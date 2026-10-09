import { httpStatus, type Connection } from "../server"
import type { DashboardState } from "../state"
import { folderContains, inFolder, type Folder } from "./folder"

/**
 * A folder the server can read, with its project, so the session list can include the project's worktrees.
 * Unreadable folders are refused here: they would only fail later, as an HTTP 500 on session creation.
 */
export async function resolveFolder(client: Connection["client"], directory: string): Promise<Folder> {
  const request = { signal: AbortSignal.timeout(10_000) }
  const [location] = await Promise.all([
    client.location.get({ location: { directory } }, request),
    client.files.list({ location: { directory } }, request).catch((error: unknown) => {
      const status = httpStatus(error)
      if (status === undefined || status === 401 || status === 403) throw error
      throw new Error("Folder not found on the server.")
    }),
  ])
  return { directory, project: { id: location.project.id, directory: location.project.directory } }
}

/**
 * Where new work starts: a folder just opened, else the selected session's folder while that session is in view,
 * else the dashboard's folder, else the server's own location.
 */
export function defaultDirectory(state: DashboardState) {
  const snapshot = state.snapshot
  const session = snapshot?.sessions.find((item) => item.id === state.selected)
  const shown = session && (!state.folder || inFolder(state.folder, session)) ? session : undefined
  return state.workingDirectory ?? shown?.location.directory ?? state.folder?.directory ?? snapshot?.location.directory ?? ""
}

/** Open working folders without recent sessions, named under the list; none while the dashboard shows one folder. */
export function emptyWorkingFolders(state: DashboardState) {
  const snapshot = state.snapshot
  if (state.folder || !snapshot) return []
  return (snapshot.workingFolders ?? []).filter(
    (directory) => !snapshot.sessions.some((session) => folderContains(directory, session.location.directory)),
  )
}
