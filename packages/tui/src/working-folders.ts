import { current, enqueue, fetchState, newStore } from "./working-folders/store"

export function folderContains(folder: string, directory: string) {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(folder)
  const root = (windows ? folder.replace(/\\/g, "/").toLowerCase() : folder).replace(/\/+$/, "")
  const path = windows ? directory.replace(/\\/g, "/").toLowerCase() : directory
  return path === root || path.startsWith(`${root}/`)
}

/** Uses the connection's bounded, abortable transport; never writes during reads. */
export function createWorkingFolders(input: {
  url: URL
  headers: Headers
  transport: (input: URL, init?: RequestInit) => Promise<Response>
}) {
  const store = newStore(input)
  return {
    current: () => current(store),
    async read(): Promise<string[] | undefined> {
      await fetchState(store)
      return current(store)
    },
    open: (directory: string) => enqueue(store, directory, true),
    close: (directory: string) => enqueue(store, directory, false),
  }
}
