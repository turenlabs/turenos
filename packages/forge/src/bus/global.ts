import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

// Recent events kept so a reconnecting subscriber can be replayed the events it
// missed instead of forcing a full client resync. Trimmed in chunks so push
// stays amortized O(1); effective window is always at least BacklogLimit.
export const BacklogLimit = 16_384

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  #backlog: GlobalEvent[] = []

  constructor() {
    // One listener per live SSE stream — tabs, CLI attaches, SDK consumers.
    // A dozen concurrent subscribers is normal load, not a leak; keep the cap
    // finite so a listener leak still warns.
    super()
    this.setMaxListeners(64)
  }

  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    this.#backlog.push(event)
    if (this.#backlog.length > BacklogLimit * 2) this.#backlog.splice(0, BacklogLimit)
    return super.emit(eventName, event)
  }

  // Events emitted after the one carrying `id`, or undefined when that id is no
  // longer in the backlog — the subscriber fell too far behind to replay.
  eventsAfter(id: string): GlobalEvent[] | undefined {
    const index = this.#backlog.findIndex((event) => event.payload?.id === id)
    return index === -1 ? undefined : this.#backlog.slice(index + 1)
  }
}

export const GlobalBus = new GlobalBusEmitter()
