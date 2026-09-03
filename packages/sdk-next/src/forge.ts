import { Forge } from "@turenlabs/client/effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { Memory } from "@turenlabs/core/memory"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionHarness } from "@turenlabs/core/session/harness"
import { SessionReviewer } from "@turenlabs/core/session/reviewer"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import { ApplicationTools } from "@turenlabs/core/tool/application-tools"
import { createEmbeddedRoutes } from "@turenlabs/server/routes"
import { Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

export const create = Effect.fn("Forge.create")(function* () {
  const scope = yield* Scope.Scope
  const memoMap = yield* Layer.makeMemoMap
  const context = yield* Layer.buildWithMemoMap(
    AppNodeBuilder.build(
      // The embedded routes now reach session endpoints, so the graph must provide
      // SessionV2 too — otherwise the handler context is missing a service the
      // router requires.
      LayerNode.group([
        ApplicationTools.node,
        PermissionSaved.node,
        Memory.node,
        Loop.node,
        SessionHarness.node,
        SessionReviewer.node,
        SessionV2.node,
      ]),
      // SessionV2 depends on the abstract SessionExecution node, which carries no
      // implementation of its own. The server route graph binds it the same way;
      // without the binding here the embedded host fails to build at all.
      [[SessionExecution.node, SessionExecutionLocal.node]],
    ),
    memoMap,
    scope,
  )
  const tools = Context.get(context, ApplicationTools.Service)
  const permissions = Context.get(context, PermissionSaved.Service)
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        createEmbeddedRoutes().pipe(
          HttpRouter.provideRequest(Layer.succeedContext(Context.make(PermissionSaved.Service, permissions))),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(web.dispose),
  )
  // `PermissionSaved` is provided per-request by the router above, so the
  // handler's requirement excludes it — narrow the runtime context to match.
  const handlerContext = Context.omit(PermissionSaved.Service)(context)
  const fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => web.handler(new Request(input, init), handlerContext),
    {
      preconnect: () => undefined,
    },
  ) satisfies typeof globalThis.fetch
  const client = yield* Forge.make({ baseUrl: "http://turenos.local" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
  return {
    ...client,
    tools: { register: tools.register },
  }
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@turenlabs/sdk-next/Forge") {}

export const layer = Layer.effect(Service, create())
