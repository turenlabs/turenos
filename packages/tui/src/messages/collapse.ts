/** What a collapsed body or diff leaves visible, and whether the reader asked for all of it. */
export type Collapse = { rich: boolean; expanded: boolean }

/** A tool body longer than this many lines is collapsed. */
const BODY_LIMIT = 6
const BODY_KEEP = 4
/** A diff is allowed more room, because its lines are the point of showing it. */
export const DIFF_LIMIT = 20
export const DIFF_KEEP = 16

/** The note that replaces hidden lines; "Ctrl+O" is the expand key. */
export function hiddenNote(hidden: number) {
  return `… +${hidden} lines · Ctrl+O expands`
}

/** The first lines of a long text and a note counting the rest; short text and an expanded view are unchanged. */
export function collapseText(text: string, view: Collapse) {
  if (!view.rich || view.expanded) return text
  const lines = text.trimEnd().split("\n")
  if (lines.length <= BODY_LIMIT) return text
  const kept = lines.slice(0, BODY_KEEP)
  // A fence opened in the kept lines would swallow the note and everything after it.
  const open = kept.filter((line) => /^\s*(```|~~~)/.test(line)).length % 2 === 1
  return [...kept, ...(open ? ["```"] : []), hiddenNote(lines.length - BODY_KEEP)].join("\n")
}

/** The rows that stay visible and how many were hidden. */
export function collapseRows(rows: string[], view: Collapse) {
  if (!view.rich || view.expanded || rows.length <= DIFF_LIMIT) return { rows, hidden: 0 }
  return { rows: rows.slice(0, DIFF_KEEP), hidden: rows.length - DIFF_KEEP }
}
