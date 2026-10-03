export * as ServerEvent from "./server-event"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"

export const Connected = Event.define({
  type: "server.connected",
  schema: {
    // How the subscriber should treat the stream after this connect:
    // "initial" — first subscribe, bootstrap normally; "ok" — the client's
    // Last-Event-ID cursor was honored and missed events are being replayed, so
    // no resync is needed; "gap" — the cursor is stale or unknown, resync.
    resume: optional(Schema.Literals(["initial", "ok", "gap"])),
  },
})
export const Disposed = Event.define({ type: "global.disposed", schema: {} })
export const ConfigUpdated = Event.define({ type: "config.updated", schema: {} })

export const Definitions = Event.inventory(Connected, Disposed, ConfigUpdated)
