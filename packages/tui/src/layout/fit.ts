export type ActionEntry = {
  text: string
  /** A compact form used before the entry is dropped. */
  short?: string
  /** Entries with the lowest rank are dropped first. */
  rank: number
}

const GAP = 2

/**
 * Picks what the action row shows in `width` columns: each entry whole, never cut. Compact forms
 * come first, then the lowest-ranked entries disappear. Returns one text per entry, or undefined
 * for a dropped one.
 */
export function fitActions(entries: readonly ActionEntry[], width: number) {
  const kept: (string | undefined)[] = entries.map((entry) => entry.text)
  const order = entries.map((_, index) => index).sort((a, b) => entries[a]!.rank - entries[b]!.rank)
  for (const index of order) {
    if (fits(kept, width)) break
    const short = entries[index]!.short
    // The low-ranked entry shrinks once; if that is not enough, it goes at its next turn.
    if (short && kept[index] !== short) {
      kept[index] = short
      order.push(index)
      continue
    }
    kept[index] = undefined
  }
  return kept
}

function fits(texts: readonly (string | undefined)[], width: number) {
  const shown = texts.filter((text) => text !== undefined)
  return shown.reduce((sum, text) => sum + text.length, 0) + GAP * Math.max(0, shown.length - 1) <= width
}

/** Applies `fitActions` to the renderables of the action row, hiding every entry that is not shown. */
export function fitActionRow(
  row: readonly (ActionEntry & { node: { visible: boolean; content: unknown }; show: boolean })[],
  width: number,
) {
  const shown = row.filter((entry) => entry.show)
  const texts = fitActions(shown, width)
  for (const entry of row) {
    const text = texts[shown.indexOf(entry)]
    entry.node.visible = text !== undefined
    if (text !== undefined) entry.node.content = text
  }
}
