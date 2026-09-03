import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-services"
import { AbsolutePath } from "@turenlabs/core/schema"
import { WorkspaceV2 } from "@turenlabs/core/workspace"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

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
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const location = ref(request)
        if (!location) {
          return HttpServerResponse.text("Conflicting location query parameters", {
            status: 400,
            contentType: "text/plain; charset=utf-8",
          })
        }
        return yield* effect.pipe(Effect.provide(locations.get(location)))
      }),
    )
  }),
)
