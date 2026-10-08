import { TextRenderable } from "@opentui/core"
import { label, sessionTitle } from "../state"
import { color } from "../theme"
import { sessionAgent } from "../chrome"
import { fitHeading } from "../changes/heading"
import { sessionRows } from "../session-list"
import { folderContains } from "../working-folders"
import type { Session } from "../server"
import type { Switcher } from "./switcher-state"

export function inFolders(s: Switcher, directory: string) {
  const folders = s.ctx.state.snapshot?.workingFolders
  return folders === undefined || folders.some((folder) => folderContains(folder, directory))
}

/** Columns inside the dialog frame: laid out once it has a size, the share of the screen before that. */
export function innerWidth(s: Switcher) {
  const width = s.dialog.frame.width
  return (width > 1 ? width : Math.floor(Math.min(160, s.ctx.renderer.width * 0.95))) - 4
}

export function describe(s: Switcher) {
  const { state } = s.ctx
  if (state.closed || state.modal !== s.dialog || s.details.isDestroyed) return
  const session = s.matches[s.selected]
  // The title is already the selected row; the rest of the session's identity sits under the list at every size.
  s.details.content = session
    ? `${fitHeading(innerWidth(s), "", label(session.location.directory, 256), "", "start")}\n${detailLine(s, session)}`
    : ""
}

/** The state in words (the row only has a marker), the agent the session ran when it is known, and its ID. */
function detailLine(s: Switcher, session: Session) {
  const { state } = s.ctx
  const agent = sessionAgent(state, session)
  return [
    needsInput(s, session) ? "needs input" : Object.hasOwn(state.snapshot?.active ?? {}, session.id) ? "running" : "",
    agent ? `agent ${label(agent)}` : "",
    session.id,
  ]
    .filter(Boolean)
    .join(" · ")
}

function needsInput(s: Switcher, session: Session) {
  return !!s.ctx.state.snapshot?.needsInput?.includes(session.id)
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
  const markers = `${session.id === state.selected ? " · current" : ""}${actions.hasDraft(session.id) ? " [draft]" : ""}${session.time.archived !== undefined && s.scope !== "archived" ? " [archived]" : ""}`
  // The sidebar's convention: `?` (needs input) or `*` (running) leads the title.
  const mark = needsInput(s, session) ? "? " : Object.hasOwn(state.snapshot?.active ?? {}, session.id) ? "* " : ""
  row.content = `${index === s.selected ? "▶ " : "  "}${mark}${sessionTitle(session.title || "Untitled session", 150)}${session.parentID ? " [child]" : ""}${markers}`
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
  // The folder of the session on screen leads, so the list opens at the session the reader is in.
  const here = s.sessions.find((session) => session.id === s.ctx.state.selected)?.location
  const lead = (session: Session) =>
    here && session.location.directory === here.directory && session.location.workspaceID === here.workspaceID ? 0 : 1
  return [...found].sort(
    (a, b) =>
      lead(a) - lead(b) ||
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
  // One project's heading adds nothing above its own rows.
  const grouped =
    new Set(s.matches.map((session) => `${session.location.directory}\0${session.location.workspaceID}`)).size > 1
  s.rows = s.matches.map((session, index) => {
    const previous = s.matches[index - 1]
    if (
      grouped &&
      (!previous ||
        previous.location.directory !== session.location.directory ||
        previous.location.workspaceID !== session.location.workspaceID)
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
