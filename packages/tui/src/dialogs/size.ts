import type { CliRenderer, SelectRenderable } from "@opentui/core"
import type { ModalState } from "../state"

/** Below this many rows the dialog drops its spacer rows, so the content keeps the screen. */
export const compactRows = 32

/**
 * The size rule for floating dialogs: as tall as their content, up to the screen, so a short
 * dialog does not leave blank rows on a tall terminal. The `height` that callers pass to
 * `dialogs.open` only sizes docked dialogs.
 */
export function sizeFloating(renderer: CliRenderer, modal: ModalState) {
  if (modal.docked || modal.inline || modal.sidebar) return
  const compact = renderer.height < compactRows
  modal.frame.maxHeight = Math.max(1, renderer.height - 2)
  modal.frame.gap = compact ? 0 : 1
  modal.frame.paddingTop = compact ? 0 : 1
  modal.frame.paddingBottom = compact ? 0 : 1
}

/** Rows a floating dialog's list can use: the screen minus the frame, the spacers and `others` rows of fixed content. */
export function listRows(renderer: CliRenderer, others: number) {
  const frame = renderer.height < compactRows ? 2 : 4
  return Math.max(2, renderer.height - 2 - frame - others)
}

/** Gives a list its rows. A numeric height turns flexShrink off, so it is restored: the list shrinks when the screen is short. */
export function setRows(list: SelectRenderable, rows: number) {
  list.height = Math.max(2, rows)
  list.flexShrink = 1
}
