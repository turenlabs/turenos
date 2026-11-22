import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

export type GlobalEventFrame = {
  readonly _tag: "Event"
  readonly event: "message"
  readonly id: string | undefined
  readonly cursor: string | undefined
  readonly data: string
  readonly bytes: number
}

export const BacklogLimit = 16_384
const replayByteBudget = 32 * 1024 * 1024
const frames = new WeakMap<GlobalEvent, GlobalEventFrame>()

export function globalEventFrame(event: GlobalEvent): GlobalEventFrame {
  const existing = frames.get(event)
  if (existing) return existing

  const id = event.payload?.id
  const type = event.payload?.type
  // Handshake and heartbeat IDs are absent on the wire so they cannot replace a replay cursor.
  const synthetic = type === "server.connected" || type === "server.heartbeat"
  const frameID = synthetic || typeof id !== "string" ? undefined : id
  const data = JSON.stringify(event)
  const frame: GlobalEventFrame = {
    _tag: "Event",
    event: "message",
    id: frameID,
    // A sync copy can share the preceding live ID. It is replayed but cannot
    // anchor a resume after the corresponding live frame has been evicted.
    cursor: type === "sync" ? undefined : frameID,
    data,
    // Budget for two bytes per retained string code unit regardless of the runtime's encoding.
    bytes: 2 * (data.length + (frameID?.length ?? 0)),
  }
  frames.set(event, frame)
  return frame
}

export class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  readonly #backlog = new Array<GlobalEventFrame | undefined>(BacklogLimit)
  #start = 0
  #count = 0
  #bytes = 0

  constructor(private readonly byteBudget = replayByteBudget) {
    // One listener per live SSE stream. Keep a finite cap so a listener leak still warns.
    super()
    this.setMaxListeners(64)
  }

  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }

    this.#remember(event)
    return super.emit(eventName, event)
  }

  // Replay owns serialized strings only. The weak frame cache lets live subscribers
  // share those same strings without keeping the original event graph in the backlog.
  #remember(event: GlobalEvent) {
    let frame: GlobalEventFrame | undefined
    try {
      frame = globalEventFrame(event)
    } catch {
      // An unserializable event breaks replay continuity, but in-process listeners still receive it.
    }

    const bytes = frame?.bytes ?? Infinity
    while (this.#count > 0 && (this.#count === BacklogLimit || this.#bytes + bytes > this.byteBudget)) {
      const evicted = this.#backlog[this.#start]!
      this.#backlog[this.#start] = undefined
      this.#start = (this.#start + 1) % BacklogLimit
      this.#count--
      this.#bytes -= evicted.bytes
    }

    if (!frame || bytes > this.byteBudget) return
    this.#backlog[(this.#start + this.#count) % BacklogLimit] = frame
    this.#count++
    this.#bytes += bytes
  }

  eventsAfter(id: string): GlobalEventFrame[] | undefined {
    for (let offset = 0; offset < this.#count; offset++) {
      if (this.#backlog[(this.#start + offset) % BacklogLimit]?.cursor !== id) continue
      return Array.from(
        { length: this.#count - offset - 1 },
        (_, index) => this.#backlog[(this.#start + offset + index + 1) % BacklogLimit]!,
      )
    }
    return undefined
  }
}

export const GlobalBus = new GlobalBusEmitter()
