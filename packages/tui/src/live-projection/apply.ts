import { finite, id, json, record, string } from "./guards"
import { partChange } from "./part-events"
import { room } from "./overlay"
import { stepSettled, stepStarted } from "./step-events"
import {
  MAX_EVENTS,
  MAX_PARTS,
  MAX_TEXT,
  type Assistant,
  type Change,
  type Data,
  type LiveEvent,
  type Overlay,
  type Projection,
} from "./types"

/** Validates one live event and folds it into the projection; false means it was ignored. */
export function applyEvent(p: Projection, event: LiveEvent): boolean {
  if (!record(event) || !id(event.id) || !string(event.type) || p.seen.has(event.id) || !record(event.data))
    return false
  const d = event.data
  if (d.sessionID !== p.session.id || !id(d.assistantMessageID) || !finite(d.timestamp)) return false
  const data = d as Data
  if (!json(d)) return forgetOversized(p, event.type, data, true)
  const current = p.active.get(data.assistantMessageID)
  const stored = p.base.find(
    (message): message is Assistant => message.id === data.assistantMessageID && message.type === "assistant",
  )
  const change = changeFor(event.type, data, current, stored)
  if (!change) return forgetOversized(p, event.type, data, false)
  if (change.next && change.partKey && !current?.parts.has(change.partKey) && p.partCount >= MAX_PARTS) return false
  if (!current) room(p)
  const overlay = current ?? { info: { ...change.info, content: [] }, settled: change.settled, parts: new Map() }
  overlay.info = { ...change.info, content: [] }
  overlay.settled = change.settled
  if (change.next && change.partKey) {
    if (!overlay.parts.has(change.partKey)) p.partCount++
    overlay.parts.set(change.partKey, {
      part: change.next,
      ended: change.ended!,
      snapshot: overlay.parts.get(change.partKey)?.snapshot,
      changed: true,
    })
  }
  p.active.set(data.assistantMessageID, overlay)
  p.seen.add(event.id)
  if (p.seen.size > MAX_EVENTS) p.seen.delete(p.seen.values().next().value!)
  return true
}

function changeFor(
  type: string,
  d: Data,
  current: Overlay | undefined,
  stored: Assistant | undefined,
): Change | undefined {
  const info = current?.info ?? stored
  const settled = current?.settled === true || stored?.time.completed !== undefined
  if (type === "session.next.step.started") return stepStarted(d, info, settled)
  if (type === "session.next.step.ended" || type === "session.next.step.failed")
    return stepSettled(type, d, info, settled)
  if (!info) return
  return partChange(type, d, info, current, stored, settled)
}

/**
 * A progress update too large to hold is rejected, but the overlay's earlier output would keep
 * overriding the fallback snapshot that follows. Dropping it lets the snapshot's output show.
 */
function forgetOversized(p: Projection, type: string, d: Data, anySize: boolean) {
  if (type !== "session.next.tool.progress" || !id(d.callID)) return false
  const big =
    anySize ||
    (Array.isArray(d.content) &&
      d.content.some((item) => record(item) && string(item.text) && item.text.length > MAX_TEXT))
  const overlay = p.active.get(d.assistantMessageID)
  const name = `tool:${d.callID}`
  const live = overlay?.parts.get(name)
  if (!big || !live || live.ended) return false
  overlay!.parts.delete(name)
  p.partCount--
  return false
}
