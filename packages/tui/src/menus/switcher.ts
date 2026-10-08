import { RenderableEvents, type KeyEvent } from "@opentui/core"
import { errorText, type Session } from "../server"
import { matchesKey } from "../keys"
import type { DashboardState } from "../state"
import { color } from "../theme"
import type { MenuContext } from "./context"
import { fitHints } from "../changes/heading"
import { openByID } from "./open-by-id"
import { describe, inFolders, innerWidth, paint, rank, rebuildRows, reveal } from "./switcher-rows"
import type { Scope, Switcher } from "./switcher-state"
import { buildSwitcherView } from "./switcher-view"

export function openSwitcher(ctx: MenuContext, initialScope: Scope = "recent", search = "") {
  const { state, dialogs } = ctx
  if (!dialogs.navigate()) return
  const sessions = loadedSessions(state)
  const dialog = dialogs.open("Switch session", false, 32)
  if (!dialog) return
  dialog.frame.maxWidth = 160
  dialog.frame.maxHeight = undefined
  const view = buildSwitcherView(ctx, dialog, {
    scope: (value) => changeScope(s, value),
    create: () => create(s),
  })
  const s: Switcher = {
    ctx,
    dialog,
    sessions,
    ...view,
    scope: initialScope,
    remote: [],
    cursors: {},
    loading: false,
    failure: "",
    version: 0,
    searchTimer: undefined,
    controller: undefined,
    matches: sessions,
    // The session before this one is highlighted, so Enter goes back to it; the current session leads the list.
    selected: previousIndex(state, sessions),
    rows: [],
    headings: [],
    offsets: [],
  }
  const resize = () => describe(s)
  ctx.renderer.on("resize", resize)
  fitOnResize(s)
  s.details.once(RenderableEvents.DESTROYED, () => ctx.renderer.off("resize", resize))
  dialog.submit = () => submit(s)
  s.query.on("input", () => onInput(s))
  dialog.box.once("destroyed", () => {
    ++s.version
    if (s.searchTimer) clearTimeout(s.searchTimer)
    s.controller?.abort()
  })
  // Only results scroll; typing stays in the fixed search field throughout browsing.
  dialog.form.onMouseDown = (event) => event.preventDefault()
  dialog.form.content.onMouse = (event) => {
    if (event.type !== "scroll" || !event.scroll || !["up", "down"].includes(event.scroll.direction)) return
    event.preventDefault()
    event.stopPropagation()
    choose(s, s.selected + (event.scroll.direction === "up" ? -3 : 3))
  }
  dialog.form.content.on("resize", () => reveal(s))
  dialog.form.viewport.on("resize", () => reveal(s))
  dialog.key = (key) => onKey(s, key)
  s.query.value = search
  changeScope(s, initialScope)
  s.query.focus()
}

/** Hints and details are cut to the laid-out width, which changes after the resize event. */
function fitOnResize(s: Switcher) {
  let width = 0
  s.dialog.frame.onSizeChange = () => {
    // A height change alone must not replace a failure message shown in the hint.
    if (s.dialog.frame.width === width) return
    width = s.dialog.frame.width
    s.dialog.error.content = hint(s)
    describe(s)
  }
}

function previousIndex(state: DashboardState, sessions: Session[]) {
  return Math.max(
    0,
    sessions.findIndex((session) => session.id === state.previousSession),
  )
}

function loadedSessions(state: DashboardState) {
  return [...(state.snapshot?.sessions ?? [])]
    .sort(
      (a, b) =>
        Number(b.id === state.selected) - Number(a.id === state.selected) ||
        Number(b.id === state.previousSession) - Number(a.id === state.previousSession) ||
        Number(!!a.parentID) - Number(!!b.parentID),
    )
}

function create(s: Switcher) {
  s.ctx.dialogs.close(false)
  s.ctx.actions.launch()
}

function choose(s: Switcher, index: number) {
  const previous = s.selected
  s.selected = Math.max(0, Math.min(index, s.matches.length - 1))
  paint(s, previous)
  paint(s, s.selected)
  describe(s)
  reveal(s)
  s.dialog.error.content = hint(s)
}

function hint(s: Switcher) {
  if (s.loading) return "Searching server...\nEsc close"
  if (s.failure) return `${s.failure}\nF3 Retry · Esc close`
  if (s.matches.length)
    return fitHints(
      innerWidth(s),
      [
        `${s.selected + 1}/${s.matches.length}${hiddenChildren(s) ? " main sessions" : ""}`,
        "↑/↓ choose",
        "Enter open",
        ...(s.scope === "recent" ? ["Type to find children"] : ["F3 Older", "Shift+F3 Newer"]),
        `F2 ${nextScope[s.scope]}`,
        "Ctrl+O ID",
        "PgUp/Dn page",
        "Ctrl+Home/End first/last",
      ],
      ["Esc close"],
    )
  if (s.scope === "recent")
    return s.query.value.trim()
      ? `${empty(s)}\nF2 Search server · Ctrl+O Open older session by ID`
      : `${empty(s)}\nType to find children · F2 All · Ctrl+O ID`
  return `${empty(s)}\nF2 ${nextScope[s.scope]} · Ctrl+O ID · Esc close`
}

/** The recent list leaves them out until a search asks for them. */
function hiddenChildren(s: Switcher) {
  return s.scope === "recent" && !s.query.value.trim() && s.sessions.some((session) => session.parentID)
}

const nextScope = { recent: "All", all: "Archived", archived: "Recent" }

function empty(s: Switcher) {
  if (s.query.value.trim()) return s.scope === "recent" ? "No matching loaded sessions." : "No matching titles."
  if (s.scope === "archived") return "No archived sessions. Archive one with Ctrl+P > Archive."
  return s.scope === "all" ? "No sessions on this server." : "No loaded main sessions."
}

function open(s: Switcher, index = s.selected) {
  if (s.loading || s.dialog.busy) return
  const session = s.matches[index]
  if (!session) return
  if (s.scope !== "recent" || !inFolders(s, session.location.directory)) {
    choose(s, index)
    void s.ctx.dialogs.submit()
    return
  }
  s.ctx.dialogs.close(false)
  s.ctx.actions.openSession(session.id, false, session)
}

function update(s: Switcher) {
  const id = s.matches[s.selected]?.id
  s.matches = rank(s)
  s.selected = Math.max(
    0,
    s.matches.findIndex((session) => session.id === id),
  )
  rebuildRows(s, (index) => open(s, index))
  s.rows.forEach((_, index) => paint(s, index))
  choose(s, s.selected)
}

async function submit(s: Switcher) {
  const { state, connection, actions } = s.ctx
  const session = s.matches[s.selected]
  if (s.loading || !session) throw new Error("Choose a loaded session first.")
  const current = await connection.client.sessions.get({ sessionID: session.id })
  if (!inFolders(s, current.location.directory))
    state.snapshot!.workingFolders = await connection.folders.open(current.location.directory)
  if (!state.closed) actions.openSession(current.id, false, current)
}

async function search(s: Switcher, cursor?: string) {
  const { state, connection } = s.ctx
  if (s.searchTimer) clearTimeout(s.searchTimer)
  s.controller?.abort()
  s.controller = new AbortController()
  const requestVersion = ++s.version
  s.loading = true
  s.failure = ""
  choose(s, s.selected)
  try {
    if (!state.connected) throw new Error("Reconnect before searching the server.")
    const page = await connection.searchSessions(
      { search: s.query.value.trim() || undefined, archived: s.scope === "archived", cursor },
      s.controller.signal,
    )
    if (state.closed || state.modal !== s.dialog || s.version !== requestVersion) return
    if (cursor && !page.data.length) {
      s.loading = false
      choose(s, s.selected)
      s.dialog.error.content = "End of results; current page kept.\nF3 Older · Shift+F3 Newer · Esc close"
      return
    }
    s.remote = [...page.data]
    s.cursors = page.cursor
    s.loading = false
    update(s)
  } catch (error) {
    if (state.closed || state.modal !== s.dialog || s.version !== requestVersion) return
    s.loading = false
    s.failure = errorText(error)
    choose(s, s.selected)
  }
}

const scopeNames = { recent: "Recent", all: "All sessions", archived: "Archived" }

function changeScope(s: Switcher, value: Scope) {
  if (s.searchTimer) clearTimeout(s.searchTimer)
  s.controller?.abort()
  ++s.version
  s.scope = value
  s.dialog.frame.title = ` Switch session${value === "recent" ? "" : ` › ${scopeNames[value]}`} `
  s.remote = []
  s.cursors = {}
  s.failure = ""
  s.loading = false
  for (const item of s.scopeButtons) {
    item.button.content = item.value === s.scope ? `[${scopeNames[item.value]}]` : scopeNames[item.value]
    item.button.fg = item.value === s.scope ? color.accent : color.muted
  }
  s.query.placeholder =
    s.scope === "recent" ? "Search title, project, agent, or session ID…" : "Search server by title…"
  update(s)
  if (s.scope !== "recent") void search(s)
}

function onInput(s: Switcher) {
  if (s.scope === "recent") return update(s)
  s.controller?.abort()
  ++s.version
  if (s.searchTimer) clearTimeout(s.searchTimer)
  s.remote = []
  s.cursors = {}
  s.loading = true
  update(s)
  s.searchTimer = setTimeout(() => void search(s), 250)
}

function onKey(s: Switcher, key: KeyEvent) {
  if (matchesKey(key, "f2")) {
    changeScope(s, s.scope === "recent" ? "all" : s.scope === "all" ? "archived" : "recent")
    return true
  }
  if (s.scope !== "recent" && (matchesKey(key, "f3") || matchesKey(key, "f3", { shift: true }))) {
    if (!s.loading) {
      const cursor = key.shift ? s.cursors.previous : s.cursors.next
      if (s.failure || cursor) void search(s, s.failure ? undefined : (cursor ?? undefined))
    }
    return true
  }
  if (matchesKey(key, "o", { ctrl: true })) {
    const typed = s.query.value
    const id = typed.trim()
    const scope = s.scope
    s.ctx.dialogs.close(false)
    openByID(s.ctx, id.startsWith("ses_") ? id : "", () => openSwitcher(s.ctx, scope, typed))
    return true
  }
  if (matchesKey(key, "n", { ctrl: true })) {
    create(s)
    return true
  }
  if (matchesKey(key, "up") || matchesKey(key, "down")) {
    choose(s, s.selected + (key.name === "up" ? -1 : 1))
    return true
  }
  if (matchesKey(key, "home", { ctrl: true }) || matchesKey(key, "end", { ctrl: true })) {
    choose(s, key.name === "home" ? 0 : s.matches.length - 1)
    return true
  }
  if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) {
    choose(s, s.selected + (key.name === "pageup" ? -1 : 1) * Math.max(1, s.dialog.form.viewport.height - 1))
    return true
  }
  if (!matchesKey(key, "enter")) return false
  open(s)
  return true
}
