import { paint, say } from "./paint"
import type { Picker } from "./types"

export async function rescan(picker: Picker) {
  const current = picker.hooks.current()?.target
  // A server opened by URL is not saved; keep it listed for this run so switching back stays possible.
  if (current?.kind === "url" && !current.saved) picker.visited.set(current.id, current)
  const id = picker.entries[picker.selected]?.target.id ?? current?.id
  const next = await picker.servers.scan()
  if (!picker.view) return
  picker.entries = [
    ...[...picker.visited.values()].map((target) => ({
      target,
      group: "Opened this session" as const,
      detail: target.url,
    })),
    ...next,
  ]
  picker.selected = Math.max(
    0,
    picker.entries.findIndex((entry) => entry.target.id === id),
  )
  if (!picker.view.status.plainText && picker.servers.problems().length)
    say(picker, picker.servers.problems().join(" "), "warning")
  paint(picker)
}
