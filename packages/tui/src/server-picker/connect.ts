import { PasswordRequired, type Target } from "../servers"
import { close } from "./close"
import { password } from "./fields"
import { paint, say } from "./paint"
import { rescan } from "./scan"
import type { Picker } from "./types"

export function move(picker: Picker, delta: number) {
  if (!picker.entries.length) return
  picker.selected = (picker.selected + delta + picker.entries.length) % picker.entries.length
  picker.armed = undefined
  paint(picker)
}

export function choose(picker: Picker) {
  const entry = picker.entries[picker.selected]
  if (!entry) return
  const current = picker.hooks.current()
  if (current?.target.id === entry.target.id && current.connected) return close(picker)
  const drafts = picker.hooks.drafts()
  if (drafts && !confirmed(picker, "switch", entry.target.id))
    return say(
      picker,
      `${drafts} unsent draft${drafts === 1 ? "" : "s"} on ${current?.target.name ?? "this server"} will be discarded. Press Enter again to switch.`,
      "warning",
    )
  void connect(picker, entry.target)
}

export async function connect(picker: Picker, target: Target) {
  picker.controller?.abort()
  const attempt = new AbortController()
  picker.controller = attempt
  picker.mode = "connecting"
  say(picker, `Connecting to ${target.name}…`)
  paint(picker)
  try {
    await picker.hooks.connect(target, attempt.signal, (text) => {
      if (!attempt.signal.aborted) say(picker, text)
    })
    if (!attempt.signal.aborted) close(picker)
  } catch (error) {
    if (attempt.signal.aborted || !picker.view) return
    picker.mode = "list"
    if (error instanceof PasswordRequired) return password(picker, target)
    say(picker, error instanceof Error ? error.message : "Could not connect.", "error")
    paint(picker)
  }
}

export function cancel(picker: Picker) {
  picker.controller?.abort()
  picker.mode = "list"
  say(picker, "Connection cancelled.")
  paint(picker)
}

export function remove(picker: Picker) {
  const target = picker.entries[picker.selected]?.target
  if (!target || !("saved" in target) || !target.saved)
    return say(
      picker,
      "Only saved servers can be removed. Local and TurenOS Desktop servers are discovered.",
      "warning",
    )
  if (picker.hooks.current()?.target.id === target.id)
    return say(picker, "Switch to another server before removing this one.", "warning")
  if (!confirmed(picker, "remove", target.id)) return say(picker, `Press d again to remove ${target.name}.`, "warning")
  void picker.servers.remove(target).then(
    () => {
      say(picker, `Removed ${target.name}.`)
      return rescan(picker)
    },
    (error: unknown) => say(picker, error instanceof Error ? error.message : "Could not remove the server.", "error"),
  )
}

export function quit(picker: Picker) {
  const drafts = picker.hooks.drafts()
  if (drafts && !confirmed(picker, "quit", ""))
    return say(picker, `${drafts} unsent drafts will be lost. Press q again to quit.`, "warning")
  picker.hooks.quit()
}

function confirmed(picker: Picker, action: "switch" | "remove" | "quit", id: string) {
  if (picker.armed?.action === action && picker.armed.id === id && picker.armed.until > Date.now()) {
    picker.armed = undefined
    return true
  }
  picker.armed = { action, id, until: Date.now() + 5000 }
  return false
}
