import "./init-projectors"

import { BunHttpServer } from "@effect/platform-bun"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { memoMap as sharedMemoMap } from "@turenlabs/core/effect/memo-map"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { MCP } from "@/mcp"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { performance } from "node:perf_hooks"
import { chmod } from "node:fs/promises"
import { MDNS } from "./mdns"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "./routes/instance/httpapi/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import type { CorsOptions } from "@turenlabs/server/cors"
import { startScheduler } from "@turenlabs/server/intel/scheduler"
import { lazy } from "@/util/lazy"
import { Heap } from "@/cli/heap"
import { Flag } from "@turenlabs/core/flag/flag"
import { isLoopbackHostname } from "./shared/local-request"
import { ServerAuth } from "./auth"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { ServerOwnership } from "./ownership"
import { ServerDescriptor } from "./descriptor"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { Database } from "@turenlabs/core/database/database"
import type { Source } from "@/cli/secret-vault-key"
import { SecurityProxyStore } from "@turenlabs/core/security-proxy"
import { SecurityProxyRuntime } from "@turenlabs/core/security-proxy-runtime"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export type Listener = {
  socketPath?: string
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
  socketPath?: string
  port: number
  hostname: string
  /** Basic auth password. Defaults to FORGE_SERVER_PASSWORD, which listen moves from process.env into Flag. */
  password?: string
  /** Basic auth username. Defaults to FORGE_SERVER_USERNAME, then "forge". */
  username?: string
  /** Opt out of refusing non-loopback binds without FORGE_SERVER_PASSWORD. */
  insecure?: boolean
  mdns?: boolean
  mdnsDomain?: string
  credentialVault?: {
    keyID: string
    key: Uint8Array
  }
  keySource?: Source
  securityProxy?: (command: SecurityProxy.Command) => Promise<SecurityProxy.Result>
}
type ListenerState = {
  scope: Scope.Scope
  memoMap: Layer.MemoMap
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  websockets: WebSocketTracker.Interface
  securityProxy: SecurityProxyStore.Interface
  database: Database.Interface
}
type EffectListener = Omit<Listener, "stop"> & {
  stop: (close?: boolean) => Effect.Effect<void>
}

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
  // The desktop sidecar calls listen without entering the CLI, so claim the password here too.
  const password = ServerAuth.claimPassword(opts.password)
  const username = opts.username ?? process.env.FORGE_SERVER_USERNAME ?? Flag.FORGE_SERVER_USERNAME
  Flag.FORGE_SERVER_USERNAME = username
  // The desktop sidecar reaches listen() without passing the CLI middleware that
  // starts the heap watchdog, so it has to start here.
  Heap.start({ announce: true })
  // Binding a non-loopback interface exposes every privileged API on the LAN, so a
  // password is mandatory there unless the caller explicitly opts into insecure mode.
  if (!opts.socketPath && !password && !opts.insecure && !isLoopbackHostname(opts.hostname)) {
    throw new Error(
      `Refusing to listen on ${opts.hostname} without FORGE_SERVER_PASSWORD. ` +
        "Set FORGE_SERVER_PASSWORD, bind a loopback hostname, or pass --insecure to override.",
    )
  }
  const releaseOwner = await ServerOwnership.acquire({ ...opts, password })
  try {
    const facts: ServerDescriptor.ListenerFacts = {
      keySource: opts.keySource ?? (opts.credentialVault ? "desktop" : "env"),
      listener: "",
    }
    const listener = await Effect.runPromise(listenEffect({ ...opts, password, username }, facts))
    return {
      socketPath: listener.socketPath,
      hostname: listener.hostname,
      port: listener.port,
      url: listener.url,
      stop: async (close?: boolean) => {
        try {
          await runListenerStop(listener.stop(close))
        } finally {
          releaseOwner()
        }
      },
      securityProxy: listener.securityProxy,
    }
  } catch (error) {
    releaseOwner()
    throw error
  }
}

export async function runListenerStop(effect: Effect.Effect<void, unknown>) {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return
  throw Cause.squash(exit.cause)
}

const listenEffect = Effect.fn("Server.listen")(function* (opts: ListenOptions, facts: ServerDescriptor.ListenerFacts) {
  const state = yield* startWithPortFallback(opts, facts)
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
  const port = opts.socketPath ? 0 : (yield* tcpAddress(state)).port
  const listenerUrl = opts.socketPath ? new URL("http://localhost") : makeURL(opts.hostname, port)
  const unpublishMdns = opts.socketPath ? Effect.void : yield* setupMdns(opts, port, state.scope)
  url = listenerUrl
  facts.listener = opts.socketPath ? `unix:${opts.socketPath}` : listenerUrl.toString()
  if (ServerOwner.mode() === "persistent" && !(yield* ServerDescriptor.read(state.database, facts))) {
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
    if (url === listenerUrl) url = undefined
    return yield* Effect.die(new Error("persistent server started without an owner record"))
  }

  return {
    hostname: opts.hostname,
    socketPath: opts.socketPath,
    port,
    url: listenerUrl,
    stop: yield* makeStop(state, unpublishMdns, listenerUrl),
    securityProxy: (command: SecurityProxy.StoreCommand) => Effect.runPromise(state.securityProxy.execute(command)),
  }
})

function listenerLayer(opts: ListenOptions, port: number, facts: ServerDescriptor.ListenerFacts) {
  const secretVault = opts.credentialVault ? SecretVault.layer(opts.credentialVault) : SecretVault.runtime
  return HttpRouter.serve(
    HttpApiApp.createRoutes(
      opts,
      undefined,
      secretVault,
      opts.securityProxy
        ? {
            execute: (command) =>
              Effect.tryPromise({
                try: () => opts.securityProxy!(command),
                catch: (error) =>
                  new SecurityProxyRuntime.Error(error instanceof Error ? error.message : String(error)),
              }),
          }
        : undefined,
      facts,
      { password: opts.password, username: opts.username },
    ),
    {
      middleware: disposeMiddleware,
      disableLogger: true,
      disableListenLog: true,
    },
  ).pipe(
    Layer.provideMerge(AppNodeBuilder.build(WebSocketTracker.node)),
    Layer.provideMerge(AppNodeBuilder.build(Database.node)),
    Layer.provideMerge(AppNodeBuilder.build(SecurityProxyStore.node, [[SecretVault.node, secretVault]])),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname, socketPath: opts.socketPath })),
    // Install a fresh `ConfigProvider` per listener so `Config.string(...)`
    // reads reflect the current `process.env`. Effect's default
    // `ConfigProvider` snapshots `process.env` on first read and caches the
    // result on a module-singleton Reference; without overriding it here,
    // every later `Server.listen()` keeps observing that initial snapshot.
    // The auth credentials come from `listen()`, which removed the password from `process.env`.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: listenerEnv(opts) }))),
  )
}

function listenerEnv(opts: ListenOptions) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    ...env,
    ...(opts.password ? { FORGE_SERVER_PASSWORD: opts.password } : {}),
    ...(opts.username ? { FORGE_SERVER_USERNAME: opts.username } : {}),
  }
}

function startWithPortFallback(opts: ListenOptions, facts: ServerDescriptor.ListenerFacts) {
  if (opts.socketPath) return startListener(opts, 0, facts)
  if (opts.port !== 0) return startListener(opts, opts.port, facts)
  // Match the legacy listener port-resolution behavior: explicit `0` prefers
  // 4096 first, then any free port.
  return startListener(opts, 4096, facts).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasFails(cause) && !Cause.hasDies(cause) && !Cause.hasInterrupts(cause)) {
        return startListener(opts, 0, facts)
      }
      const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
      const defect = reason && Cause.isDieReason(reason) ? reason.defect : undefined
      if (defect instanceof Error && "code" in defect && defect.code === "EADDRINUSE") {
        return startListener(opts, 0, facts)
      }
      return Effect.failCause(cause)
    }),
  )
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
function startListener(opts: ListenOptions, port: number, facts: ServerDescriptor.ListenerFacts) {
  const scope = Scope.makeUnsafe()
  const memoMap = Layer.makeMemoMapUnsafe()
  const startedAt = performance.now()
  return Layer.buildWithMemoMap(listenerLayer(opts, port, facts), memoMap, scope).pipe(
    Effect.provide(HttpApiApp.context),
    Effect.tap(() => (opts.socketPath ? Effect.tryPromise(() => chmod(opts.socketPath!, 0o660)) : Effect.void)),
    Effect.tap(() => startupTrace("listener-layer-ready", startedAt)),
    Effect.tap(() => checkSingleMcp(memoMap)),
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    Effect.map(
      (ctx): ListenerState => ({
        scope,
        memoMap,
        server: Context.get(ctx, HttpServer.HttpServer),
        websockets: Context.get(ctx, WebSocketTracker.Service),
        securityProxy: Context.get(ctx, SecurityProxyStore.Service),
        database: Context.get(ctx, Database.Service),
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
  return state.websockets.closeAll
}

function startupTrace(stage: string, startedAt: number) {
  if (process.env.FORGE_STARTUP_TRACE !== "1") return Effect.void
  return Effect.logInfo("server startup stage", { stage, elapsedMs: performance.now() - startedAt })
}

function serverLayer(opts: { port: number; hostname: string; socketPath?: string }) {
  if (opts.socketPath) return BunHttpServer.layer({ unix: opts.socketPath, gracefulShutdownTimeout: "1 second" })
  return BunHttpServer.layer({ port: opts.port, hostname: opts.hostname, gracefulShutdownTimeout: "1 second" })
}

export * as Server from "./server"
