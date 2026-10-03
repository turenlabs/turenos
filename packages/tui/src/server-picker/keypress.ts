import type { KeyEvent } from "@opentui/core"
import { matchesKey, printableKey } from "../keys"
import { cancel, choose, move, quit, remove } from "./connect"
import { close } from "./close"
import { add } from "./fields"
import { fieldKey } from "./form-keys"
import { say } from "./paint"
import { rescan } from "./scan"
import type { Picker } from "./types"

export function keypress(picker: Picker, key: KeyEvent) {
  if (!picker.view || key.eventType === "release") return
  if (picker.mode === "add" || picker.mode === "password") return fieldKey(picker, key)
  key.preventDefault()
  if (picker.mode === "connecting") {
    if (matchesKey(key, "escape") || matchesKey(key, "c", { ctrl: true })) cancel(picker)
    return
  }
  const character = printableKey(key)
  if (matchesKey(key, "up") || character === "k") return move(picker, -1)
  if (matchesKey(key, "down") || character === "j") return move(picker, 1)
  if (matchesKey(key, "enter")) return choose(picker)
  if (character === "a") return add(picker)
  if (character === "d") return remove(picker)
  if (character === "r") {
    say(picker, "Rescanned.")
    return void rescan(picker)
  }
  if ((matchesKey(key, "escape") || character === "s") && picker.hooks.current()) return close(picker)
  if (character === "q" || matchesKey(key, "c", { ctrl: true })) return quit(picker)
}
