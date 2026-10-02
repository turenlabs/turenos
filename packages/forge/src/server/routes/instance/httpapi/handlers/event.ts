import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@turenlabs/core/event"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

// Every subscriber receives the same underlying event, so serializing per
// connection multiplies JSON.stringify cost by subscriber count — measurable
// under token-delta bursts with several attached streams. Cache the wire shape
// on the source event and the rendered frame on the wire object; both die with
// the event, so the maps cannot grow unboundedly.
const wires = new WeakMap<object, { id: string; type: string; properties: unknown }>()
const frames = new WeakMap<object, Sse.Event>()

function wireFor(event: { id: string; type: string; data: unknown }) {
  const hit = wires.get(event)
  if (hit) return hit
  const wire = { id: event.id, type: event.type, properties: event.data }
  wires.set(event, wire)
  return wire
}

function eventData(data: { id: string; type: string; properties: unknown }): Sse.Event {
  const hit = frames.get(data)
  if (hit) return hit
  const value: Sse.Event = {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
  frames.set(data, value)
  return value
}

function eventID() {
  return EventV2.ID.create()
}

// A stalled subscriber must fail and reconnect, not accumulate the whole event
// stream in process memory — the unbounded queue here was a heap-growth vector.
// The bound must still absorb normal burst traffic: a busy event loop starves
// the SSE writer while drains publish hundreds of events per tick (shell
// output, fleet task updates, text deltas), and at 256 a healthy client
// disconnected mid-burst and flapped the UI on every reconnect. Match the
// EventV2 pubsub bound so only a genuinely stalled consumer overflows.
const subscriberCapacity = 8192

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const live = yield* EventV2.allBounded(events, subscriberCapacity)
    // An unlocated event cannot be routed to any instance, so the filter below
    // drops it exactly like an event belonging to another directory. That is the
    // safety property the filter exists for, but it is also indistinguishable
    // from delivery lost because a publisher ran outside a Location scope, so
    // report it instead of dropping it silently. Locations that simply belong to
    // another instance are ordinary routing and stay quiet, and each type is
    // reported once per connection so a systematically unlocated event cannot
    // flood the log.
    const unlocated = new Set<string>()
    const stream = live.pipe(
      Stream.tap((event) =>
        event.location !== undefined || unlocated.has(event.type)
          ? Effect.void
          : Effect.sync(() => unlocated.add(event.type)).pipe(
              Effect.andThen(
                Effect.logWarning("Dropping event published without a location").pipe(
                  Effect.annotateLogs({ eventType: event.type, directory: instance.directory }),
                ),
              ),
            ),
      ),
      Stream.filter(
        (event) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID),
      ),
      Stream.map(wireFor),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>(
      (queue) => {
        const listener = (event: {
          directory?: string
          payload: { id?: string; type?: string; properties?: unknown }
        }) => {
          if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
          Queue.offerUnsafe(queue, {
            id: event.payload.id ?? eventID(),
            type: "server.instance.disposed",
            properties: event.payload.properties ?? {},
          })
        }
        return Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", listener)),
          () => Effect.sync(() => GlobalBus.off("event", listener)),
        )
      },
      { bufferSize: 16 },
    )
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        // Join bursts into a single write — under load the stream otherwise
        // issues one socket write per event, which is what saturates the event
        // loop when hundreds of events publish per tick.
        Stream.groupedWithin(256, "10 millis"),
        Stream.map((chunk) => chunk.join("")),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
