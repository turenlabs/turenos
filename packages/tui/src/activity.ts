import { waiting } from "./queue/inputs"
import { label, type DashboardState, type Retry } from "./state"

// Each Braille cell is a 2x4 dot grid. Project three tilted particle orbits
// into six by four dots, keeping the indicator one terminal row high.
const globe = Array.from({ length: 24 }, (_, frame) => {
  const cells = [0, 0, 0]
  const bits = [
    [1, 2, 4, 64],
    [8, 16, 32, 128],
  ]
  for (let orbit = 0; orbit < 3; orbit++) {
    const tilt = 0.5 + orbit * 0.6
    const rotation = orbit * 2.1
    for (const offset of [0, 1.9, 4.3]) {
      const angle = (frame / 24) * Math.PI * 2 * (orbit === 1 ? -1 : 1) + offset + orbit
      const x = Math.cos(angle)
      const y = Math.sin(angle) * Math.cos(tilt)
      const column = Math.round(2.5 + 2.4 * (x * Math.cos(rotation) - y * Math.sin(rotation)))
      const row = Math.round(1.5 + 1.4 * (x * Math.sin(rotation) + y * Math.cos(rotation)))
      cells[Math.floor(column / 2)]! |= bits[column % 2]![row]!
    }
  }
  return cells.map((cell) => String.fromCharCode(0x2800 + cell)).join("")
})

/** Esc Esc works from the reply editor and the dashboard alike; `x` only where letters are shortcuts, not text. */
const stopHint = (state: DashboardState) => (state.modal ? "Esc Esc to stop" : "Esc Esc or x to stop")

/** Columns the activity line is cut to when the caller does not know the pane width: the main pane at 80 columns. */
const defaultRoom = 72

export type ActivityFrame = {
  content: string
  tone: "muted" | "accent" | "warning" | "error"
  animate: boolean
}

export function activityFrame(
  state: DashboardState,
  frame: number,
  reducedMotion: boolean,
  room = defaultRoom,
): ActivityFrame | undefined {
  if (!state.modal?.busy && !state.connected && state.connectionError)
    return { content: "! Disconnected", tone: "error", animate: false }

  const detail = state.tab === "sessions" && state.detail?.sessionID === state.selected ? state.detail : undefined
  if (!state.modal?.busy && state.connected) {
    if (detail && (detail.permissions.length || detail.questions.length))
      return { content: "? Needs your input", tone: "warning", animate: false }
    if (
      state.tab !== "sessions" ||
      !state.selected ||
      !state.snapshot ||
      !Object.hasOwn(state.snapshot.active, state.selected)
    )
      return undefined
  }

  const retry = state.modal?.busy || !state.connected ? undefined : state.retries[state.selected]
  const content = state.modal?.busy
    ? state.modal.editor
      ? "Sending message"
      : "Applying request"
    : !state.connected
      ? "Connecting"
      : retry
        ? retrying(retry, room - globe[0]!.length - 1)
        : working(state, detail)

  const phase =
    reducedMotion || !Number.isFinite(frame) ? 0 : ((Math.trunc(frame) % globe.length) + globe.length) % globe.length
  return {
    content: `${content} ${globe[phase]}${state.modal?.busy || !state.connected ? "" : queuedLine(detail, room)}`,
    tone: retry ? "warning" : state.modal?.busy || state.connected ? "accent" : "muted",
    animate: !reducedMotion,
  }
}

/** A second line while messages wait: the first line of the next one, and how many more follow. */
function queuedLine(detail: DashboardState["detail"], room: number) {
  const queue = waiting(detail?.pending).toSorted((a, b) => a.admittedSeq - b.admittedSeq)
  if (!queue.length) return ""
  const more = queue.length > 1 ? ` · ${queue.length - 1} more` : ""
  return `\n${label(`queued: ${queue[0]!.prompt.text.split("\n")[0]}`, Math.max(16, room - more.length))}${more}`
}

/** "Working (12s · Esc Esc or x to stop)", or "Running bash (4s · …)" while a tool runs. */
function working(state: DashboardState, detail: DashboardState["detail"]) {
  // History pages and older messages cannot identify the currently running tool or turn.
  const messages = state.history && state.historyCursor ? [] : (detail?.messages ?? [])
  const latest = messages.at(-1)
  const tool =
    latest?.type === "assistant"
      ? latest.content.find((part) => part.type === "tool" && part.state.status === "running")
      : undefined
  const started = messages.findLast((message) => message.type === "user")?.time.created
  // A turn older than a day is more likely a clock or unit mismatch than a real elapsed time.
  const elapsed =
    started && Date.now() >= started && Date.now() - started < 86_400_000 ? `${duration(Date.now() - started)} · ` : ""
  const action = tool?.type === "tool" ? `Running ${label(tool.name, 80).trim() || "tool"}` : "Working"
  return `${action} (${elapsed}${stopHint(state)})`
}

/** The stop hint comes before the reason, and only the end of the reason is cut to fit `room`. */
function retrying(retry: Retry, room: number) {
  const wait = retry.at - Date.now()
  const when = wait > 500 ? `in ${duration(wait)}` : "now"
  const head = `Retrying ${when} · attempt ${retry.attempt} · Esc Esc stops`
  if (!retry.message) return head
  return `${head} · ${label(retry.message, Math.max(16, Math.min(72, room - head.length - 3)))}`
}

function duration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`
}
