import { json, key } from "./guards"
import { room, messages } from "./overlay"
import {
  MAX_MESSAGES,
  MAX_PARTS,
  MAX_TEXT,
  type Assistant,
  type Messages,
  type Overlay,
  type Projection,
} from "./types"

export function snapshot(p: Projection, input: Messages): Messages {
  // The caller supplies accepted latest pages, never history pages. A shared row
  // marks the old prefix; no overlap means the entire previous page rolled out.
  // Only previously persisted overlays expire, so in-flight live messages survive.
  // IDs and timestamps are not ordering keys (the server pages by its private seq).
  const included = new Set(input.map((message) => message.id))
  const firstShared = p.base.findIndex((message) => included.has(message.id))
  const expired = new Set(
    input.length ? p.base.slice(0, firstShared < 0 ? undefined : firstShared).map((message) => message.id) : [],
  )
  if (expired.size)
    for (const [id, overlay] of p.active) {
      if (!overlay.settled || !expired.has(id)) continue
      p.partCount -= overlay.parts.size
      p.active.delete(id)
    }
  p.base = input
  // Seed only incomplete recent messages. Existing cursors must not move when GET is ahead.
  for (const message of input.slice(-MAX_MESSAGES)) {
    if (message.type !== "assistant") continue
    if (message.time.completed !== undefined) {
      const completed = p.active.get(message.id)
      if (completed) {
        p.partCount -= completed.parts.size
        p.active.delete(message.id)
      }
      continue
    }
    let overlay = p.active.get(message.id)
    if (!overlay) {
      room(p)
      overlay = { info: { ...message, content: [] }, settled: false, parts: new Map() }
      p.active.set(message.id, overlay)
    }
    seedParts(p, overlay, message)
  }
  return messages(p)
}

function seedParts(p: Projection, overlay: Overlay, message: Assistant) {
  for (const part of message.content) {
    const existing = overlay.parts.get(key(part))
    if (existing) {
      const prior = existing.snapshot
      if (part.type !== "tool" && part.text.length <= MAX_TEXT) {
        existing.snapshot = prior && prior.type !== "tool" && prior.text.startsWith(part.text) ? prior : part
      }
      if (part.type === "tool" && !existing.changed && json(part)) existing.part = part
      continue
    }
    if (p.partCount >= MAX_PARTS) continue
    // Oversized snapshot values remain authoritative history, not live buffers.
    if (
      (part.type !== "tool" && part.text.length > MAX_TEXT) ||
      (part.type === "tool" && (!json(part) || (part.state.status === "pending" && part.state.input.length > MAX_TEXT)))
    )
      continue
    overlay.parts.set(key(part), { part, ended: false })
    p.partCount++
  }
}
