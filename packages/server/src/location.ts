import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-services"
import { PtyID } from "@turenlabs/core/pty/schema"
import { PtyTicket } from "@turenlabs/core/pty/ticket"
import { AbsolutePath } from "@turenlabs/core/schema"
import { WorkspaceV2 } from "@turenlabs/core/workspace"
import { PTY_CONNECT_TICKET_QUERY } from "@turenlabs/protocol/groups/pty"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { CorsConfig, isAllowedRequestOrigin } from "./cors"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@forge/HttpApiLocation",
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

function ref(request: HttpServerRequest.HttpServerRequest): Location.Ref | undefined {
  const query = new URL(request.url, "http://localhost").searchParams
  const value = (plain: string, scoped: string) => {
    const plainValue = query.get(plain)
    const scopedValue = query.get(scoped)
    if (plainValue !== null && scopedValue !== null && plainValue !== scopedValue) return
    return plainValue ?? scopedValue
  }
  const workspaceQuery = value("workspace", "location[workspace]")
  const directoryQuery = value("directory", "location[directory]")
  if (workspaceQuery === undefined || directoryQuery === undefined) return
  const workspaceID = workspaceQuery || request.headers["x-forge-workspace"]
  const directory =
    directoryQuery ||
    (request.headers["x-forge-directory"] ? decode(request.headers["x-forge-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    return LocationMiddleware.of((effect, { group, endpoint }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const location = ref(request)
        if (!location) {
          return HttpServerResponse.text("Conflicting location query parameters", {
            status: 400,
            contentType: "text/plain; charset=utf-8",
          })
        }
        if (group.identifier === "server.pty" && endpoint.name === "pty.connect") {
          // Authorize before building Location services or revealing PTY existence.
          // Basic auth alone cannot protect browser WebSocket upgrades; every
          // connection needs a scoped single-use ticket, consumed only here.
          if (!isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors))
            return HttpServerResponse.empty({ status: 403 })
          const ticket = new URL(request.url, "http://localhost").searchParams.get(PTY_CONNECT_TICKET_QUERY)
          const route = yield* HttpRouter.RouteContext
          const ptyID = Schema.decodeUnknownOption(PtyID)(route.params.ptyID)
          if (!ticket || Option.isNone(ptyID)) return HttpServerResponse.empty({ status: 403 })
          const valid = yield* tickets.consume({
            ticket,
            ptyID: ptyID.value,
            directory: location.directory,
            workspaceID: location.workspaceID,
          })
          if (!valid) return HttpServerResponse.empty({ status: 403 })
        }
        return yield* effect.pipe(Effect.provide(locations.get(location)))
      }),
    )
  }),
)
