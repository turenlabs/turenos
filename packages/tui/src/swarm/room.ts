import { StyledText, fg, type InputRenderable } from "@opentui/core"
import type { SessionsSwarmRoomEntriesOutput, SessionsSwarmRoomOutput } from "@turenlabs/client"
import { fitHeading, panelWidth } from "../changes/heading"
import { clock } from "../menus/stamp"
import { display } from "../messages"
import type { Panel } from "../panel"
import { errorText, httpStatus, type Connection, type Session } from "../server"
import { label, type DashboardState } from "../state"
import { color } from "../theme"

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

export const KEYS = "↑↓ lanes · PgUp/PgDn read · Tab post box · Enter post · Ctrl+R refresh · Esc close"

/** One open Swarm room panel: the entries read so far and the head to resume from. */
export type SwarmView = {
  state: DashboardState
  connection: Connection
  session: Session
  panel: Panel
  post: InputRenderable
  entries: Entry[]
  head: number
  loading: boolean
  /** A post is on its way, so another Enter must not send the same text twice. */
  sending?: boolean
}

export async function load(v: SwarmView, reset = false) {
  if (v.loading || v.state.closed || v.panel.dialog.error.isDestroyed) return
  v.loading = true
  try {
    const room = await v.connection.client.sessions.swarmRoom({ sessionID: v.session.id })
    const page = await v.connection.client.sessions.swarmRoomEntries({
      sessionID: v.session.id,
      after: reset ? undefined : v.head,
      limit: 200,
    })
    if (v.state.closed || v.state.modal !== v.panel.dialog || v.panel.dialog.error.isDestroyed) return
    if (reset) v.entries.length = 0
    v.entries.push(...page.entries.filter((entry) => entry.seq > v.head || reset))
    v.entries.splice(0, Math.max(0, v.entries.length - 500))
    // `head` is the room's newest entry; after a full page, resume from the last one read instead.
    v.head = page.hasMore ? (page.entries.at(-1)?.seq ?? page.head) : page.head
    paint(v, room)
  } catch (error) {
    if (v.state.closed || v.state.modal !== v.panel.dialog || v.panel.dialog.error.isDestroyed) return
    v.panel.dialog.error.content = KEYS
    v.panel.heading.content = "No swarm room"
    // With no lanes to choose, the empty list would squeeze the message into a narrow column.
    v.panel.list.visible = false
    v.panel.show(
      httpStatus(error) === 404 || /not ?found|404/i.test(errorText(error))
        ? "This session has no swarm room yet.\n\nPosting below creates one. The agent opens one for subagent work, and its subagents share the main one."
        : `Swarm room unavailable: ${errorText(error)}`,
    )
  } finally {
    v.loading = false
  }
}

function paint(v: SwarmView, room: Room) {
  const { panel } = v
  panel.list.visible = true
  const active = room.members.filter((member) => member.state === "active" || member.state === "parked")
  panel.heading.content = fitHeading(
    panelWidth(panel),
    `${room.room.status === "open" ? "Open" : "Closed"} · `,
    label(room.room.objective || "No objective", 300),
    ` · ${active.length}/${room.members.length} members active`,
    "end",
  )
  panel.list.options = room.lanes.length
    ? room.lanes.map((lane) => ({
        name: `[${lane.status}] ${label(lane.title, 60)}${lane.claimedByName ? ` · ${label(lane.claimedByName, 30)}` : ""}`,
        description: "",
      }))
    : [{ name: "No plan yet", description: "" }]
  const atBottom = panel.dialog.form.scrollTop + panel.dialog.form.viewport.height >= panel.dialog.form.scrollHeight - 1
  panel.body.content = v.entries.length ? entryText(v.entries) : "No entries yet."
  // Keep following new entries unless the reader scrolled up.
  if (atBottom)
    queueMicrotask(() => {
      if (!v.state.closed && v.state.modal === panel.dialog && !panel.dialog.form.isDestroyed)
        panel.dialog.form.scrollTo(panel.dialog.form.scrollHeight)
    })
  panel.dialog.error.content = KEYS
}

function entryText(entries: Entry[]) {
  return new StyledText(
    entries.flatMap((entry) => [
      fg(color.muted)(`#${entry.seq} ${clock(entry.timeCreated)} ${label(entry.kind, 32)} · `),
      fg(entry.actor.type === "human" ? color.accent : color.text)(`${label(entry.actor.name, 60)}\n`),
      fg((Object.hasOwn(KIND, entry.kind) ? KIND[entry.kind] : undefined) ?? color.text)(
        `${display(entry.text, 4000)}\n\n`,
      ),
    ]),
  )
}

export async function send(v: SwarmView, sent: (text: string) => void) {
  const text = v.post.value.trim()
  if (!text || v.sending || v.state.closed || v.panel.dialog.error.isDestroyed) return
  v.sending = true
  v.panel.dialog.error.content = `Posting…\n${KEYS}`
  try {
    await v.connection.client.sessions.swarmRoomPost({ sessionID: v.session.id, text })
    sent(text)
    if (v.state.closed || v.state.modal !== v.panel.dialog || v.panel.dialog.error.isDestroyed) return
    v.post.value = ""
    await load(v, true)
  } catch (error) {
    if (v.state.closed || v.state.modal !== v.panel.dialog || v.panel.dialog.error.isDestroyed) return
    v.panel.dialog.error.content = `! ${errorText(error)}\n${KEYS}`
  } finally {
    v.sending = false
  }
}
