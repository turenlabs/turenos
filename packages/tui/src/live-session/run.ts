import type { LiveEvent } from "../live-events"
import type { LiveSession } from "./context"
import { current, dropSession, paint, snapshot } from "./schedule"
import { settleBusy, trackSequence } from "./sequence"
import { trackRetry } from "./retry"

/** Consumes the global event stream, reconnecting with backoff and falling back to polling between attempts. */
export async function run(s: LiveSession) {
  const { state, abort } = s
  while (!abort.signal.aborted && !state.closed) {
    const started = Date.now()
    try {
      for await (const event of s.connection.events(abort.signal)) {
        if (state.closed || abort.signal.aborted) break
        handle(s, event)
      }
    } catch {
      // Snapshot polling remains available when live events are unsupported or interrupted.
    }
    if (state.closed || abort.signal.aborted) break
    const wasLive = state.streamStatus === "live"
    s.selected = ""
    s.projection = undefined
    state.streamStatus = "polling"
    s.hooks.status()
    if (wasLive) snapshot(s)
    // A stream that lived a while earns a fresh backoff; one that drops right after connecting does not.
    if (Date.now() - started > 10_000) s.retry = 250
    await wait(abort.signal, s.retry)
    s.retry = Math.min(s.retry * 2, 5000)
  }
}

function handle(s: LiveSession, event: LiveEvent) {
  const { state } = s
  if (event.type === "server.connected") return connected(s)
  const sessionID = event.data.sessionID
  settleBusy(s, event)
  if (trackRetry(state, event)) s.hooks.status()
  // Deltas are not durable and cannot be replayed, so a jump can only be repaired by refetching the transcript.
  const gap = trackSequence(s, event)
  if (typeof sessionID === "string" && /^session\.next\.revert\.(staged|cleared|committed)$/.test(event.type)) {
    s.hooks.invalidate?.(sessionID)
    dropSession(s, sessionID)
    if (sessionID === state.selected) snapshot(s, sessionID, true)
    return
  }
  if (state.tab !== "sessions") {
    s.selected = ""
    s.projection = undefined
    return
  }
  if (typeof sessionID !== "string" || sessionID !== state.selected) return
  if (state.snapshot?.sessions.find((session) => session.id === sessionID)?.revert) return
  const changed = current(s, sessionID)?.apply(event)
  if (changed) {
    if (state.snapshot && (event.type === "session.next.step.started" || event.type === "session.next.tool.called"))
      state.snapshot.active = { ...state.snapshot.active, [sessionID]: { type: "running" } }
    paint(s, sessionID)
  }
  if (gap || !changed || /\.(ended|failed|success)$/.test(event.type)) snapshot(s, sessionID)
}

function connected(s: LiveSession) {
  s.hooks.invalidate?.()
  s.selected = ""
  s.projection = undefined
  s.state.streamStatus = "live"
  s.hooks.status()
  if (s.snapshotTimer) clearTimeout(s.snapshotTimer)
  s.snapshotTimer = undefined
  snapshot(s, undefined, true)
}

function wait(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
  })
}
