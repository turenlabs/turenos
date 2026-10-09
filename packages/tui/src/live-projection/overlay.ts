import { key } from "./guards"
import { MAX_MESSAGES, type Assistant, type Messages, type Overlay, type Projection } from "./types"

/** Evicts the oldest overlay once the message limit is reached. */
export function room(p: Projection) {
  if (p.active.size < MAX_MESSAGES) return
  const oldest = p.active.keys().next().value
  if (oldest === undefined) return
  p.partCount -= p.active.get(oldest)!.parts.size
  p.active.delete(oldest)
}

/** The snapshot with every overlay merged in, then overlays for messages the snapshot lacks. */
export function messages(p: Projection): Messages {
  const result: Messages[number][] = []
  const included = new Set<string>()
  for (const message of p.base) {
    included.add(message.id)
    const overlay = p.active.get(message.id)
    result.push(message.type === "assistant" && overlay ? merge(message, overlay) : message)
  }
  for (const [messageID, overlay] of p.active) {
    if (!included.has(messageID)) result.push(merge(overlay.info, overlay))
  }
  return result
}

function merge(info: Assistant, overlay: Overlay): Assistant {
  const used = new Set<string>()
  const parts = info.content.map((original) => {
    const name = key(original)
    used.add(name)
    const live = overlay.parts.get(name)
    if (!live) return original
    if (live.ended) return live.part
    const part = live.snapshot ?? original
    if (part.type !== "tool" && live.part.type !== "tool") {
      return live.part.text.startsWith(part.text) ? live.part : part
    }
    if (part.type === "tool" && live.part.type === "tool") {
      const rank = { pending: 0, running: 1, completed: 2, error: 2 }
      if (rank[part.state.status] > rank[live.part.state.status]) return part
      if (part.state.status === "pending" && live.part.state.status === "pending") {
        return live.part.state.input.startsWith(part.state.input) ? live.part : part
      }
    }
    return live.part
  })
  for (const [name, live] of overlay.parts) if (!used.has(name)) parts.push(live.part)
  return { ...info, ...(overlay.settled ? overlay.info : {}), content: parts }
}
