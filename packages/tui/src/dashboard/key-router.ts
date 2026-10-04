import type { KeyEvent } from "@opentui/core"
import { matchesKey, printableKey } from "../keys"
import { primaryAction } from "./actions"
import { openCommands, slashCommands } from "./commands"
import { openServers, quit } from "./lifecycle"
import { changeTab, endSearch, filter, hop } from "./navigation"
import { toggleSidebar } from "./toggles"
import type { DashboardContext } from "./context"

/**
 * The dashboard's keypress listener. Each stage returns true once it consumed the key; the order of
 * the stages is the priority order of the bindings.
 */
export function routeKey(d: DashboardContext, key: KeyEvent) {
  if (d.state.closed) return key.preventDefault()
  if (d.options.blocked?.()) return
  if (key.hyper || key.eventType === "release") return key.preventDefault()
  if (globalKey(d, key)) return
  if (d.c.dialogs.keypress(key)) return
  if (d.state.searching) return searchKey(d, key)
  if (chordKey(d, key)) return
  cancelReadingPosition(d, key)
  if (capitalKey(d, key)) return
  // Leaving History comes first, so Esc never arms a rewind from a view that is only for reading.
  if (matchesKey(key, "escape") && d.state.history && d.state.tab === "sessions")
    return run(key, () => d.c.conversation.toggleHistory())
  if (matchesKey(key, "escape") && d.c.requests.escapeStop(d.c.rewind.undo)) return key.preventDefault()
  if (tabKey(d, key)) return
  if (characterKey(d, key)) return
  paneKey(d, key)
}

/** Quit, copy, the size notice, and the keys that work while a dialog or editor has focus. */
function globalKey(d: DashboardContext, key: KeyEvent) {
  if (matchesKey(key, "c", { ctrl: true })) {
    key.preventDefault()
    const dialog = d.state.modal && !d.state.modal.busy && !d.state.modal.save ? d.state.modal : undefined
    quit(d)
    // Without a saved draft, quit only closed the dialog, which the user should be told.
    if (dialog && !d.state.modal && !d.state.closed) d.say("Closed.")
    return true
  }
  if (printableKey(key) !== "q") d.run.quitArmedUntil = 0
  if (d.c.copy.key(key)) return consume(key)
  if (d.ui.sizeNotice.visible) {
    key.preventDefault()
    if (!key.shift && printableKey(key) === "q") quit(d)
    return true
  }
  if (matchesKey(key, "k", { ctrl: true }) && d.state.modal?.questionKey) return run(key, () => d.c.menus.switcher())
  if (matchesKey(key, "n", { ctrl: true }) && (!d.state.modal || d.state.modal.editor))
    return run(key, () => d.c.launch.open())
  if (d.c.slash.key(key)) return consume(key)
  if (d.c.mentions.key(key)) return consume(key)
  return false
}

/** Keys while the sidebar search box is open: every one is consumed or left for the input to type. */
function searchKey(d: DashboardContext, key: KeyEvent) {
  if (matchesKey(key, "up") || matchesKey(key, "down")) {
    key.preventDefault()
    if (key.name === "up") d.ui.list.moveUp()
    if (key.name === "down") d.ui.list.moveDown()
    return
  }
  if (!matchesKey(key, "escape") && !matchesKey(key, "enter")) return
  key.preventDefault()
  endSearch(d, key.name === "escape", matchesKey(key, "enter"))
}

/** Ctrl and Alt chords that open a list or move between sessions. */
function chordKey(d: DashboardContext, key: KeyEvent) {
  if (matchesKey(key, "k", { ctrl: true })) return run(key, () => d.c.menus.switcher())
  if (matchesKey(key, "left", { meta: true }) || matchesKey(key, "right", { meta: true }))
    return run(key, () => hop(d, key.name === "left" ? -1 : 1))
  if (matchesKey(key, "p", { ctrl: true })) return run(key, () => openCommands(d))
  if (matchesKey(key, "x", { ctrl: true })) return run(key, () => d.c.sessions.tasks())
  if (matchesKey(key, "b", { ctrl: true })) return run(key, () => toggleSidebar(d))
  return false
}

/** Scrolling keys release the saved reading position; scrolling up loads earlier history. */
function cancelReadingPosition(d: DashboardContext, key: KeyEvent) {
  const state = d.state
  if (
    ["pageup", "pagedown"].some((name) => matchesKey(key, name)) ||
    (state.detailFocused && ["up", "down", "home", "end", "j", "k"].some((name) => matchesKey(key, name)))
  )
    d.c.conversation.cancelPosition()
  if (matchesKey(key, "pageup") || (state.detailFocused && ["up", "home", "k"].some((name) => matchesKey(key, name))))
    void d.c.conversation.scrollEarlier()
}

function capitalKey(d: DashboardContext, key: KeyEvent) {
  if (printableKey(key) === "H") return run(key, () => d.c.harness.open())
  if (printableKey(key) === "T") return run(key, () => void d.c.terminals.shared())
  if (printableKey(key) === "I") return run(key, () => d.c.intel.open())
  return false
}

/** The list tabs have their own add / delete / rename keys. */
function tabKey(d: DashboardContext, key: KeyEvent) {
  const terminals = d.c.terminals
  const automations = d.c.automations
  const tabActions: Record<string, () => void> =
    d.state.tab === "terminals"
      ? { a: terminals.create, d: terminals.close, R: terminals.rename }
      : d.state.tab === "automations"
        ? { a: automations.create, d: automations.remove, E: automations.edit }
        : {}
  const tabAction = tabActions[printableKey(key) ?? ""]
  if (!tabAction) return false
  return run(key, tabAction)
}

/** Single-letter shortcuts; they are consumed before focus moves so they do not enter the new field. */
function characterKey(d: DashboardContext, key: KeyEvent) {
  const character = key.shift && key.sequence !== "?" ? "" : printableKey(key)
  const action = characterActions(d)[character ?? ""]
  if (!action) return false
  key.preventDefault()
  action()
  return true
}

function characterActions(d: DashboardContext): Record<string, () => void> {
  const c = d.c
  return {
    ...(d.options.servers ? { s: () => openServers(d) } : {}),
    "?": () => c.menus.help(),
    q: () => quit(d),
    n: () => c.launch.open(),
    m: () => c.models.open(),
    f: () => c.requests.followup(),
    t: () => c.sessions.tasks(),
    u: () => c.queue.open(),
    d: () => c.changes.open(),
    e: () => c.files.open(),
    w: () => c.room.open(),
    ",": () => c.settings.open(),
    p: () => c.requests.permission(),
    o: () => c.requests.question(),
    x: () => c.requests.interrupt(),
    h: () => c.conversation.toggleHistory(),
    "[": () => c.conversation.page("next"),
    "]": () => c.conversation.page("previous"),
    i: () => c.menus.information(d.serverAddress),
    "/": () => slashShortcut(d),
    "1": () => changeTab(d, "sessions"),
    "2": () => changeTab(d, "terminals"),
    "3": () => changeTab(d, "automations"),
    r: () => void d.refresh(),
    b: () => toggleSidebar(d),
  }
}

/** `/` opens the sidebar search, the command list for a read-only reply, or `/` in an empty reply editor. */
function slashShortcut(d: DashboardContext) {
  const state = d.state
  if (state.tab !== "sessions" || !state.detailFocused || !state.selected) return filter(d)
  if (d.c.requests.replyBlocked(state.selected))
    return d.c.menus.commands([
      { name: "/main", description: "Open owning session and reply", run: d.c.requests.followup },
      ...slashCommands(d).map((item) => ({ ...item, name: `/${item.name}` })),
    ])
  d.c.requests.followup()
  const editor = state.modal?.editor
  if (!editor) return
  if (!editor.plainText) {
    editor.setText("/")
    editor.cursorOffset = 1
  } else d.say("Draft kept unchanged. Type / in an empty editor for commands.")
}

/** Enter and Tab between panes, and Page Up / Down for the transcript. */
function paneKey(d: DashboardContext, key: KeyEvent) {
  const state = d.state
  if (matchesKey(key, "enter") && d.ui.list.focused) return run(key, () => d.ui.list.selectCurrent())
  if (matchesKey(key, "enter") && state.detailFocused) return run(key, () => primaryAction(d))
  if (matchesKey(key, "tab") || matchesKey(key, "tab", { shift: true })) {
    key.preventDefault()
    state.detailFocused = !state.detailFocused
    return d.ui.focus()
  }
  if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) {
    key.preventDefault()
    d.ui.detail.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, d.ui.detail.viewport.height - 1))
  }
}

function consume(key: KeyEvent) {
  key.preventDefault()
  return true
}

function run(key: KeyEvent, action: () => void) {
  key.preventDefault()
  action()
  return true
}
