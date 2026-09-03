export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@turenlabs/schema/event"
import { EventManifest } from "@turenlabs/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
