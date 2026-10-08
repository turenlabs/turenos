import type { Panel } from "../panel"
import { listChars } from "../settings/column"

/** Columns the panel's heading line may use. */
export function panelWidth(panel: Panel) {
  return Math.max(20, panel.width())
}

/** Hint parts packed into at most two lines that break only between parts; low-value parts go first. */
export function fitHints(width: number, optional: string[], essential: string[]) {
  for (let keep = optional.length; keep >= 0; keep--) {
    const lines = packParts(width, [...optional.slice(0, keep), ...essential])
    if (lines.length <= 2 || keep === 0) return lines.slice(0, 2).join("\n")
  }
  return ""
}

function packParts(width: number, parts: string[]) {
  return parts.reduce<string[]>((lines, part) => {
    const last = lines.at(-1)
    if (last === undefined || last.length + 3 + part.length > width) return [...lines, part]
    return [...lines.slice(0, -1), `${last} · ${part}`]
  }, [])
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
  const space = listChars(width) - lead.length - trail.length
  return space < 2
    ? `${lead}${path}${trail}`
    : fitHeading(space + lead.length + trail.length, lead, path, trail, "start")
}
