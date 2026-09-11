import "./init-projectors"

import { NodeHttpServer } from "@effect/platform-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { memoMap as sharedMemoMap } from "@turenlabs/core/effect/memo-map"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { MCP } from "@/mcp"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { performance } from "node:perf_hooks"
import { MDNS } from "./mdns"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "./routes/instance/httpapi/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import type { CorsOptions } from "@turenlabs/server/cors"
import { startScheduler } from "@turenlabs/server/intel/scheduler"
import { lazy } from "@/util/lazy"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { SecurityProxyStore } from "@turenlabs/core/security-proxy"
import { SecurityProxyRuntime } from "@turenlabs/core/security-proxy-runtime"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
  securityProxy: (command: SecurityProxy.StoreCommand) => Promise<SecurityProxy.Result>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = CorsOptions & {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  credentialVault?: {
    keyID: string
    key: Uint8Array
  }
  securityProxy?: (command: SecurityProxy.Command) => Promise<SecurityProxy.Result>
}
type ListenerState = {
  scope: Scope.Scope
  memoMap: Layer.MemoMap
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  http: ListenerServer
  websockets: WebSocketTracker.Interface
  securityProxy: SecurityProxyStore.Interface
}
type EffectListener = Omit<Listener, "stop"> & {
  stop: (close?: boolean) => Effect.Effect<void>
}

interface ListenerServer {
  readonly closeAll: Effect.Effect<void>
}

class ListenerServerService extends Context.Service<ListenerServerService, ListenerServer>()("@forge/ListenerServer") {}

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export let url: URL | undefined

export async function listen(opts: ListenOptions): Promise<Listener> {
  if (opts.credentialVault) SecretVault.configure(opts.credentialVault)
  const listener = await Effect.runPromise(listenEffect(opts))
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close?: boolean) => runListenerStop(listener.stop(close)),
    securityProxy: listener.securityProxy,
  }
}

export async function runListenerStop(effect: Effect.Effect<void, unknown>) {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return
  throw Cause.squash(exit.cause)
}

const listenEffect: (opts: ListenOptions) => Effect.Effect<EffectListener, unknown> = Effect.fn("Server.listen")(
  function* (opts: ListenOptions) {
    const state = yield* startWithPortFallback(opts)
    // Intel feeds have no layer node, so the listener owns the 6h poll tick
    // (stopped with the listener scope). Skipped under the test runner so
    // server tests stay hermetic: no real feed traffic, no shared-state writes.
    const intelScheduler = process.env.NODE_ENV === "test" ? undefined : startScheduler()
    if (intelScheduler) {
      yield* Scope.addFinalizer(
        state.scope,
        Effect.sync(() => intelScheduler.stop()),
      )
    }
    const address = yield* tcpAddress(state)
    const listenerUrl = makeURL(opts.hostname, address.port)
    const unpublishMdns = yield* setupMdns(opts, address.port, state.scope)
    url = listenerUrl

    return {
      hostname: opts.hostname,
      port: address.port,
      url: listenerUrl,
      stop: yield* makeStop(state, unpublishMdns, listenerUrl),
      securityProxy: (command: SecurityProxy.StoreCommand) => Effect.runPromise(state.securityProxy.execute(command)),
    }
  },
)

function listenerLayer(opts: ListenOptions, port: number) {
  const secretVault = opts.credentialVault ? SecretVault.layer(opts.credentialVault) : SecretVault.runtime
    return HttpRouter.serve(HttpApiApp.createRoutes(opts, undefined, secretVault, opts.securityProxy ? { execute: (command) => Effect.tryPromise({ try: () => opts.securityProxy!(command), catch: (error) => new SecurityProxyRuntime.Error(error instanceof Error ? error.message : String(error)) }) } : undefined), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(AppNodeBuilder.build(WebSocketTracker.node)),
    Layer.provideMerge(AppNodeBuilder.build(SecurityProxyStore.node, [[SecretVault.node, secretVault]])),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname })),
    // Install a fresh `ConfigProvider` per listener so `Config.string(...)`
    // reads reflect the current `process.env`. Effect's default
    // `ConfigProvider` snapshots `process.env` on first read and caches the
    // result on a module-singleton Reference; without overriding it here,
    // every later `Server.listen()` keeps observing that initial snapshot.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

function startWithPortFallback(opts: ListenOptions) {
  if (opts.port !== 0) return startListener(opts, opts.port)
  // Match the legacy listener port-resolution behavior: explicit `0` prefers
  // 4096 first, then any free port.
  return startListener(opts, 4096).pipe(Effect.catch(() => startListener(opts, 0)))
}

/**
 * Every listener builds its services against its OWN memo map, on its own scope,
 * rather than the process-global `memoMap` that `AppRuntime`, `BootstrapRuntime`
 * and the in-process `Server.Default` handler share. This is deliberate and
 * load-bearing; three reasons it must stay that way:
 *
 *  - Effect memoizes by leaf-layer object identity, and on a hit it returns the
 *    cached instance while *discarding the dependency context the second build
 *    supplied*. Sharing would therefore make the first caller's environment win
 *    for every later listener - including the per-listener `ConfigProvider` that
 *    `listenerLayer` installs precisely so each `listen()` re-reads `process.env`.
 *    Sharing the memo map would silently reintroduce the bug that comment fixed.
 *  - `createRoutes(opts)` bakes per-listener inputs (CORS origins, hostname, the
 *    session-execution and location-service replacements) into the graph. Those
 *    are inputs, not globals; first-caller-wins is the wrong answer for them.
 *  - `makeStop` closes this scope to release the graph. A memo entry is released
 *    only when its LAST observer's scope closes, and the runtimes above hold the
 *    same leaves for the life of the process - so a shared map would leave
 *    `stop()` closing the socket while the whole service graph (Database,
 *    Session, MCP, LSP, ptys) kept running, and the next `listen()` would
 *    silently adopt it.
 *
 * The price of the isolation is that services really are built twice whenever
 * both graphs are live in one process. That is invisible for most of them and
 * expensive for MCP, which spawns a child process per configured server, so
 * `checkSingleMcp` reports it rather than letting it double silently.
 */
function startListener(opts: ListenOptions, port: number) {
  const scope = Scope.makeUnsafe()
  const memoMap = Layer.makeMemoMapUnsafe()
  const startedAt = performance.now()
  return Layer.buildWithMemoMap(listenerLayer(opts, port), memoMap, scope).pipe(
    Effect.provide(HttpApiApp.context),
    Effect.tap(() => startupTrace("listener-layer-ready", startedAt)),
    Effect.tap(() => checkSingleMcp(memoMap)),
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    Effect.map(
      (ctx): ListenerState => ({
        scope,
        memoMap,
        server: Context.get(ctx, HttpServer.HttpServer),
        http: Context.get(ctx, ListenerServerService),
        websockets: Context.get(ctx, WebSocketTracker.Service),
        securityProxy: Context.get(ctx, SecurityProxyStore.Service),
      }),
    ),
  )
}

/** The layer MCP is memoized against. Node implementations are module singletons. */
const mcpLeaf = MCP.node.implementation as unknown as object

/**
 * Read a memo map's table of built layers.
 *
 * Deliberately reaches for the internal field: the public `MemoMap.get` attaches
 * a finalizer and increments the entry's observer count, which a probe must not
 * do. If Effect ever changes that shape the check disables itself rather than
 * guessing wrong.
 */
function memoizedLayers(memo: unknown) {
  const map = (memo as { map?: unknown } | undefined)?.map
  return map instanceof Map ? (map as Map<unknown, unknown>) : undefined
}

let reportedDuplicateMcp = false

/**
 * Fail loudly if a second MCP service is live.
 *
 * MCP is the one service where a duplicate graph is not merely wasteful: each
 * instance spawns and owns a child process per configured server, and the
 * duplicates are invisible until they are found orphaned. Nothing under
 * `AppRuntime` reaches MCP on the `serve`/`acp` paths today, so this is silent;
 * the first code path that changes that will say so here instead of quietly
 * doubling every MCP child.
 *
 * Silent under the test runner, where `testEffectShared` builds the app graph on
 * the shared memo map alongside a real `Server.listen()` on purpose. The
 * condition is genuinely true there, so the check cannot tell intent from
 * regression and would only be noise. Reported once per process otherwise: the
 * point is to be noticed, not to repeat per listener.
 */
function checkSingleMcp(listenerMemoMap: Layer.MemoMap) {
  if (reportedDuplicateMcp || process.env.NODE_ENV === "test") return Effect.void
  const listener = memoizedLayers(listenerMemoMap)
  const shared = memoizedLayers(sharedMemoMap)
  if (!listener?.has(mcpLeaf) || !shared?.has(mcpLeaf)) return Effect.void
  reportedDuplicateMcp = true
  return Effect.logError(
    "two MCP services are live in this process: one in this listener's graph and one in the shared runtime graph. " +
      "Every configured MCP server is spawned twice, and the extra children are only discoverable once orphaned. " +
      "A code path under AppRuntime has started reaching MCP - route it through the listener's graph instead.",
  )
}

function tcpAddress(state: ListenerState) {
  return Effect.gen(function* () {
    if (state.server.address._tag === "TcpAddress") return state.server.address
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
    return yield* Effect.die(new Error(`Unexpected HttpServer address tag: ${state.server.address._tag}`))
  })
}

function makeURL(hostname: string, port: number) {
  const result = new URL("http://localhost")
  result.hostname = hostname
  result.port = String(port)
  return result
}

function setupMdns(opts: ListenOptions, port: number, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const publish =
      opts.mdns && port && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    if (publish) {
      const unpublish = yield* Effect.cached(Effect.sync(() => MDNS.unpublish()))
      yield* Effect.sync(() => MDNS.publish(port, opts.mdnsDomain))
      yield* Scope.addFinalizer(scope, unpublish)
      return unpublish
    }
    if (opts.mdns) {
      yield* Effect.logWarning("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }
    return Effect.void
  })
}

function makeStop(state: ListenerState, unpublishMdns: Effect.Effect<void>, listenerUrl: URL) {
  return Effect.gen(function* () {
    const forceCloseOnce = yield* Effect.cached(forceClose(state).pipe(Effect.ignore))
    const closeScopeOnce = yield* Effect.cached(
      Scope.close(state.scope, Exit.void).pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            if (url === listenerUrl) url = undefined
          }),
        ),
      ),
    )

    return (close?: boolean) =>
      Effect.gen(function* () {
        yield* unpublishMdns
        // Re-checked here as well as at build: `AppRuntime` may only have reached
        // MCP after this listener was already up, and shutdown is the last chance
        // to say so.
        yield* checkSingleMcp(state.memoMap)
        if (close) yield* forceCloseOnce
        yield* closeScopeOnce
      })
  })
}

function forceClose(state: ListenerState) {
  return Effect.all([state.http.closeAll, state.websockets.closeAll], { concurrency: "unbounded", discard: true })
}

function startupTrace(stage: string, startedAt: number) {
  if (process.env.FORGE_STARTUP_TRACE !== "1") return Effect.void
  return Effect.logInfo("server startup stage", { stage, elapsedMs: performance.now() - startedAt })
}

function serverLayer(opts: { port: number; hostname: string }) {
  const server = createServer()
  const serverRef = { closeStarted: false, forceStop: false }
  const close = server.close.bind(server)
  // Keep shutdown owned by NodeHttpServer, but honor listener.stop(true) by
  // force-closing active HTTP sockets when its finalizer calls server.close().
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    serverRef.closeStarted = true
    const result = close(callback)
    if (serverRef.forceStop) server.closeAllConnections()
    return result
  }) as typeof server.close

  return Layer.mergeAll(
    NodeHttpServer.layer(() => server, { port: opts.port, host: opts.hostname, gracefulShutdownTimeout: "1 second" }),
    Layer.succeed(ListenerServerService)(
      ListenerServerService.of({
        closeAll: Effect.sync(() => {
          serverRef.forceStop = true
          if (serverRef.closeStarted) server.closeAllConnections()
        }),
      }),
    ),
  )
}

export * as Server from "./server"
