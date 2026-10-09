import { pathKey } from "@turenlabs/client/path-key"
import type { Connection } from "../server"
import type { Target } from "../servers/types"

/**
 * The folder a dashboard shows: the sessions in it, and where new work starts. It stays in this client, as the
 * desktop keeps its project selection; opening and closing folders is what other clients share.
 */
export type Folder = { directory: string; project?: { id: string; directory: string } }

export function folderContains(folder: string, directory: string) {
  const root = pathKey(folder)
  const path = pathKey(directory)
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
}

/**
 * A session belongs to the folder when it ran under it, or, when the folder is its project's root, in one of that
 * project's worktrees, which the server keeps elsewhere (the desktop groups them under the project the same way).
 */
export function inFolder(folder: Folder, session: { projectID: string; location: { directory: string } }) {
  if (folderContains(folder.directory, session.location.directory)) return true
  const project = folder.project
  return !!project && session.projectID === project.id && pathKey(project.directory) === pathKey(folder.directory)
}

/** The folder the process was started in; undefined when it was deleted after the shell entered it. */
export function currentFolder() {
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}

/** The folder the client was started in, unless that is the home folder, which shows every folder. */
export function startFolder(cwd: string | undefined, home: string) {
  if (!cwd || pathKey(cwd) === pathKey(home)) return
  return cwd
}

/** Whether a server shares this computer's folders, so the folder the client started in means the same there. */
export function onThisComputer(target: Target) {
  if (target.kind === "ssh") return false
  if (target.kind !== "env" && target.kind !== "url") return true
  const host = new URL(target.url).hostname
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/** The last segment of a folder, for the narrow places that name it. */
export function folderName(directory: string) {
  return directory.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || directory
}

/**
 * A folder's sessions, newest first: by exact folder, and by project for the project's worktrees, so sessions in
 * busier folders cannot crowd them out of one recent page.
 */
export async function folderSessionList(
  client: Connection["client"],
  folder: Folder,
  query: { limit: number; archived?: boolean },
  request?: { signal: AbortSignal },
) {
  const input = { ...query, order: "desc" } as const
  const pages = await Promise.all([
    client.sessions.list({ ...input, directory: folder.directory }, request),
    ...(folder.project ? [client.sessions.list({ ...input, project: folder.project.id }, request)] : []),
  ])
  const sessions = new Map(pages.flatMap((page) => page.data).map((session) => [session.id, session]))
  return [...sessions.values()]
    .filter((session) => inFolder(folder, session))
    .sort((a, b) => b.time.created - a.time.created)
    .slice(0, query.limit)
}
