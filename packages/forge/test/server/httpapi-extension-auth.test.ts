import { NodeHttpServer } from "@effect/platform-node"
import { Session } from "@/session/session"
import { ServerAuth } from "@/server/auth"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { ExtensionApi } from "../../src/server/routes/instance/httpapi/groups/extension"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"

const TestHttpApi = HttpApi.make("extension-auth-test").addHttpApi(ExtensionApi)
const extensionReadHandlers = HttpApiBuilder.group(TestHttpApi, "extensionRead", (group) =>
  group.handle("list", () => Effect.succeed([])),
)
const extensionHandlers = HttpApiBuilder.group(TestHttpApi, "extensions", (group) =>
  Effect.succeed(group.handle("update", () => Effect.succeed([]))),
)
const instanceContext = Layer.succeed(
  InstanceContextMiddleware,
  InstanceContextMiddleware.of((effect) => effect),
)
const workspaceRouting = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: process.cwd() })),
  ),
)
const server = HttpRouter.serve(
  HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide([extensionReadHandlers, extensionHandlers]),
    Layer.provide([authorizationLayer, instanceContext, workspaceRouting, Layer.mock(Session.Service)({})]),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.some("extension-secret"), username: "forge" })),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
const it = testEffect(server)

describe("Extension HttpApi authorization", () => {
  it.live("protects list and update with server credentials", () =>
    Effect.gen(function* () {
      expect((yield* HttpClient.get("/extension")).status).toBe(401)
      expect(
        (yield* HttpClientRequest.patch("/extension/turenlabs%2Fcustomize-forge").pipe(
          HttpClientRequest.setBody(HttpBody.jsonUnsafe({ enabled: false })),
          HttpClient.execute,
        )).status,
      ).toBe(401)

      const authorization = ServerAuth.header({ username: "forge", password: "extension-secret" })!
      expect(
        (yield* HttpClientRequest.get("/extension").pipe(
          HttpClientRequest.setHeader("authorization", authorization),
          HttpClient.execute,
        )).status,
      ).toBe(200)
    }),
  )
})
