import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, LayerMap, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@turenlabs/core/control-plane/move-session"
import { Database } from "@turenlabs/core/database/database"
import { AbsolutePath } from "@turenlabs/core/schema"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationError, LocationServices } from "@turenlabs/core/location-services"
import { ProjectV2 } from "@turenlabs/core/project"
import { SessionV2 } from "@turenlabs/core/session"
import { Storage } from "@turenlabs/core/storage"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { securityHandlers } from "../../src/server/routes/instance/httpapi/handlers/security"
import { storageHandlers } from "../../src/server/routes/instance/httpapi/handlers/storage"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { Auth } from "@/auth"

const input = MoveSession.Input.make({
  sessionID: SessionV2.ID.make("ses_move"),
  destination: { directory: AbsolutePath.make("/destination") },
  moveChanges: true,
})
const called = Ref.makeUnsafe<MoveSession.Input | undefined>(undefined)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, securityHandlers, storageHandlers]),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(() => Layer.empty as Layer.Layer<LocationServices, LocationError>),
    ),
  ),
  Layer.provide(Layer.mock(ProjectV2.Service)({})),
  Layer.provide(ExtensionRuntime.layer),
  Layer.provide(Layer.mock(Storage.Service)({})),
  Layer.provide(SecretVault.ephemeral),
  Layer.provide(Layer.mock(InstanceStore.Service)({ disposeAll: () => Effect.void })),
  Layer.provide(Database.layerFromPath(":memory:")),
  Layer.provide(
    Layer.mock(MoveSession.Service)({
      moveSession: (value) => Ref.set(called, value),
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("control-plane HttpApi", () => {
  it.live("moves a session through the root control-plane route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(input)),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(yield* Ref.get(called)).toEqual(input)
    }),
  )
})
