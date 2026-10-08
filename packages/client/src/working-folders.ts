import { current, enqueue, fetchState, migrate, newStore } from "./working-folders/store"

/** One revision-guarded folder list on the session server, shared by web, desktop and terminal clients. */
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
    /** Seeds legacy GUI folders only when no shared record exists; concurrent creation wins. */
    migrate: (directories: string[]) => migrate(store, directories),
    open: (directory: string) => enqueue(store, directory, true),
    close: (directory: string) => enqueue(store, directory, false),
  }
}
