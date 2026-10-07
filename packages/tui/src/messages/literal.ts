import { foldLines, hiddenNote, type Collapse } from "./collapse"

const SHORTENED = "[display shortened]"

function longestRun(text: string) {
  return Array.from(text.matchAll(/`+/g)).reduce((longest, run) => Math.max(longest, run[0].length), 0)
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
 * The `display` shortening marker and the fold note stay outside, so they read as notes, not as output.
 */
export function literal(text: string, view?: Collapse) {
  const shortened = text.endsWith(`\n${SHORTENED}`)
  const folded = foldLines(shortened ? text.slice(0, -SHORTENED.length - 1) : text, view)
  const body = folded.text.trimEnd()
  const fence = "`".repeat(Math.max(3, longestRun(body) + 1))
  return [
    ...(body ? [`${fence}text\n${body}\n${fence}`] : []),
    ...(folded.hidden ? [hiddenNote(folded.hidden)] : []),
    ...(shortened ? [SHORTENED] : []),
  ].join("\n")
}
