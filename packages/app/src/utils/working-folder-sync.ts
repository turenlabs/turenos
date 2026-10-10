import { createWorkingFolders } from "@turenlabs/client/working-folders"
import { pathKey } from "@turenlabs/client/path-key"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

type Project = { worktree: string; expanded: boolean }

/** Shared membership does not replace this GUI's project order or expanded/collapsed state. */
export function reconcileWorkingFolders(projects: Project[], directories: string[]) {
  const wanted = new Set(directories.map(pathKey))
  const kept = projects.filter((project) => wanted.delete(pathKey(project.worktree)))
  return [
    ...kept,
    ...directories
      .filter((directory) => wanted.delete(pathKey(directory)))
      .map((worktree) => ({ worktree, expanded: true })),
  ]
}

/**
 * Serializes GUI membership changes with first-use migration. A failed change reports the error and
 * re-applies the last confirmed membership, so the GUI never keeps a folder the server did not accept.
 * Read or migration failures are reported once per outage; the next success re-arms the report.
 */
export function createWorkingFolderSync(input: {
  folders: ReturnType<typeof createWorkingFolders>
  projects: () => Project[]
  apply: (directories: string[]) => void
  failed: (error: unknown) => void
}) {
  let initialized: Promise<string[] | undefined> | undefined
  let pending = 0
  let applied: string | undefined
  let reported = false
  const initialize = () =>
    (initialized ??= input.folders.migrate(input.projects().map((project) => project.worktree)).catch((error) => {
      initialized = undefined
      throw error
    }))
  const apply = () => {
    const directories = input.folders.current()
    if (pending || !directories) return
    const value = JSON.stringify(directories)
    if (applied === value) return
    applied = value
    input.apply(directories)
  }
  return {
    async refresh() {
      await (initialized ? input.folders.read() : initialize()).catch((error) => {
        if (!reported) input.failed(error)
        reported = true
        throw error
      })
      reported = false
      apply()
    },
    change(directory: string, open: boolean) {
      pending++
      applied = undefined
      return initialize()
        .then(() => (open ? input.folders.open(directory) : input.folders.close(directory)))
        .catch(input.failed)
        .finally(() => {
          pending--
          apply()
        })
    },
  }
}

/** Each logical GUI server uses that server's HTTP endpoint, including its current SSH tunnel. */
export function createServerFolderStores(input: {
  connection: (key: ServerConnection.Key) => ServerConnection.Any | undefined
  projects: (key: ServerConnection.Key) => Project[]
  apply: (key: ServerConnection.Key, directories: string[]) => void
  failed: (error: unknown) => void
  fetch: typeof fetch
}) {
  const stores = new Map<
    ServerConnection.Key,
    {
      http: ServerConnection.HttpBase
      controller: AbortController
      sync: ReturnType<typeof createWorkingFolderSync>
    }
  >()
  return {
    get(key: ServerConnection.Key) {
      const http = input.connection(key)?.http
      if (!http) return
      const current = stores.get(key)
      if (
        current &&
        current.http.url === http.url &&
        current.http.username === http.username &&
        current.http.password === http.password
      )
        return current.sync
      current?.controller.abort()
      const controller = new AbortController()
      const headers = new Headers()
      if (http.password)
        headers.set(
          "Authorization",
          `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}`,
        )
      const folders = createWorkingFolders({
        url: new URL(http.url),
        headers,
        transport: (url, init) =>
          input.fetch(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          }),
      })
      const sync = createWorkingFolderSync({
        folders,
        projects: () => input.projects(key),
        apply: (directories) => {
          if (!controller.signal.aborted) input.apply(key, directories)
        },
        failed: (error) => {
          if (!controller.signal.aborted) input.failed(error)
        },
      })
      stores.set(key, { http: { ...http }, controller, sync })
      return sync
    },
    dispose() {
      stores.forEach((entry) => entry.controller.abort())
      stores.clear()
    },
  }
}
