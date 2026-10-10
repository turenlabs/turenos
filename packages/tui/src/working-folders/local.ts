import { pathKey } from "@turenlabs/client/path-key"
import type { createWorkingFolders } from "@turenlabs/client/working-folders"

/** The statuses of a server that has no storage route. An authentication failure is not one of them. */
const NO_STORAGE = new Set([404, 405])

const NOTICE = "This server does not store working folders, so they stay on this client."

/**
 * The shared working folders, kept in memory for the connection when the server cannot store them, so opening and
 * closing a folder still works. The first such failure leaves one notice for the caller to show; later ones are silent.
 * Any other failure, and an invalid folder, still reaches the caller.
 */
export function localFolders(shared: ReturnType<typeof createWorkingFolders>) {
  const kept = { list: undefined as string[] | undefined, announced: false, notice: "" }
  const settle = <T>(list: T) => {
    kept.list = undefined
    return list
  }
  const keep = (error: unknown, change: (list: string[]) => string[]) => {
    const cause = error instanceof Error ? error.cause : undefined
    const status = typeof cause === "object" && cause !== null && "status" in cause ? Number(cause.status) : 0
    if (!NO_STORAGE.has(status)) throw error
    kept.list = change(kept.list ?? shared.current() ?? [])
    if (!kept.announced) kept.notice = NOTICE
    kept.announced = true
    return kept.list.slice()
  }
  return {
    current: () => kept.list?.slice() ?? shared.current(),
    read: () => shared.read().then(settle),
    open: (directory: string) =>
      shared.open(directory).then(
        (list) => settle(list),
        (error) =>
          keep(error, (list) =>
            list.some((item) => pathKey(item) === pathKey(directory)) ? list : [...list, directory],
          ),
      ),
    close: (directory: string) =>
      shared.close(directory).then(
        (list) => settle(list),
        (error) => keep(error, (list) => list.filter((item) => pathKey(item) !== pathKey(directory))),
      ),
    /** The notice the first local fallback left, once; empty afterwards. */
    takeNotice() {
      const notice = kept.notice
      kept.notice = ""
      return notice
    },
  }
}
