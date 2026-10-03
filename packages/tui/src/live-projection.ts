import type { Session } from "./server"
import { applyEvent } from "./live-projection/apply"
import { messages } from "./live-projection/overlay"
import { snapshot } from "./live-projection/snapshot"
import type { LiveEvent, Messages, Projection } from "./live-projection/types"

export type { LiveEvent } from "./live-projection/types"

/**
 * Snapshot inputs have already passed the client's response validation.
 * A live cursor is anchored once, never advanced by a later snapshot. Presentation
 * chooses the longer prefix-compatible value; full ended values always replace it.
 * There is no protocol offset tying GET to SSE: orphan deltas are dropped, and
 * conflicting (non-prefix) snapshots win presentation until a full ended value.
 * The caller must establish its initial GET/SSE ordering and recreate on reconnect.
 * Limits apply to live overlays, not to the caller's validated history page.
 */
export function createLiveProjection(session: Session) {
  const p: Projection = { session, base: [], active: new Map(), seen: new Set(), partCount: 0 }
  return {
    apply: (event: LiveEvent) => applyEvent(p, event),
    snapshot: (input: Messages) => snapshot(p, input),
    messages: () => messages(p),
  }
}
