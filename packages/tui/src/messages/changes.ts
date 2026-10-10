import { display } from "../messages"
import { collapseRows, hiddenNote, type Collapse } from "./collapse"
import type { ToolPart } from "./tool"

type FileChange = { file: string; patch: string; additions?: number; deletions?: number; status?: string }

// A diff the reader scrolls past is bounded like any other tool text.
const ROW_LIMIT = 400

/**
 * An edit, apply_patch or new-file write as a compact unified diff inside a fenced block, keeping the
 * `+`/`-` prefixes so it reads without colour. Uses only the part's own data (`structured.files[].patch`,
 * or the `write` input); undefined when it carries neither, which leaves the result text in place.
 */
export function changeDiff(part: ToolPart, view: Collapse) {
  const rows = changeRows(part)
  if (!rows?.length) return undefined
  const shown = collapseRows(rows, view)
  const fence = fenceFor(shown.rows)
  if (!fence) return undefined
  const block = [`${fence}diff`, ...shown.rows, fence].join("\n")
  return shown.hidden ? `${block}\n${hiddenNote(shown.hidden)}` : block
}

function changeRows(part: ToolPart) {
  const state = part.state
  if (state.status !== "completed") return undefined
  const structured: Record<string, unknown> = state.structured ?? {}
  const files = fileChanges(structured.files)
  if (files?.length) return bound(files.flatMap(fileRows))
  return part.name === "write" ? bound(newFileRows(structured, state.input)) : undefined
}

function fileChanges(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item): FileChange[] => {
    if (typeof item !== "object" || item === null) return []
    const file = "file" in item ? item.file : undefined
    const patch = "patch" in item ? item.patch : undefined
    if (typeof file !== "string" || typeof patch !== "string") return []
    return [
      {
        file,
        patch,
        additions: "additions" in item && typeof item.additions === "number" ? item.additions : undefined,
        deletions: "deletions" in item && typeof item.deletions === "number" ? item.deletions : undefined,
        status: "status" in item && typeof item.status === "string" ? item.status : undefined,
      },
    ]
  })
}

/** The path, its change counts, and the hunks without the `Index:`/`---`/`+++` file header. */
function fileRows(change: FileChange) {
  const lines = display(change.patch.slice(0, 60_000), 60_000).split("\n")
  const start = lines.findIndex((line) => line.startsWith("@@"))
  const hunks = start < 0 ? [] : lines.slice(start)
  while (hunks.at(-1) === "") hunks.pop()
  return [heading(change.file, change.status, change.additions, change.deletions), ...hunks]
}

function newFileRows(structured: Record<string, unknown>, input: Record<string, unknown>) {
  // An overwrite has no before text on the part, so only a created file can be shown as added lines.
  if (structured.existed !== false || typeof input.content !== "string") return []
  const lines = input.content.slice(0, 60_000).split("\n")
  if (lines.at(-1) === "") lines.pop()
  const path =
    typeof structured.resource === "string" ? structured.resource : typeof input.path === "string" ? input.path : ""
  return [heading(path, "added", lines.length, 0), ...lines.map((line) => `+${display(line)}`)]
}

function heading(file: string, status?: string, additions?: number, deletions?: number) {
  const counts = [additions ? `+${additions}` : "", deletions ? `-${deletions}` : ""].filter(Boolean).join(" ")
  const notes = [status === "added" ? "new file" : status === "deleted" ? "deleted" : "", counts].filter(Boolean)
  return `${display(file, 300).replace(/\s+/g, " ")}${notes.length ? ` (${notes.join(", ")})` : ""}`
}

function bound(rows: string[]) {
  return rows.length > ROW_LIMIT ? [...rows.slice(0, ROW_LIMIT), "[display shortened]"] : rows
}

/** A fence the rows cannot close early, or undefined when they contain both kinds. */
function fenceFor(rows: string[]) {
  const text = rows.join("\n")
  if (!text.includes("```")) return "```"
  return text.includes("~~~") ? undefined : "~~~"
}
