import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, LayerMap, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { InstanceStore } from "../../src/project/instance-store"
import { MoveSession } from "@turenlabs/core/control-plane/move-session"
import { Database } from "@turenlabs/core/database/database"
import { Storage } from "@turenlabs/core/storage"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationError, LocationServices } from "@turenlabs/core/location-services"
import { ProjectV2 } from "@turenlabs/core/project"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { securityHandlers } from "../../src/server/routes/instance/httpapi/handlers/security"
import { storageHandlers } from "../../src/server/routes/instance/httpapi/handlers/storage"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { Auth } from "@/auth"

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
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(InstanceStore.Service)({ disposeAll: () => Effect.void })),
  Layer.provide(
    Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(() => Layer.empty as Layer.Layer<LocationServices, LocationError>),
    ),
  ),
  Layer.provide(Layer.mock(ProjectV2.Service)({})),
  Layer.provide(ExtensionRuntime.layer),
  Layer.provide(AppNodeBuilder.build(Storage.node)),
  Layer.provide(SecretVault.ephemeral),
  Layer.provide(Database.layerFromPath(":memory:")),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("stores the permission check policy in Forge storage", () =>
    Effect.gen(function* () {
      const initial = yield* HttpClient.get(GlobalPaths.permissionChecks)
      expect(initial.status).toBe(200)
      expect(yield* initial.json).toEqual({ enforced: false })

      const updated = yield* HttpClientRequest.put(GlobalPaths.permissionChecks).pipe(
        HttpClientRequest.bodyJsonUnsafe({ enforced: true }),
        HttpClient.execute,
      )
      expect(updated.status).toBe(200)
      expect(yield* updated.json).toEqual({ enforced: true })

      const stored = yield* HttpClient.get(GlobalPaths.permissionChecks)
      expect(yield* stored.json).toEqual({ enforced: true })
    }),
  )

  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )
})
