import type { Panel } from "../panel"

/** Characters a select row shows: its width less the margin column, the two-column marker and the scroll column. */
export function rowChars(listWidth: number) {
  return Math.max(1, listWidth - 4)
}

/** Characters one row of a panel's list column holds: the 34% share (at least 24) `openPanel` gives it. */
export function listChars(panelWidth: number) {
  return rowChars(Math.max(24, Math.floor(panelWidth * 0.34)))
}

/** Fills a panel's list with one cut row per item, and again whenever the panel's width changes. */
export function fillRows(panel: Panel, rows: (chars: number) => string[]) {
  panel.fit("rows", () => {
    const index = panel.list.getSelectedIndex()
    panel.list.options = rows(listChars(panel.width())).map((name) => ({ name, description: "" }))
    panel.list.setSelectedIndex(index)
  })
}
