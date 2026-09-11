import * as http from "node:http"
import * as tls from "node:tls"
import { constants, enableCompileCache } from "node:module"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { watchOrphaned } from "./orphan-watch"
import { IS_DEV } from "./constants"
import { createSidecarProfiler, parseProfileCommand } from "./profiler/sidecar-profiler"
import type { SidecarProfileCommand, SidecarProfileMessage } from "./profiler/sidecar-profiler"
import type { CredentialVault } from "./secret-key"
import { rendererCorsOrigins } from "./window-security"
import { parseProxyRequest } from "./security-proxy-bridge"
import { parseProxyReply } from "./security-proxy-bridge"
import type { ProxyCommand, ProxyReply } from "./security-proxy-bridge"
import { randomUUID } from "node:crypto"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  credentialVault: CredentialVault
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand | SidecarProfileCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
  | SidecarProfileMessage
  | ProxyReply
  | ProxyCommand

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
  securityProxy(command: SecurityProxy.StoreCommand): Promise<SecurityProxy.Result>
}

/** How long a shutdown triggered by parent death gets before we exit anyway. */
const ORPHAN_STOP_TIMEOUT_MS = 5_000

const parentPort = getParentPort()
let listener: Listener | undefined
let startupDiagnostics: ReturnType<typeof armStartupDiagnostics> | undefined

/**
 * Only ever constructed in a dev build. `IS_DEV` folds to a literal, so a
 * shipped build has no profiler here at all - not merely a disabled one.
 */
const profiler = IS_DEV ? createSidecarProfiler() : undefined
const proxyPending = new Map<string, { resolve: (result: SecurityProxy.Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

parentPort.on("message", (event) => {
  const reply = parseProxyReply(event.data)
  if (reply) {
    const pending = proxyPending.get(reply.id)
    if (!pending) return
    proxyPending.delete(reply.id)
    clearTimeout(pending.timer)
    if (reply.error || !reply.result) pending.reject(new Error(reply.error ?? "Invalid proxy reply"))
    else pending.resolve(reply.result)
    return
  }
  const store = parseProxyRequest(event.data)
  if (store) {
    const pending = listener?.securityProxy(store.command) ?? Promise.reject(new Error("Sidecar is not ready"))
    void pending.then(
      (result) => notifyParent({ type: "security-proxy-result", id: store.id, result }),
      (error) => notifyParent({ type: "security-proxy-result", id: store.id, error: String(error).slice(0, 1024) }),
    )
    return
  }
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    // Attribution for supervised-respawn diagnostics: a stop the parent asked
    // for must be distinguishable from orphan-watch or anything else.
    process.stderr.write("sidecar stopping: parent sent stop command\n")
    void stop()
    return
  }
  if (command.type === "start") {
    void start(command)
    return
  }
  void profiler?.handle(command, notifyParent)
})

watchParent()

/**
 * Exit on our own once the Electron main process is gone.
 *
 * Every other teardown path here is driven by the parent, so none of them run
 * when it is SIGKILLed. See `watchOrphaned` for why this is a `ppid` poll and
 * not a heartbeat.
 */
function watchParent() {
  const watch = watchOrphaned()
  void watch.orphaned.then((reason) => {
    watch.stop()
    process.stderr.write(`sidecar orphaned (${reason}); shutting down\n`)
    // `stop()` exits on its own; this only covers a listener that never settles.
    setTimeout(() => process.exit(1), ORPHAN_STOP_TIMEOUT_MS).unref?.()
    return stop()
  })
}

async function start(command: StartCommand) {
  startupDiagnostics?.stop()
  startupDiagnostics = armStartupDiagnostics()
  try {
    startupDiagnostics.trace("start")
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    // V8 spends ~245ms of every cold start parsing the server bundle before a
    // line of it runs. The cache trades a few MB under userData for skipping
    // that on each launch after the first, and must be armed before the import.
    // A rejected cache is only a lost optimisation, so report it rather than
    // failing start - but report it, or the win silently stops reproducing.
    const cache = enableCompileCache(join(command.userDataPath, "compile-cache"))
    if (cache.status === constants.compileCacheStatus.FAILED) {
      process.stderr.write(`sidecar compile cache unavailable: ${cache.message ?? "unknown reason"}\n`)
    }
    startupDiagnostics.trace("server-import.started")
    const { Server } = await import("virtual:forge-server")
    startupDiagnostics.trace("server-import.completed")

    startupDiagnostics.trace("server-listen.started")
    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "forge",
      password: command.password,
      cors: rendererCorsOrigins(),
      credentialVault: command.credentialVault,
      securityProxy: requestSecurityProxy,
    })
    startupDiagnostics.trace("server-listen.completed")
    notifyParent({ type: "ready" })
  } catch (error) {
    notifyParent({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  // Drop any in-flight profile before teardown. Serialising a long profile can
  // take hundreds of milliseconds and quitting must not get slower, so a run
  // that is still going when the app quits is discarded rather than saved.
  profiler?.abort()
  for (const pending of proxyPending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error("Sidecar stopped"))
  }
  proxyPending.clear()
  startupDiagnostics?.stop()
  startupDiagnostics = undefined
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    notifyParent({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function requestSecurityProxy(command: SecurityProxy.Command) {
  const id = randomUUID()
  return new Promise<SecurityProxy.Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      proxyPending.delete(id)
      reject(new Error("Security Browser agent operation timed out"))
    }, 15_000)
    proxyPending.set(id, { resolve, reject, timer })
    notifyParent({ type: "security-proxy-command", id, command })
  })
}

function armStartupDiagnostics() {
  const startedAt = performance.now()
  let previousAt = startedAt
  let previousCPU = process.cpuUsage()
  let previousUtilization = performance.eventLoopUtilization()
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  const trace = (event: string, detail: Record<string, unknown> = {}) =>
    process.stderr.write(
      `[startup.sidecar] ${JSON.stringify({ event, elapsedMs: Math.round(performance.now() - startedAt), ...detail })}\n`,
    )
  const interval = setInterval(() => {
    const now = performance.now()
    const elapsedMs = now - previousAt
    const cpu = process.cpuUsage(previousCPU)
    const utilization = performance.eventLoopUtilization(previousUtilization)
    previousAt = now
    previousCPU = process.cpuUsage()
    previousUtilization = performance.eventLoopUtilization()
    trace("sample", {
      cpuPercent: Math.round((((cpu.user + cpu.system) / 1_000) * 100) / elapsedMs),
      eventLoopPercent: Math.round(utilization.utilization * 100),
      eventLoopDelayMaxMs: Math.round(delay.max / 1_000_000),
      eventLoopDelayMeanMs: Number.isFinite(delay.mean) ? Math.round(delay.mean / 1_000_000) : undefined,
      rssMB: Math.round(process.memoryUsage().rss / 1_048_576),
    })
    delay.reset()
  }, 1_000)
  interval.unref()
  const timeout = setTimeout(() => stop(), 60_000)
  timeout.unref()
  const stop = () => {
    clearInterval(interval)
    clearTimeout(timeout)
    delay.disable()
  }
  return { trace, stop }
}

/** Post to the parent, tolerating its absence - we also stop when it is gone. */
function notifyParent(message: SidecarMessage) {
  try {
    parentPort.postMessage(message)
  } catch (error) {
    console.warn("failed to notify parent", error)
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    FORGE_SERVER_USERNAME: "forge",
    FORGE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (IS_DEV && typeof command.type === "string" && command.type.startsWith("profile-")) {
    return parseProfileCommand(value)
  }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (!command.credentialVault || typeof command.credentialVault !== "object") return
  if (typeof command.credentialVault.keyID !== "string" || command.credentialVault.keyID.length === 0) return
  if (!(command.credentialVault.key instanceof Uint8Array) || command.credentialVault.key.byteLength !== 32) return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    credentialVault: command.credentialVault,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
