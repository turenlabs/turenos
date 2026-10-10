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

/**
 * The list's rows. The vocabulary is one for the whole list: `enabled` and `disabled` while the longest of them leaves
 * a name twelve letters, `on` and `off` otherwise. Where it is wide, a status wording stays only if the name keeps
 * most of its letters. The state word stays whole and the name gives up its end, with an ellipsis.
 */
export function extensionRows(chars: number, items: Extension[]) {
  const room = (state: string) => chars - 2 - 3 - state.length
  const wide = room("disabled") >= MIN_NAME
  return items.map((item) => {
    const plain = item.enabled ? "enabled" : "disabled"
    const word = !wide
      ? item.enabled
        ? "on"
        : "off"
      : room(stateWord(item)) >= Math.min(item.name.length, MIN_STATUS_NAME)
        ? stateWord(item)
        : plain
    return `${item.enabled ? "●" : "○"} ${label(item.name, Math.max(2, room(word)))} · ${word}`
  })
}
