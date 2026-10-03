import { InputRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { identifier } from "./response-validation"
import type { Connection, Session, Todo } from "./server"
import { label, type DashboardState, type ModalState } from "./state"
import { color } from "./theme"

const MARK = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" } as const

/** "3/7 to-dos", counting cancelled items as settled, or "" when the agent keeps no list. */
export function todoProgress(todos: readonly Todo[]) {
  if (!todos.length) return ""
  return `${todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length}/${todos.length} to-dos`
}

function todoText(todos: readonly Todo[]) {
  return [
    `TO-DOS · ${todoProgress(todos)}`,
    ...todos.slice(0, 12).map((todo) => `${MARK[todo.status]} ${label(todo.content, 160)}`),
    ...(todos.length > 12 ? [`… ${todos.length - 12} more`] : []),
  ].join("\n")
}

export function createSessionActions(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  onUpdate: (session: Session) => void = () => {},
  onDelete: (sessionID: string) => void = () => {},
) {
  function selectedSession() {
    const session =
      state.tab === "sessions" ? state.snapshot?.sessions.find((item) => item.id === state.selected) : undefined
    if (!session) say("Select an available session first.")
    return session
  }

  function recipient(dialog: ModalState, session: Session) {
    dialog.recipient = session
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `${label(session.title)}\n${label(session.id, 256)}\n${label(session.location.directory, 4096)}`,
        fg: color.muted,
        wrapMode: "word",
      }),
    )
  }

  async function update(dialog: ModalState, session: Session, change: { title: string } | { archived: number | null }) {
    if (!state.connected) throw new Error("Reconnect before changing a session.")
    const updated = await connection.updateSession(session, change)
    if (state.closed) return
    onUpdate(updated)
    dialog.recipient = updated
    if (state.snapshot)
      state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === updated.id ? updated : item))
    if (state.inspected?.id === updated.id) state.inspected = updated
    if ("archived" in change && change.archived !== null) {
      // Drop the inspection pin. Main's refresh must retain saved-draft recipients using fresh session pins.
      if (state.inspected?.id === updated.id) state.inspected = undefined
      if (state.inspection === updated.id) {
        state.inspection = ""
        state.query = ""
      }
      say("Session archived. Running work was not interrupted.")
      return
    }
    openSession(updated.id, false, updated)
    say("title" in change ? "Session renamed." : "Session restored.")
  }

  function rename(): void {
    const session = selectedSession()
    if (!session) return
    const dialog = dialogs.open("Rename session", false, 19)
    if (!dialog) return
    recipient(dialog, session)
    const title = dialogs.input(dialog, "Title (1-200 characters)", display(session.title, 64000))
    title.maxLength = 200
    dialog.submit = () => update(dialog, session, { title: title.value })
    dialog.error.content = "Enter / Ctrl+S Save title - Esc cancel"
    dialog.key = (key) => {
      if (!matchesKey(key, "enter")) return false
      void dialogs.submit()
      return true
    }
    title.focus()
  }

  function archive(): void {
    const session = selectedSession()
    if (!session) return
    const restore = session.time.archived !== undefined
    const action = restore ? "restore" : "archive"
    const dialog = dialogs.open(restore ? "Restore session" : "Archive session", false, 23)
    if (!dialog) return
    recipient(dialog, session)
    dialog.form.add(
      new TextRenderable(renderer, {
        content:
          "Archiving hides recent history; it does not interrupt running work.\nTask-owned sessions may reject this change.",
        fg: color.text,
        wrapMode: "word",
      }),
    )
    const confirmation = dialogs.input(dialog, `Type ${action} to confirm`)
    // Capture once for this confirmation, not on each ambiguous-failure retry.
    const archived = restore ? null : Date.now()
    dialog.submit = async () => {
      if (confirmation.value !== action) throw new Error(`Type ${action} to confirm.`)
      await update(dialog, session, { archived })
    }
    dialog.error.content = `Ctrl+S Confirm ${action} - Esc cancel`
    confirmation.focus()
  }

  function remove(): void {
    const session = selectedSession()
    if (!session) return
    const dialog = dialogs.open("Delete session", false, 23)
    if (!dialog) return
    recipient(dialog, session)
    dialog.form.add(
      new TextRenderable(renderer, {
        content:
          "Deletes this session and all of its subagent sessions from the server. Running work is stopped first.\nThis cannot be undone; archive instead to keep the history.",
        fg: color.error,
        wrapMode: "word",
      }),
    )
    const confirmation = dialogs.input(dialog, "Type delete to confirm")
    dialog.submit = async () => {
      if (confirmation.value !== "delete") throw new Error("Type delete to confirm.")
      if (!state.connected) throw new Error("Reconnect before deleting a session.")
      await connection.deleteSession(session)
      if (state.closed) return
      onDelete(session.id)
      say("Session deleted.")
    }
    dialog.error.content = "Ctrl+S Delete - Esc cancel"
    confirmation.focus()
  }

  async function open(id: string) {
    identifier(id, "ses_")
    if (!state.connected) throw new Error("Reconnect before opening a session.")
    const session = await connection.client.sessions.get({ sessionID: id })
    if (!state.closed) openSession(session.id, false, session)
  }

  function parent(): void {
    const session = selectedSession()
    if (!session) return
    const id = session.parentID
    if (!id) return say("This session has no parent session.")
    const dialog = dialogs.open("Open parent session", false, 17)
    if (!dialog) return
    recipient(dialog, session)
    dialog.form.add(new TextRenderable(renderer, { content: `Parent: ${label(id, 256)}`, fg: color.text }))
    dialog.submit = () => open(id)
    void dialogs.submit()
  }

  function tasks(): void {
    const session = selectedSession()
    if (!session) return
    let detail = state.detail?.sessionID === session.id ? state.detail : undefined
    if (!detail) return say("Refresh this session's details before opening tasks.")
    let tasks = [...new Map([...detail.tasks.data, ...detail.tasks.active].map((task) => [task.id, task])).values()]
    let revision = JSON.stringify(detail.tasks)
    const dialog = dialogs.open("Tasks in session root", false, 32)
    if (!dialog) return
    dialog.frame.maxWidth = 96
    const query = new InputRenderable(renderer, {
      placeholder: "Search task description, agent, status, or ID",
      maxLength: 256,
      width: "100%",
      flexShrink: 0,
      backgroundColor: color.bg,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
      placeholderColor: color.muted,
    })
    dialog.frame.add(query, 0)
    dialog.frame.add(
      new TextRenderable(renderer, {
        content: "Root-wide recent and active tasks, including nested delegation.",
        fg: color.muted,
        flexShrink: 0,
        wrapMode: "word",
      }),
      1,
    )
    const todos = new TextRenderable(renderer, {
      content: todoText(detail.todos),
      visible: detail.todos.length > 0,
      fg: color.text,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
    })
    dialog.frame.add(todos, 2)
    dialogs.track(dialog, query)
    let matches = tasks
    let selected = 0
    let rows: TextRenderable[] = []
    const reveal = () => {
      const top = selected * 3
      if (top < dialog.form.scrollTop) dialog.form.scrollTo(top)
      if (top + 3 > dialog.form.scrollTop + dialog.form.viewport.height)
        dialog.form.scrollTo(top + 3 - dialog.form.viewport.height)
    }
    const paint = (index: number) => {
      const task = matches[index]
      const row = rows[index]
      if (!task || !row) return
      row.bg = index === selected ? color.accent : color.panel
      row.fg = index === selected ? color.bg : task.status === "failed" ? color.error : color.text
      row.content = `${index === selected ? ">" : " "} [${task.status}] ${label(task.description, 200)}\n  ${label(task.agent)} - ${task.childSessionID}\n  ${task.error ? `Failure: ${label(task.error, 500)}` : `Task: ${task.id}`}`
    }
    const choose = (index: number) => {
      const previous = selected
      selected = Math.max(0, Math.min(index, matches.length - 1))
      paint(previous)
      paint(selected)
      reveal()
      dialog.error.content = matches.length
        ? `${selected + 1}/${matches.length} - Up/Down choose - Enter open - Esc close\nPgUp/PgDn page${detail?.tasks.cursor.next ? " - Older tasks are not loaded" : ""}`
        : "No matching loaded tasks - Esc close"
    }
    dialog.submit = async () => {
      const task = matches[selected]
      if (!task) throw new Error("Choose a loaded task first.")
      await open(task.childSessionID)
    }
    const filter = () => {
      const id = matches[selected]?.id
      const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
      matches = tasks.filter((task) => {
        const text =
          `${task.description} ${task.agent} ${task.status} ${task.id} ${task.childSessionID} ${task.error ?? ""}`.toLowerCase()
        return terms.every((term) => text.includes(term))
      })
      selected = Math.max(
        0,
        matches.findIndex((task) => task.id === id),
      )
      rows.forEach((row) => row.destroyRecursively())
      rows = matches.map((_, index) => {
        const row = new TextRenderable(renderer, {
          height: 3,
          flexShrink: 0,
          width: "100%",
          wrapMode: "none",
          truncate: true,
          onMouseDown: (event) => {
            event.preventDefault()
            if (event.button !== 0 || dialog.busy) return
            choose(index)
            void dialogs.submit()
          },
        })
        dialog.form.add(row)
        return row
      })
      rows.forEach((_, index) => paint(index))
      choose(selected)
    }
    query.on("input", filter)
    dialog.refresh = () => {
      if (state.modal !== dialog || dialog.busy || state.detail?.sessionID !== session.id) return
      const next = JSON.stringify(state.detail.tasks)
      todos.content = todoText(state.detail.todos)
      todos.visible = state.detail.todos.length > 0
      if (revision === next) return
      revision = next
      detail = state.detail
      tasks = [...new Map([...detail.tasks.data, ...detail.tasks.active].map((task) => [task.id, task])).values()]
      filter()
    }
    // The scrollbox is not a keyboard field; clicking its whitespace cannot steal search focus.
    dialog.form.onMouseDown = (event) => event.preventDefault()
    dialog.form.content.onMouse = (event) => {
      if (dialog.busy || event.type !== "scroll" || !event.scroll || !["up", "down"].includes(event.scroll.direction))
        return
      event.preventDefault()
      event.stopPropagation()
      choose(selected + (event.scroll.direction === "up" ? -3 : 3))
    }
    dialog.form.content.on("resize", reveal)
    dialog.form.viewport.on("resize", reveal)
    dialog.key = (key) => {
      if (matchesKey(key, "up") || matchesKey(key, "down")) {
        choose(selected + (key.name === "up" ? -1 : 1))
        return true
      }
      if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) {
        choose(selected + (key.name === "pageup" ? -1 : 1) * Math.max(1, Math.floor(dialog.form.viewport.height / 3)))
        return true
      }
      if (!matchesKey(key, "enter")) return false
      if (matches.length) void dialogs.submit()
      return true
    }
    filter()
    query.focus()
  }

  return { rename, archive, remove, tasks, parent }
}
