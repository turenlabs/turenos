import { label, type DashboardState } from "./state"

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

export type ActivityFrame = {
  content: string
  tone: "muted" | "accent" | "warning" | "error"
  animate: boolean
}

export function activityFrame(state: DashboardState, frame: number, reducedMotion: boolean): ActivityFrame | undefined {
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

  // History pages and older messages cannot identify the currently running tool.
  const latest = state.history && state.historyCursor ? undefined : detail?.messages.at(-1)
  const tool =
    latest?.type === "assistant"
      ? latest.content.find((part) => part.type === "tool" && part.state.status === "running")
      : undefined
  const content = state.modal?.busy
    ? state.modal.editor
      ? "Sending message"
      : "Applying request"
    : !state.connected
      ? "Connecting"
      : tool?.type === "tool"
        ? `Running ${label(tool.name, 80).trim() || "tool"}`
        : "Working"

  const phase =
    reducedMotion || !Number.isFinite(frame) ? 0 : ((Math.trunc(frame) % globe.length) + globe.length) % globe.length
  return {
    content: `${content} ${globe[phase]}`,
    tone: state.modal?.busy || state.connected ? "accent" : "muted",
    animate: !reducedMotion,
  }
}
