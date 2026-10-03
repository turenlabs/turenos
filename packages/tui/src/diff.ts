import { StyledText, fg } from "@opentui/core"
import { display } from "./messages"
import type { Session } from "./server"
import { color } from "./theme"

type Revert = NonNullable<Session["revert"]>
export type RevertFile = NonNullable<Revert["files"]>[number]
export type DiffTone = "added" | "removed" | "meta" | "context"
export type DiffLine = { text: string; tone: DiffTone }

// Patch text is untrusted and only loosely bounded at the transport: response
// validation admits up to 2,048 files of 8 MiB each. Bound what is rendered so a
// large revert cannot stall the renderer or bury the confirmation controls.
const MAX_FILES = 50
const MAX_FILE_LINES = 120
const MAX_LINES = 600

const STATUS = { added: "A", modified: "M", deleted: "D" } as const

export const DIFF_COLOR: Record<DiffTone, string> = {
  added: color.added,
  removed: color.removed,
  meta: color.muted,
  context: color.text,
}

/**
 * The one-line answer to "what does confirming this actually touch?". The undo
 * and redo controls restore files immediately, so this is shown before the
 * confirmation rather than behind it.
 */
export function changeSummary(revert: Session["revert"]) {
  const files = revert?.files ?? []
  if (!files.length) return revert?.diff ? "Staged file changes · no per-file detail from the server" : ""
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  return `${files.length} file${files.length === 1 ? "" : "s"} · +${additions} -${deletions}`
}

export function fileLabel(file: RevertFile) {
  return `${STATUS[file.status]} ${clean(file.path, 200)}  +${file.additions} -${file.deletions}`
}

export function diffLines(revert: Session["revert"]): DiffLine[] {
  const files = revert?.files ?? []
  const shown = files.slice(0, MAX_FILES)
  const body = shown.flatMap((file) => [
    { text: fileLabel(file), tone: "meta" as const },
    ...patchLines(file.patch),
    { text: "", tone: "context" as const },
  ])
  const omitted = files.length - shown.length
  return [
    ...body.slice(0, MAX_LINES),
    ...note(body.length > MAX_LINES, "[patch display shortened]"),
    ...note(omitted > 0, `[${omitted} more file(s) not shown]`),
    ...note(!files.length && !!revert?.diff, "[the server sent a combined diff without per-file detail]"),
  ]
}

/** One file's patch, colored, for the full-height Changes view. */
export function styledPatch(patch: string, limit = 4000) {
  const lines = patchLines(patch, limit, 4 * 1024 * 1024)
  return new StyledText(lines.map((line) => fg(DIFF_COLOR[line.tone])(`${line.text}\n`)))
}

function patchLines(patch: string, limit = MAX_FILE_LINES, size = 64000): DiffLine[] {
  const all = display(patch, size).split("\n")
  return [...all.slice(0, limit).map(toLine), ...note(all.length > limit, `[${all.length - limit} more patch line(s)]`)]
}

// `+++`/`---` are file headers, not additions and removals, so they are matched
// before the single-character prefixes.
function toLine(raw: string): DiffLine {
  const text = clean(raw, 2000).replace(/\t/g, "  ")
  if (/^(\+\+\+|---|@@|diff |index |old mode|new mode|similarity |rename )/.test(text)) return { text, tone: "meta" }
  if (text.startsWith("+")) return { text, tone: "added" }
  if (text.startsWith("-")) return { text, tone: "removed" }
  return { text, tone: "context" }
}

function note(when: boolean, text: string): DiffLine[] {
  return when ? [{ text, tone: "meta" }] : []
}

function clean(value: string, limit: number) {
  return display(value, limit).replace(/[\r\n]/g, " ")
}
