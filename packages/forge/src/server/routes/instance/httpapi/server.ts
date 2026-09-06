import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { performance } from "node:perf_hooks"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@turenlabs/core/fs-util"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { pentestLauncherNode as workbenchPentestLauncherNode } from "@turenlabs/core/tool/pentest-launcher"
import { BatouScanner } from "@turenlabs/core/tool/batou-scanner"
import * as Observability from "@turenlabs/core/observability"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { McpToolSource } from "@/mcp/tool-source"
import { PentestWorkbenchLauncher } from "@/pentest/workbench-launcher"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { BatouScannerLive } from "@/plugin/batou-v2"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@turenlabs/core/control-plane/move-session"
import { Database } from "@turenlabs/core/database/database"
import { Storage } from "@turenlabs/core/storage"
import { Pentest } from "@turenlabs/core/pentest"
import { TeamBoard } from "@turenlabs/core/team/board"
import { Whiteboard } from "@turenlabs/core/session/whiteboard"
import { PentestExecutionWorker } from "@/pentest/execution-worker"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { httpClient } from "@turenlabs/core/effect/app-node-platform"
import { EventV2 } from "@turenlabs/core/event"
import { ModelsDev } from "@turenlabs/core/models-dev"
import { Npm } from "@turenlabs/core/npm"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectCopy } from "@turenlabs/core/project/copy"
import { PtyTicket } from "@turenlabs/core/pty/ticket"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionHarness } from "@turenlabs/core/session/harness"
import { SessionReviewer } from "@turenlabs/core/session/reviewer"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import * as SessionExecutionLocal from "@turenlabs/core/session/execution/local"
import { SessionLegacyExecution } from "@turenlabs/core/session/legacy-execution"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SessionV2Cutover } from "@/session/v2-cutover"
import { SecurityStorage } from "@/security/storage"
import { LoopScheduler } from "@/loop/scheduler"
import { Loop } from "@turenlabs/core/loop"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@turenlabs/server/cors"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { PentestApi } from "./groups/pentest"
import { Api } from "@turenlabs/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { experimentalHandlers } from "./handlers/experimental"
import { extensionHandlers, extensionListHandlers } from "./handlers/extension"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { securityHandlers } from "./handlers/security"
import { storageHandlers } from "./handlers/storage"
import { pentestHandlers } from "./handlers/pentest"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { handlers } from "@turenlabs/server/handlers"
import { buildLocationServiceMap, LocationServiceMap } from "@turenlabs/core/location-services"
import { Memory } from "@turenlabs/core/memory"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { layer as locationLayer } from "@turenlabs/server/location"
import { sessionLocationLayer } from "@turenlabs/server/middleware/session-location"
import { PtyEnvironment } from "@turenlabs/server/pty-environment"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@turenlabs/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@turenlabs/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { Auth } from "@/auth"
import { ProviderAuth } from "@/provider/auth"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, securityHandlers, storageHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const pentestApiRoutes = HttpApiBuilder.layer(PentestApi).pipe(
  Layer.provide(pentestHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    extensionListHandlers,
    extensionHandlers,
    fileHandlers,
    instanceHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const removedShareRoute = HttpRouter.use((router) =>
  router.add("POST", "/session/:sessionID/share", () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  Memory.node,
  Storage.node,
  ExtensionRuntime.node,
  Pentest.node,
  TeamBoard.node,
  Whiteboard.node,
  PentestExecutionWorker.node,
  PermissionChecks.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  PermissionSaved.node,
  Todo.node,
  Session.node,
  SessionTaskV2.node,
  SessionProjector.node,
  SessionHarness.node,
  SessionStatus.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  SessionRunState.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionSummary.node,
  SessionPrompt.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Truncate.node,
  ToolRegistry.node,
  Format.node,
  Project.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
])

type SessionExecutionReplacement = typeof SessionExecutionLocal.node | Layer.Layer<SessionExecution.Service>

export function createRoutes(
  corsOptions?: CorsOptions,
  sessionExecution: SessionExecutionReplacement = SessionExecutionLocal.node,
  secretVault = SecretVault.ephemeral,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const secretVaultReplacement = [[SecretVault.node, secretVault]] as const
  // Reaching `MCP.Service` costs a full V1 `InstanceBootstrap.run` for the Location's
  // directory, so this may only be wired because registration is demand-driven: the
  // source is asked during the first tool materialization of a turn, never at Location
  // boot. A location-scoped request that runs no session — file search, a pty — still
  // starts no instance and spawns no MCP child. See specs/v2/session.md.
  const locationServiceMapV2 = buildLocationServiceMap([
    ...secretVaultReplacement,
    [BatouScanner.node, BatouScannerLive.node],
    [McpTool.sourceNode, McpToolSource.node],
    [workbenchPentestLauncherNode, PentestWorkbenchLauncher.node],
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ])

  return Layer.mergeAll(
    rootApiRoutes,
    pentestApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    removedShareRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      traceStartupLayer(
        "move-session-graph",
        AppNodeBuilderV1.build(MoveSession.node, [[LocationServiceMap.node, locationServiceMapV2]]),
      ),
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
    Layer.provide(
      traceStartupLayer(
        "session-graph",
        AppNodeBuilderV1.build(
          LayerNode.group([
            SessionV2.node,
            SessionExecutionLocal.node,
            SessionReviewer.node,
            Loop.node,
            LoopScheduler.node,
          ]),
          [
            [LocationServiceMap.node, locationServiceMapV2],
            [SessionExecution.node, sessionExecution],
            [SessionLegacyExecution.node, SessionV2Cutover.node],
          ],
        ),
      ),
    ),
    Layer.provide(locationServiceMapV2),

    Layer.provide(
      traceStartupLayer(
        "global-graph",
        AppNodeBuilderV1.build(app, [
          ...secretVaultReplacement,
          [LocationServiceMap.node, locationServiceMapV2],
          [SessionExecution.node, SessionExecutionLocal.node],
        ]),
      ),
    ),
    // Must stay last: layers provided later in this pipe build beneath earlier ones,
    // so Observability must come after every service graph. Otherwise eagerly forked
    // fibers (e.g. the ModelsDev background refresh) capture Effect's default stdout logger.
    Layer.provideMerge(Observability.layer),
  )
}

function traceStartupLayer<A, E, R>(stage: string, layer: Layer.Layer<A, E, R>) {
  if (process.env.FORGE_STARTUP_TRACE !== "1") return layer
  return Layer.unwrap(
    Effect.sync(() => {
      const startedAt = performance.now()
      return layer.pipe(
        Layer.tap(() => Effect.logInfo("server startup layer", { stage, elapsedMs: performance.now() - startedAt })),
      )
    }),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
