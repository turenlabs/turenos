import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { LocationServiceMap } from "@turenlabs/core/location-services"
import { EventV2 } from "@turenlabs/core/event"
import { SessionReviewer } from "@turenlabs/core/session/reviewer"
import { Installation } from "@/installation"
import {
  disposeAllInstancesAndEmitGlobalDisposed,
  invalidateInstanceStatesAndEmitConfigUpdated,
} from "@/server/global-lifecycle"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { Cause, Effect, Layer, Option, Queue, RcMap, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { ServerAuth } from "@/server/auth"
import { RootHttpApi } from "../api"
import { isLocalRequest } from "@/server/shared/local-request"
import { GlobalUpgradeInput } from "../groups/global"

// Every subscriber receives the same GlobalBusEvent object, so serializing per
// connection multiplies JSON.stringify cost by subscriber count — measurable
// under token-delta bursts with several attached streams. Cache the rendered
// frame on the event itself; entries die with the event once it leaves the
// backlog, so the map cannot grow unboundedly.
const frames = new WeakMap<GlobalBusEvent, Sse.Event>()

function eventData(data: GlobalBusEvent): Sse.Event {
  const hit = frames.get(data)
  if (hit) return hit
  // Wire ids let spec-compliant clients resume via Last-Event-ID. Synthetic
  // events are never replayed so they must not poison the client's cursor.
  const id = data.payload?.id
  const synthetic = data.payload?.type === "server.connected" || data.payload?.type === "server.heartbeat"
  const value: Sse.Event = {
    _tag: "Event",
    event: "message",
    id: synthetic || typeof id !== "string" ? undefined : id,
    data: JSON.stringify(data),
  }
  frames.set(data, value)
  return value
}

// The outbound half of the SSE response, extracted so the write-batching
// contract is directly testable: each element emitted is one socket write.
// Grouped bursts join into a single write — under load the ungrouped stream
// issued one write per event, saturating the loop in WriteString while health
// and storage requests starved.
export const encodeEvents = <E, R>(events: Stream.Stream<GlobalBusEvent, E, R>) =>
  events.pipe(
    Stream.map(eventData),
    Stream.pipeThroughChannel(Sse.encode()),
    Stream.groupedWithin(256, "10 millis"),
    Stream.map((chunk) => chunk.join("")),
    Stream.encodeText,
  )

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

// A stalled subscriber must fail and reconnect, not accumulate the whole event
// stream in process memory — the unbounded callback queue here was a heap-growth
// vector. Matches EventV2.allBounded semantics: drop the offer, then fail the
// stream with SubscriberOverflowError so the client resyncs on reconnect.
// The bound must also absorb normal bursts — a busy event loop starves the SSE
// writer while hundreds of events publish per tick, and at 256 a healthy client
// disconnected mid-burst, visibly refreshing every tab on reconnect. Match the
// EventV2 pubsub bound (8192) so only a genuinely stalled consumer overflows.
const subscriberCapacity = 8192

function eventResponse(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const cursor = request.headers["last-event-id"]
    const events = Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.make<GlobalBusEvent, EventV2.SubscriberOverflowError>({
          capacity: subscriberCapacity,
          strategy: "dropping",
        })
        const handler = (event: GlobalBusEvent) => {
          if (Queue.offerUnsafe(queue, event)) return
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(new EventV2.SubscriberOverflowError({ capacity: subscriberCapacity })),
          )
        }
        // Subscribe and snapshot the backlog in one synchronous block: Node is
        // single-threaded, so no emit can interleave — replayed events cover
        // the gap up to now and the handler covers everything after, with no
        // overlap.
        const replay = yield* Effect.sync(() => {
          GlobalBus.on("event", handler)
          const backlog = cursor === undefined ? undefined : GlobalBus.eventsAfter(cursor)
          return backlog !== undefined && backlog.length < subscriberCapacity ? backlog : undefined
        })
        const resume = cursor === undefined ? "initial" : replay === undefined ? "gap" : "ok"
        const connected: GlobalBusEvent = {
          directory: "global",
          payload: { id: EventV2.ID.create(), type: "server.connected", properties: { resume } },
        }
        return Stream.make(connected, ...(replay ?? [])).pipe(
          Stream.concat(Stream.fromQueue(queue)),
          Stream.ensuring(
            Effect.suspend(() => {
              GlobalBus.off("event", handler)
              return Queue.shutdown(queue)
            }),
          ),
        )
      }),
    )
    const heartbeat: Stream.Stream<GlobalBusEvent> = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      encodeEvents(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))).pipe(
        Stream.ensuring(Effect.logInfo("global event disconnected")),
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

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    const locations = yield* LocationServiceMap.Service
    const reviewer = yield* Effect.serviceOption(SessionReviewer.Service)

    const invalidateLocations = Effect.fn("GlobalHttpApi.invalidateLocations")(function* () {
      const refs = yield* RcMap.keys(locations.rcMap)
      yield* Effect.forEach([...refs], (ref) => locations.invalidate(ref), { discard: true })
    })

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      return yield* eventResponse(ctx.request)
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const update = Effect.gen(function* () {
        const result = yield* config.updateGlobal(ctx.payload)
        if (result.changed) {
          yield* invalidateLocations()
        }
        return result
      })
      const result = Option.isSome(reviewer)
        ? yield* reviewer.value.withConfigTransition(update, { invalidate: true })
        : yield* update
      if (result.changed) {
        bridge.fork(invalidateInstanceStatesAndEmitConfigUpdated({ swallowErrors: true }))
      }
      return result.info
    })

    const permissionChecksGet = Effect.fn("GlobalHttpApi.permissionChecksGet")(function* () {
      return { enforced: yield* PermissionChecks.enforced() }
    })

    const permissionChecksUpdate = Effect.fn("GlobalHttpApi.permissionChecksUpdate")(function* (ctx) {
      // Disabling enforcement turns every unresolved "ask" decision into "allow".
      // Remote callers may only reach this point when the server password already
      // authenticated them; on an auth-disabled server the mutation stays local.
      const request = yield* HttpServerRequest.HttpServerRequest
      const auth = yield* ServerAuth.Config
      if (!isLocalRequest(request) && !ServerAuth.required(auth)) {
        return yield* new HttpApiError.Forbidden({})
      }
      yield* PermissionChecks.set(ctx.payload.enforced)
      return { enforced: ctx.payload.enforced }
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("permissionChecksGet", permissionChecksGet)
      .handle("permissionChecksUpdate", permissionChecksUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
).pipe(Layer.provide(ServerAuth.Config.layer))
