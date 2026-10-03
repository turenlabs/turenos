import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

export function createSessionControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  updateRecipient: (session: Session) => void,
  replyBlocked: (sessionID: string) => boolean,
) {
  function open(title: string) {
    const selected =
      state.tab === "sessions" ? state.snapshot?.sessions.find((session) => session.id === state.selected) : undefined
    if (!selected) return say("Select a session first.", true)
    if (!state.connected) return say("Reconnect before changing this session.", true)
    if (replyBlocked(selected.id)) return say("Task-owned subagent: use its owning session. Nothing changed.", true)
    if (state.closed || !dialogs.navigate()) return
    const dialog = dialogs.open(title, false, 24)
    if (!dialog) return
    const session = structuredClone(selected)
    dialog.recipient = session
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `For: ${label(session.title || session.id, 100)}\n${session.id}\n${label(session.location.directory, 200)}`,
        fg: color.muted,
        wrapMode: "word",
      }),
    )
    return { session, dialog }
  }

  async function currentSession(session: Session) {
    if (!state.connected) throw new Error("Reconnect before changing this session.")
    if (replyBlocked(session.id)) throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
    const current = await connection.client.sessions.get({ sessionID: session.id })
    if (!sameSession(current, session)) throw new Error("Session identity changed. Close and reopen this control.")
    if (state.closed) throw new Error("Dashboard closed.")
    if (replyBlocked(session.id)) throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
    return current
  }

  function remember(session: Session) {
    if (state.snapshot)
      state.snapshot.sessions = state.snapshot.sessions.map((item) => (sameSession(item, session) ? session : item))
    if (state.inspected && sameSession(state.inspected, session)) state.inspected = session
    updateRecipient(session)
  }

  function compact() {
    const target = open("Compact session?")
    if (!target) return
    const { session, dialog } = target
    dialog.form.add(
      new TextRenderable(renderer, {
        content:
          "Ask the server to summarize this conversation into a smaller context for future turns.\n\nThis may call the session's model. Busy work is never interrupted automatically; the server can refuse compaction.\n\nYour transcript view and saved reply stay in place. No reply is sent.",
        fg: color.text,
        wrapMode: "word",
      }),
    )
    dialog.error.content = "Ctrl+S confirm server summarization\nEsc cancel"
    dialog.submit = async () => {
      await currentSession(session)
      if (state.modal !== dialog) throw new Error("Confirmation is no longer open.")
      await connection.client.sessions.compact({ sessionID: session.id })
      if (!state.closed) say(`Compacted ${label(session.title || session.id, 80)}. Server summary complete.`)
    }
    dialog.form.focus()
  }

  function agent() {
    const target = open("Choose session agent")
    if (!target) return
    const { session, dialog } = target
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `Current: ${label(session.agent ?? "Server default", 100)}\nApplies to subsequent provider turns, not in-flight work. No reply is sent.`,
        fg: color.text,
        wrapMode: "word",
      }),
    )
    const query = dialogs.input(dialog, "Find an agent", "", "Filter visible primary agents")
    query.maxLength = 256
    const select = new SelectRenderable(renderer, {
      height: 7,
      minHeight: 2,
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      showSelectionIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      descriptionColor: color.muted,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.form.add(select)
    dialogs.track(dialog, select)
    let catalog: Awaited<ReturnType<Connection["agents"]>> = []
    let matches = catalog
    let loading = false
    let requested: string | undefined
    let acknowledged = false
    const update = () => {
      if (loading || requested !== undefined) return
      const previous = matches[select.getSelectedIndex()]?.id ?? session.agent
      const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
      matches = catalog.filter((item) =>
        terms.every((term) => `${item.id} ${item.description ?? ""}`.toLowerCase().includes(term)),
      )
      select.options = matches.map((item) => ({
        name: `${item.id === session.agent ? "* " : "  "}${label(item.id, 150)}`,
        description: label(item.description ?? "", 500),
      }))
      select.setSelectedIndex(
        Math.max(
          0,
          matches.findIndex((item) => item.id === previous),
        ),
      )
      dialog.error.content = matches.length
        ? "Up/Down choose · Enter / Ctrl+S select\nCtrl+R refresh · Esc close"
        : "No matching visible primary agents.\nCtrl+R retry · Esc close"
    }
    const load = async () => {
      if (loading || dialog.busy || requested !== undefined) return
      loading = true
      catalog = []
      matches = []
      select.options = []
      dialog.error.content = "Loading agents... No change will be sent.\nEsc close"
      try {
        const result = await connection.agents(session.location.directory)
        if (state.closed || state.modal !== dialog) return
        catalog = result.filter((item) => !item.hidden && item.mode !== "subagent")
        loading = false
        update()
      } catch (error) {
        if (state.closed || state.modal !== dialog) return
        dialog.error.height = 4
        dialog.error.content = `Cannot load agents: ${errorText(error)}\nCtrl+R retry · Esc close`
      } finally {
        loading = false
      }
    }
    dialog.submit = async () => {
      const choice = requested ?? matches[select.getSelectedIndex()]?.id
      if (loading || !choice) throw new Error("Choose a loaded, visible primary agent first.")
      const current = await currentSession(session)
      if (state.modal !== dialog) throw new Error("Agent picker is no longer open.")
      if (!acknowledged && current.agent !== choice) {
        // An ambiguous retry keeps the original agent; an acknowledged switch only retries its GET.
        requested = choice
        await connection.client.sessions.switchAgent({ sessionID: session.id, agent: choice })
        acknowledged = true
      }
      const updated = acknowledged ? await currentSession(session) : current
      remember(updated)
      say(`Agent: ${label(updated.agent ?? "Server default", 100)}. Applies to subsequent turns.`)
    }
    query.on("input", update)
    select.on("itemSelected", () => void dialogs.submit())
    dialog.key = (key) => {
      if (matchesKey(key, "r", { ctrl: true })) {
        void load()
        return true
      }
      if (matchesKey(key, "up") || matchesKey(key, "down")) {
        if (requested === undefined) {
          if (key.name === "up") select.moveUp()
          else select.moveDown()
          dialogs.reveal(dialog, select)
        }
        return true
      }
      if (!matchesKey(key, "enter")) return false
      void dialogs.submit()
      return true
    }
    query.focus()
    void load()
  }

  return { compact, agent }
}

function sameSession(left: Session, right: Session) {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.location.directory === right.location.directory &&
    left.location.workspaceID === right.location.workspaceID
  )
}

export type SessionControls = ReturnType<typeof createSessionControls>
