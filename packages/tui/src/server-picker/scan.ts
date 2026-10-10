import { paint, say } from "./paint"
import type { Picker } from "./types"

export async function rescan(picker: Picker) {
  const current = picker.hooks.current()?.target
  // A server opened by URL is not saved; keep it listed for this run so switching back stays possible.
  if (current?.kind === "url" && !current.saved) picker.visited.set(current.id, current)
  const next = await picker.servers.scan()
  if (!picker.view) return
  // Read after the scan, so a cursor move made while it ran is kept; a freshly opened picker starts on the current server.
  const wanted = picker.focusID ?? picker.entries[picker.selected]?.target.id ?? current?.id
  picker.focusID = undefined
  // A URL naming a discovered local server is that server's own row, so it is not listed twice.
  const opened = [...picker.visited.values()]
  const duplicates = new Map(
    opened.flatMap((target) => {
      const match = next.find((entry) => entry.url === target.url)
      return match ? [[target.id, match.target.id] as const] : []
    }),
  )
  const id = duplicates.get(wanted ?? "") ?? wanted
  picker.entries = [
    ...opened
      .filter((target) => !duplicates.has(target.id))
      .map((target) => ({ target, group: "Opened this session" as const, detail: target.url })),
    ...next,
  ]
  const found = picker.entries.findIndex((entry) => entry.target.id === id)
  // A removed server leaves the cursor where it was, not on the first row.
  picker.selected = found >= 0 ? found : Math.max(0, Math.min(picker.selected, picker.entries.length - 1))
  if (!picker.view.status.plainText && picker.servers.problems().length)
    say(picker, picker.servers.problems().join(" "), "warning")
  paint(picker)
}
