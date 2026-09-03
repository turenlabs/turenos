import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { httpClient } from "@turenlabs/core/effect/app-node-platform"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { EventV2 } from "@turenlabs/core/event"
import { Credential } from "@turenlabs/core/credential"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { PtyTicket } from "@turenlabs/core/pty/ticket"
import { Retention } from "@turenlabs/core/retention"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionHarness } from "@turenlabs/core/session/harness"
import { SessionReviewer } from "@turenlabs/core/session/reviewer"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import { Memory } from "@turenlabs/core/memory"
import { Loop } from "@turenlabs/core/loop"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { TeamBoard } from "@turenlabs/core/team/board"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  SessionHarness.node,
  SessionReviewer.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  Retention.sweepNode,
  SessionV2.node,
  SessionExecution.node,
  SessionTaskV2.node,
  TeamBoard.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  Memory.node,
  Loop.node,
])

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "forge", password: Option.some(password) })
      : ServerAuth.Config.layer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "forge", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [[SessionExecution.node, SessionExecutionLocal.node]])

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
