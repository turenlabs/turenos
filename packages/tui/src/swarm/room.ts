import { StyledText, fg, type InputRenderable } from "@opentui/core"
import type { SessionsSwarmRoomEntriesOutput, SessionsSwarmRoomOutput } from "@turenlabs/client"
import { fitHeading, panelWidth } from "../changes/heading"
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

export const KEYS = "↑↓ lanes · PgUp/PgDn read · Tab post box · Enter sends · Ctrl+R refresh · Esc close"

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
}

export async function load(v: SwarmView, reset = false) {
  if (v.loading) return
  v.loading = true
  try {
    const room = await v.connection.client.sessions.swarmRoom({ sessionID: v.session.id })
    const page = await v.connection.client.sessions.swarmRoomEntries({
      sessionID: v.session.id,
      after: reset ? undefined : v.head,
      limit: 200,
    })
    if (v.state.modal !== v.panel.dialog) return
    if (reset) v.entries.length = 0
    v.entries.push(...page.entries.filter((entry) => entry.seq > v.head || reset))
    v.entries.splice(0, Math.max(0, v.entries.length - 500))
    v.head = page.head
    paint(v, room)
  } catch (error) {
    if (v.state.modal !== v.panel.dialog) return
    v.panel.dialog.error.content = KEYS
    v.panel.heading.content = "No swarm room"
    v.panel.show(
      httpStatus(error) === 404 || /not ?found|404/i.test(errorText(error))
        ? "This session has no\nswarm room yet.\n\nPosting below creates one.\nThe agent opens one for\nsubagent work. Subagents\nshare the main one."
        : `Swarm room unavailable: ${errorText(error)}`,
    )
  } finally {
    v.loading = false
  }
}

function paint(v: SwarmView, room: Room) {
  const { panel } = v
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
  if (atBottom) queueMicrotask(() => panel.dialog.form.scrollTo(panel.dialog.form.scrollHeight))
  panel.dialog.error.content = KEYS
}

function entryText(entries: Entry[]) {
  return new StyledText(
    entries.flatMap((entry) => [
      fg(color.muted)(`#${entry.seq} ${new Date(entry.timeCreated).toLocaleTimeString()} ${entry.kind} · `),
      fg(entry.actor.type === "human" ? color.accent : color.text)(`${label(entry.actor.name, 60)}\n`),
      fg(KIND[entry.kind] ?? color.text)(`${display(entry.text, 4000)}\n\n`),
    ]),
  )
}

export async function send(v: SwarmView) {
  const text = v.post.value.trim()
  if (!text) return
  try {
    await v.connection.client.sessions.swarmRoomPost({ sessionID: v.session.id, text })
    v.post.value = ""
    await load(v, true)
  } catch (error) {
    v.panel.dialog.error.content = `! ${errorText(error)}\n${KEYS}`
  }
}
