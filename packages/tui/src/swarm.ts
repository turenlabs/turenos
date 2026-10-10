import { InputRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { openPanel } from "./panel"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import { color } from "./theme"
import { load, send, type SwarmView } from "./swarm/room"

/**
 * The desktop's swarm room for a session that coordinates subagents: the plan's lanes and who
 * holds them, the shared entry stream, and a box to post into it as a human member.
 */
export function createSwarmRoom(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  /** Unsent post text by session, so Esc closes the room without losing what was typed. */
  const drafts = new Map<string, string>()

  function open() {
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.tab !== "sessions" || !session) return say("Select a session first.")
    if (!dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, "Swarm room")
    if (!panel) return
    panel.dialog.recipient = session
    panel.dialog.error.marginRight = 2
    const post = new InputRenderable(renderer, {
      placeholder: "Type here to post as a human member · Enter posts",
      value: drafts.get(session.id) ?? "",
      maxLength: 8000,
      flexShrink: 0,
      marginRight: 2,
      backgroundColor: color.bg,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
      placeholderColor: color.muted,
    })
    panel.dialog.frame.add(post, panel.dialog.frame.getChildren().indexOf(panel.dialog.error))
    panel.track(post)
    panel.dialog.save = () => {
      if (!post.value.trim()) return void drafts.delete(session.id)
      drafts.set(session.id, post.value)
      say("Post draft kept · w to resume")
    }
    const view: SwarmView = { state, connection, session, panel, post, entries: [], head: 0, loading: false }
    panel.dialog.refresh = () => void load(view)
    panel.dialog.key = (key) => {
      const action = matchesKey(key, "r", { ctrl: true })
        ? () => load(view, true)
        : post.focused && matchesKey(key, "enter")
          ? () => send(view)
          : undefined
      if (!action) return false
      void action()
      return true
    }
    void load(view, true)
  }

  return { open }
}
