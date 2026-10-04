import type { Panel } from "../panel"

/** Columns the panel's heading line may use: the frame less its border and padding. */
export function panelWidth(panel: Panel) {
  const width = panel.dialog.frame.width
  return Math.max(20, (typeof width === "number" && width > 0 ? width : (process.stdout.columns ?? 80)) - 4)
}

/** `lead` and `trail` stay whole; `middle` loses its start (a path) or its end (prose) to fit. */
export function fitHeading(width: number, lead: string, middle: string, trail: string, cut: "start" | "end") {
  const space = width - lead.length - trail.length
  if (middle.length <= space) return `${lead}${middle}${trail}`
  if (space < 2) return `${lead.trimEnd()}${trail}`
  return cut === "start"
    ? `${lead}…${middle.slice(middle.length - space + 1)}${trail}`
    : `${lead}${middle.slice(0, space - 1)}…${trail}`
}

/** A chooser row in the list column: the path loses its start so the status and counts stay visible. */
export function fitRow(width: number, lead: string, path: string, trail: string) {
  const space = Math.max(24, Math.floor(width * 0.34)) - 4 - lead.length - trail.length
  return space < 2
    ? `${lead}${path}${trail}`
    : fitHeading(space + lead.length + trail.length, lead, path, trail, "start")
}
