import { createLiveProjection } from "../live-projection"
import type { LiveSession } from "./context"

/** The selected session's projection, created on first use and dropped while an undo is staged. */
export function current(s: LiveSession, sessionID: string) {
  if (s.selected !== sessionID) {
    s.selected = sessionID
    s.projection = undefined
    if (s.paintTimer) clearTimeout(s.paintTimer)
    s.paintTimer = undefined
  }
  const session = s.state.snapshot?.sessions.find((item) => item.id === sessionID)
  if (session?.revert) {
    s.projection = undefined
    return
  }
  if (!s.projection && session) s.projection = createLiveProjection(session)
  return s.projection
}

/** Forgets the projection and any pending paint for `sessionID`, if it is the one being tracked. */
export function dropSession(s: LiveSession, sessionID: string) {
  if (s.selected !== sessionID) return
  s.projection = undefined
  if (s.paintTimer) clearTimeout(s.paintTimer)
  s.paintTimer = undefined
}

/** Debounced snapshot refresh; a metadata request upgrades any pending refresh to a full one. */
export function snapshot(s: LiveSession, sessionID?: string, metadata = false) {
  const { state } = s
  s.metadataRefresh ||= metadata
  if (s.snapshotTimer) return
  s.snapshotTimer = setTimeout(() => {
    s.snapshotTimer = undefined
    const full = s.metadataRefresh
    s.metadataRefresh = false
    if (
      state.closed ||
      s.abort.signal.aborted ||
      state.tab !== "sessions" ||
      (!full && (state.history || state.modal?.inline))
    )
      return
    if (!full && sessionID !== undefined && sessionID !== state.selected) return
    s.hooks.snapshot(full)
  }, 100)
}

export function paint(s: LiveSession, sessionID: string) {
  const { state } = s
  if (s.paintTimer) return
  s.paintTimer = setTimeout(() => {
    s.paintTimer = undefined
    if (
      state.closed ||
      s.abort.signal.aborted ||
      state.selected !== sessionID ||
      s.selected !== sessionID ||
      state.tab !== "sessions" ||
      state.history ||
      state.modal?.inline ||
      state.detail?.sessionID !== sessionID
    )
      return
    if (s.projection) s.hooks.paint(s.projection.messages())
  }, 50)
}
