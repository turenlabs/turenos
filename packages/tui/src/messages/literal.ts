import { display } from "../messages"
import { foldLines, hiddenNote, type Collapse } from "./collapse"

const SHORTENED = "[display shortened]"

function longestRun(text: string) {
  return Array.from(text.matchAll(/`+/g)).reduce((longest, run) => Math.max(longest, run[0].length), 0)
}

/** The backtick fence that holds `text` without any run inside being able to close it. */
export function fenceFor(text: string) {
  return "`".repeat(Math.max(3, longestRun(text) + 1))
}

/** One line of Markdown that shows `text` exactly: a code span whose backtick run no run inside can close. */
export function codeSpan(text: string) {
  const ticks = "`".repeat(longestRun(text) + 1)
  // A span cannot touch a backtick of its own; the renderer keeps the padding space, so only that case pays for it.
  const pad = /^`|`$/.test(text) ? " " : ""
  return `${ticks}${pad}${text}${pad}${ticks}`
}

/**
 * Text as a fenced block that shows every character: the fence is longer than any backtick run inside.
 * `raw` is cut to `limit` here, so the shortening note outside the block is known, not read off the text:
 * output that ends in the marker itself stays inside the block. The fold note stays outside as well.
 */
export function literal(raw: string, limit = 16000, view?: Collapse) {
  const shortened = raw.length > limit
  const folded = foldLines(display(raw.slice(0, limit), limit), view)
  const body = folded.text.trimEnd()
  const fence = fenceFor(body)
  return [
    ...(body ? [`${fence}text\n${body}\n${fence}`] : []),
    ...(folded.hidden ? [hiddenNote(folded.hidden)] : []),
    ...(shortened ? [SHORTENED] : []),
  ].join("\n")
}
