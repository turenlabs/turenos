import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, LayerMap, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@turenlabs/core/control-plane/move-session"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationError, LocationServices } from "@turenlabs/core/location-services"
import { ProjectV2 } from "@turenlabs/core/project"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { Storage } from "@turenlabs/core/storage"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { InstanceStore } from "@/project/instance-store"
import { ServerAuth } from "@/server/auth"
import { RootHttpApi } from "@/server/routes/instance/httpapi/api"
import { SecurityPaths } from "@/server/routes/instance/httpapi/groups/security"
import { controlHandlers } from "@/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "@/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "@/server/routes/instance/httpapi/handlers/global"
import { makeSecurityHandlers, securityHandlers } from "@/server/routes/instance/httpapi/handlers/security"
import { storageHandlers } from "@/server/routes/instance/httpapi/handlers/storage"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const storageLayer = LayerNode.compile(LayerNode.group([Database.node, Storage.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])

function configLayer() {
  return Layer.mock(Config.Service)({
    getGlobal: () => Effect.succeed({}),
    updateGlobal: (patch) => Effect.succeed({ info: patch, changed: Object.keys(patch).length > 0 }),
  })
}

function apiLayer(password: Option.Option<string>, handlers = securityHandlers) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, handlers, storageHandlers]),
      Layer.provide(Layer.mock(Auth.Service)({})),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(configLayer()),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(
      Layer.mock(InstanceStore.Service)({
        disposeAll: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(Installation.Service)({
        method: () => Effect.succeed("npm"),
        latest: () => Effect.succeed("9.9.9"),
        upgrade: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.effect(
        LocationServiceMap.Service,
        LayerMap.make(() => Layer.empty as Layer.Layer<LocationServices, LocationError>),
      ),
    ),
    Layer.provide(Layer.mock(ProjectV2.Service)({})),
    Layer.provideMerge(ExtensionRuntime.layer),
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(SecretVault.ephemeral),
    Layer.provide(ServerAuth.Config.configLayer({ password, username: "opencode" })),
  )
}

const itMcpRuntime = testEffect(
  apiLayer(
    Option.none(),
    makeSecurityHandlers(async () => ({
      status: "qualified",
      checkedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      revision: 1,
      executable: "/usr/local/bin/docker",
      version: "28.0",
      capabilities: ["network-none", "read-only-rootfs"],
    })),
  ),
)
const itMcpRuntimeFailure = testEffect(
  apiLayer(
    Option.none(),
    makeSecurityHandlers(async () => {
      throw new Error("Docker executable could not start: token=runtime-secret")
    }),
  ),
)

describe("security integrations HttpApi storage", () => {
  itMcpRuntimeFailure.live("returns a sanitized qualification failure instead of an internal error", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(`${SecurityPaths.mcpRuntime}/test`)
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(JSON.stringify(body)).not.toContain("runtime-secret")
      expect(body).toMatchObject({
        backends: expect.arrayContaining([
          expect.objectContaining({
            backend: "docker",
            status: "failed",
            detail: "Docker executable could not start: token=[REDACTED]",
          }),
        ]),
      })
    }),
  )

  itMcpRuntime.live("persists MCP backend selection and returns a qualified Docker capability report", () =>
    Effect.gen(function* () {
      const initial = yield* HttpClient.get(SecurityPaths.mcpRuntime)
      expect(initial.status).toBe(200)
      expect(yield* initial.json).toMatchObject({
        settings: { version: 1, backend: "docker", localProcess: { enabled: false } },
        backends: expect.arrayContaining([expect.objectContaining({ backend: "qemu", selectable: false })]),
      })

      const selected = yield* HttpClientRequest.patch(SecurityPaths.mcpRuntime).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ backend: "local" })),
        HttpClient.execute,
      )
      expect(selected.status).toBe(200)
      expect(yield* selected.json).toMatchObject({
        settings: { backend: "local", localProcess: { enabled: true } },
      })

      const qualified = yield* HttpClient.post(`${SecurityPaths.mcpRuntime}/test`)
      expect(qualified.status).toBe(200)
      expect(yield* qualified.json).toMatchObject({
        backends: expect.arrayContaining([
          expect.objectContaining({
            backend: "docker",
            status: "qualified",
            version: "28.0",
            capabilities: ["network-none", "read-only-rootfs"],
          }),
        ]),
      })
    }),
  )
})
