import { InputRenderable, StyledText, fg, type CliRenderer } from "@opentui/core"
import type { SessionsSwarmRoomEntriesOutput, SessionsSwarmRoomOutput } from "@turenlabs/client"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { openPanel } from "./panel"
import { errorText, type Connection } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Entry = SessionsSwarmRoomEntriesOutput["entries"][number]
type Room = SessionsSwarmRoomOutput

const KIND: Partial<Record<Entry["kind"], string>> = {
  decision: color.accent,
  finding: color.text,
  correction: color.warning,
  question: color.warning,
  status: color.muted,
  claim: color.muted,
  release: color.muted,
}

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
  function open() {
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.tab !== "sessions" || !session) return say("Select a session first.")
    if (!dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, "Swarm room")
    if (!panel) return
    panel.dialog.recipient = session
    const post = new InputRenderable(renderer, {
      placeholder: "Post to the room as a human member · Enter sends",
      maxLength: 8000,
      width: "100%",
      flexShrink: 0,
      backgroundColor: color.bg,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
      placeholderColor: color.muted,
    })
    panel.dialog.frame.add(post, panel.dialog.frame.getChildren().indexOf(panel.dialog.error))
    dialogs.track(panel.dialog, post)
    const entries: Entry[] = []
    let head = 0
    let loading = false
    const keys = "↑↓ lanes · PgUp/PgDn read · Tab post box · Enter sends · Ctrl+R refresh · Esc close"

    async function load(reset = false) {
      if (loading) return
      loading = true
      try {
        const room = await connection.client.sessions.swarmRoom({ sessionID: session!.id })
        const page = await connection.client.sessions.swarmRoomEntries({
          sessionID: session!.id,
          after: reset ? undefined : head,
          limit: 200,
        })
        if (state.modal !== panel!.dialog) return
        if (reset) entries.length = 0
        entries.push(...page.entries.filter((entry) => entry.seq > head || reset))
        entries.splice(0, Math.max(0, entries.length - 500))
        head = page.head
        paint(room)
      } catch (error) {
        if (state.modal !== panel!.dialog) return
        panel!.heading.content = "No swarm room"
        panel!.show(
          /not ?found|404/i.test(errorText(error))
            ? "This session has no swarm room. A room opens when the agent coordinates several subagents.\nOpen the main session if this is a subagent."
            : `Swarm room unavailable: ${errorText(error)}`,
        )
      } finally {
        loading = false
      }
    }

    function paint(room: Room) {
      const active = room.members.filter((member) => member.state === "active" || member.state === "parked")
      panel!.heading.content = `${room.room.status === "open" ? "Open" : "Closed"} · ${label(room.room.objective || "No objective", 120)} · ${active.length}/${room.members.length} members active`
      panel!.list.options = room.lanes.length
        ? room.lanes.map((lane) => ({
            name: `[${lane.status}] ${label(lane.title, 60)}${lane.claimedByName ? ` · ${label(lane.claimedByName, 30)}` : ""}`,
            description: "",
          }))
        : [{ name: "No plan yet", description: "" }]
      const atBottom =
        panel!.dialog.form.scrollTop + panel!.dialog.form.viewport.height >= panel!.dialog.form.scrollHeight - 1
      panel!.body.content = entries.length
        ? new StyledText(
            entries.flatMap((entry) => [
              fg(color.muted)(`#${entry.seq} ${new Date(entry.timeCreated).toLocaleTimeString()} ${entry.kind} · `),
              fg(entry.actor.type === "human" ? color.accent : color.text)(`${label(entry.actor.name, 60)}\n`),
              fg(KIND[entry.kind] ?? color.text)(`${display(entry.text, 4000)}\n\n`),
            ]),
          )
        : "No entries yet."
      // Keep following new entries unless the reader scrolled up.
      if (atBottom) queueMicrotask(() => panel!.dialog.form.scrollTo(panel!.dialog.form.scrollHeight))
      panel!.dialog.error.content = keys
    }

    async function send() {
      const text = post.value.trim()
      if (!text) return
      try {
        await connection.client.sessions.swarmRoomPost({ sessionID: session!.id, text })
        post.value = ""
        await load()
      } catch (error) {
        panel!.dialog.error.content = `! ${errorText(error)}\n${keys}`
      }
    }

    panel.dialog.refresh = () => void load()
    panel.dialog.key = (key) => {
      const action = matchesKey(key, "r", { ctrl: true })
        ? () => load(true)
        : post.focused && matchesKey(key, "enter")
          ? send
          : undefined
      if (!action) return false
      void action()
      return true
    }
    void load(true)
  }

  return { open }
}
