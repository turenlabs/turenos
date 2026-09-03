/*
 * Argument previews for the generic tool row — the `Called `X`  key=value …` line.
 *
 * The row is one flex line: title, then the subtitle, then a chip per argument.
 * Every chip carries `flex-shrink: 1` with `min-width: 0` and no basis cap (see
 * basic-tool.css), and flexbox splits the shrink deficit in proportion to each
 * item's natural width. So a single unbounded value takes nearly all of it: a
 * subagent `prompt` of ~2,000 characters measures ~14,000px and leaves the
 * description, `subagent_type` and `run_in_background` at 6-9px each — one
 * clipped glyph apiece. Worse, the survivors differ per row, because each row's
 * prompt is a different length, so the same three arguments render three
 * different ways. Bounding the text bounds the basis, and that is what makes a
 * row read the same whatever the model happened to pass.
 *
 * Nothing here drops an argument silently. A value that cannot be previewed and
 * an argument past the chip budget are both counted into `omitted`, so the row
 * can say it is holding something back instead of just rendering short — a row
 * with unrenderable arguments must not look like a call that took none.
 */

// Keys that read as a human summary of the call. The first one present becomes
// the row's subtitle; the rest stay eligible as argument chips, because a tool
// carrying both `description` and `url` has two facts to show, not one.
const LABEL_KEYS = ["description", "query", "url", "filePath", "path", "pattern", "name"]

export const MAX_ARG_VALUE_LENGTH = 32
export const MAX_ARGS = 3

export type ToolLabel = { key: string; value: string }

export function toolLabel(input: Record<string, unknown> | undefined): ToolLabel | undefined {
  for (const key of LABEL_KEYS) {
    const value = input?.[key]
    if (typeof value === "string" && value.length > 0) return { key, value }
  }
  return undefined
}

function preview(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  if (value === undefined) return undefined
  try {
    // Objects and arrays used to be dropped on the floor, which made a call
    // whose every argument was structured render as a bare title.
    const json = JSON.stringify(value)
    return typeof json === "string" && json.length > 0 ? json : undefined
  } catch {
    // Circular, or a `toJSON` that throws. Reported through `omitted`.
    return undefined
  }
}

export function clampArgValue(value: string) {
  // The chip is `white-space: nowrap`, so newlines already fold to one line;
  // folding them here keeps the character budget and the rendered width in step.
  const flat = value.replace(/\s+/g, " ").trim()
  if (flat.length <= MAX_ARG_VALUE_LENGTH) return flat
  return flat.slice(0, MAX_ARG_VALUE_LENGTH).trimEnd() + "…"
}

export type ToolArgs = {
  args: string[]
  /** Arguments present on the input that no chip is showing. */
  omitted: number
}

export function toolArgs(input: Record<string, unknown> | undefined, labelKey?: string): ToolArgs {
  if (!input) return { args: [], omitted: 0 }
  const args: string[] = []
  let omitted = 0
  for (const [key, value] of Object.entries(input)) {
    if (key === labelKey) continue
    const text = preview(value)
    if (text === undefined || args.length >= MAX_ARGS) {
      omitted++
      continue
    }
    args.push(`${key}=${clampArgValue(text)}`)
  }
  return { args, omitted }
}
