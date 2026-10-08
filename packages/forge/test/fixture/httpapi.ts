import { Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { Memory } from "@turenlabs/core/memory"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createRoutes } from "@turenlabs/server/routes"

export function createTestHttpApi(input: { name: string; directory: string; authorization: string }) {
  const app = HttpRouter.toWebHandler(
    createRoutes(input.name).pipe(
      Layer.provide(HttpServer.layerServices),
      Layer.provideMerge(
        AppNodeBuilder.build(
          LayerNode.group([Memory.node, Loop.node, TeamWorkspace.node, PermissionSaved.node, SessionV2.node]),
          [[SessionExecution.node, SessionExecutionLocal.node]],
        ),
      ),
    ),
    { disableLogger: true },
  )
  const request = (path: string, init: RequestInit = {}, authenticated = true) => {
    const headers = new Headers(init.headers)
    headers.set("x-forge-directory", input.directory)
    if (authenticated) headers.set("authorization", input.authorization)
    return app.handler(new Request(new URL(path, "http://localhost"), { ...init, headers }))
  }
  return {
    request,
    json: (path: string, method: string, body: unknown, authenticated = true) =>
      request(
        path,
        { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        authenticated,
      ),
    [Symbol.asyncDispose]: () => app.dispose(),
  }
}
