import type { LiveEvent } from "../live-events"
import type { LiveSession } from "./context"

const MAX_AGGREGATES = 512

/** Records a durable event's `seq`; true when events between it and the previous one were missed. */
export function trackSequence(s: LiveSession, event: LiveEvent) {
  if (!event.durable) return false
  const { aggregateID, seq } = event.durable
  const last = s.seqs.get(aggregateID)
  s.seqs.delete(aggregateID)
  s.seqs.set(aggregateID, Math.max(seq, last ?? seq))
  if (s.seqs.size > MAX_AGGREGATES) s.seqs.delete(s.seqs.keys().next().value!)
  return last !== undefined && seq > last + 1
}

/**
 * The final `step.ended` of a turn means the session stopped working. The active map is
 * rebuilt only by the 2 s poll, so clear the marker now and let the next poll reconcile.
 */
export function settleBusy(s: LiveSession, event: LiveEvent) {
  const sessionID = event.data.sessionID
  if (event.type !== "session.next.step.ended" || typeof sessionID !== "string") return
  if (event.data.finish === "tool-calls" || typeof event.data.finish !== "string") return
  const snapshot = s.state.snapshot
  if (!snapshot || !Object.hasOwn(snapshot.active, sessionID)) return
  snapshot.active = Object.fromEntries(Object.entries(snapshot.active).filter(([id]) => id !== sessionID))
  s.hooks.status()
}
