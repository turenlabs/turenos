import { TextRenderable } from "@opentui/core"
import { label } from "../state"
import { color } from "../theme"
import { sessionRows } from "../session-list"
import { folderContains } from "../working-folders"
import type { Switcher } from "./switcher-state"

export function inFolders(s: Switcher, directory: string) {
  const folders = s.ctx.state.snapshot?.workingFolders
  return folders === undefined || folders.some((folder) => folderContains(folder, directory))
}

export function describe(s: Switcher) {
  const { state, renderer } = s.ctx
  if (state.closed || state.modal !== s.dialog || s.details.isDestroyed) return
  s.details.visible = !s.sidebar && renderer.width >= 110 && renderer.height >= 32
  const session = s.matches[s.selected]
  s.details.content = session
    ? `${label(session.title || "Untitled session", 256)}\n${label(session.location.directory, 256)}\n${label(session.agent ?? "Default agent")} · ${session.id}`
    : ""
}

export function reveal(s: Switcher) {
  // Include project headings even before replacement rows have been laid out.
  const top = s.offsets[s.selected] ?? 0
  if (top < s.dialog.form.scrollTop) s.dialog.form.scrollTo(top)
  if (top + 1 > s.dialog.form.scrollTop + s.dialog.form.viewport.height)
    s.dialog.form.scrollTo(top + 1 - s.dialog.form.viewport.height)
}

export function paint(s: Switcher, index: number) {
  const { state, actions } = s.ctx
  const session = s.matches[index]
  const row = s.rows[index]
  if (!session || !row) return
  row.bg = index === s.selected ? color.accent : color.panel
  row.fg = index === s.selected ? color.bg : color.text
  const markers = `${session.id === state.selected ? " | current" : ""}${Object.hasOwn(state.snapshot?.active ?? {}, session.id) ? " *" : ""}${actions.hasDraft(session.id) ? " [draft]" : ""}${session.time.archived !== undefined && s.scope !== "archived" ? " [archived]" : ""}`
  row.content = `${index === s.selected ? "> " : "  "}${label(session.title || "Untitled session", 150)}${session.parentID ? " [child]" : ""}${markers}`
}

/** Sessions the current scope and query select, grouped by project folder. */
export function rank(s: Switcher) {
  const terms = s.query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const found =
    s.scope !== "recent"
      ? s.remote
      : s.sessions.filter((session) => {
          if (!terms.length && session.parentID) return false
          const text =
            `${session.title} ${session.agent ?? ""} ${session.location.directory} ${session.id}`.toLowerCase()
          return terms.every((term) => text.includes(term))
        })
  return [...found].sort(
    (a, b) =>
      a.location.directory.localeCompare(b.location.directory, undefined, { numeric: true }) ||
      (a.location.workspaceID ?? "").localeCompare(b.location.workspaceID ?? ""),
  )
}

/** Replaces the result rows and project headings, recording each row's scroll offset. */
export function rebuildRows(s: Switcher, open: (index: number) => void) {
  const groups = new Map(sessionRows(s.matches, {}).map((row) => [row.id, row]))
  s.rows.forEach((row) => row.destroyRecursively())
  s.headings.forEach((heading) => heading.destroyRecursively())
  s.headings = []
  s.offsets = []
  let offset = 0
  s.rows = s.matches.map((session, index) => {
    const previous = s.matches[index - 1]
    if (
      !previous ||
      previous.location.directory !== session.location.directory ||
      previous.location.workspaceID !== session.location.workspaceID
    ) {
      const heading = new TextRenderable(s.ctx.renderer, {
        content: groups.get(session.id)!.groupLabel,
        fg: color.muted,
        height: 1,
        flexShrink: 0,
        width: "100%",
        wrapMode: "none",
        truncate: true,
      })
      s.dialog.form.add(heading)
      s.headings.push(heading)
      offset++
    }
    s.offsets.push(offset++)
    const row = new TextRenderable(s.ctx.renderer, {
      height: 1,
      flexShrink: 0,
      width: "100%",
      wrapMode: "none",
      truncate: true,
      onMouseDown: (event) => {
        event.preventDefault()
        if (event.button === 0) open(index)
      },
    })
    s.dialog.form.add(row)
    return row
  })
}
