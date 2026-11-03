import { randomUUID } from "node:crypto"
import { renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Publishes the desktop's local server for clients without exposing a partially written credential. */
export function createDesktopAttach(directory: string, warn: (message: string) => void) {
  const file = join(directory, "attach.json")
  const remove = (path: string) => {
    try {
      rmSync(path, { force: true })
    } catch {
      warn("Could not remove the desktop server attach record")
    }
  }
  const clear = () => remove(file)
  // A previous desktop process may have exited without completing shutdown.
  clear()

  return {
    publish(connection: { url: string; username: string; password: string }) {
      const temporary = join(directory, `.attach-${process.pid}-${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, ...connection }), {
          flag: "wx",
          mode: 0o600,
        })
        renameSync(temporary, file)
      } catch {
        // Discovery is optional: a read-only directory must not stop the desktop.
        warn("Could not publish the desktop server attach record")
      } finally {
        remove(temporary)
      }
    },
    clear,
  }
}
