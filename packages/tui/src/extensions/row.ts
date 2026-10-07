import { listChars } from "../settings/column"
import { label } from "../state"
import type { Extension } from "./types"

/** The state in words. The server's `available` and `disabled` only restate the toggle, so they add nothing. */
export function stateWord(item: Extension) {
  const state = item.enabled ? "enabled" : "disabled"
  const status = label(item.status, 40)
  return status === "available" || status === "disabled" ? state : `${state}, ${status}`
}

const MIN_NAME = 12
const MIN_STATUS_NAME = 14

/** One list row: the state word stays whole and the name gives up its end, with an ellipsis, to fit `width`. */
export function extensionRow(width: number, item: Extension) {
  const room = (state: string) => listChars(width) - 2 - 3 - state.length
  // The status wording needs most of the name's letters to stay; plain enabled or disabled needs twelve; on or off is the last resort.
  const word =
    [stateWord(item), item.enabled ? "enabled" : "disabled"].find(
      (state, index) => room(state) >= (index ? MIN_NAME : Math.min(item.name.length, MIN_STATUS_NAME)),
    ) ?? (item.enabled ? "on" : "off")
  return `${item.enabled ? "●" : "○"} ${label(item.name, Math.max(2, room(word)))} · ${word}`
}
