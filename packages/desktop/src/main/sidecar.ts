import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { watchOrphaned } from "./orphan-watch"
import { IS_DEV } from "./constants"
import { parseProfileCommand } from "./profiler/sidecar-profiler"
import type { SidecarProfileCommand, SidecarProfileMessage } from "./profiler/sidecar-profiler"
import type { CredentialVault } from "./secret-key"
import { rendererCorsOrigins } from "./window-security"
import { parseProxyRequest } from "./security-proxy-bridge"
import { parseProxyReply } from "./security-proxy-bridge"
import type { ProxyCommand, ProxyReply } from "./security-proxy-bridge"
import { randomUUID } from "node:crypto"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  credentialVault: Omit<CredentialVault, "key"> & { key: string }
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
  postMessage(message: SidecarMessage): boolean
  on(event: "message", listener: (message: unknown) => void): unknown
  on(event: "disconnect", listener: () => void): unknown
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
  securityProxy(command: SecurityProxy.StoreCommand): Promise<SecurityProxy.Result>
}

/** How long a shutdown triggered by parent death gets before we exit anyway. */
const ORPHAN_STOP_TIMEOUT_MS = 5_000

const parentPort = getParentPort()
Object.assign(process, { resourcesPath: process.env.FORGE_RESOURCES_PATH })
if (!process.versions.bun) throw new Error("Forge server sidecar requires Bun")
let listener: Listener | undefined
let startupDiagnostics: ReturnType<typeof armStartupDiagnostics> | undefined

/**
 * Only ever constructed in a dev build. `IS_DEV` folds to a literal, so a
 * shipped build has no profiler here at all - not merely a disabled one.
 */
const proxyPending = new Map<
  string,
  {
    resolve: (result: SecurityProxy.Result) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

parentPort.on("message", (data) => {
  const reply = parseProxyReply(data)
  if (reply) {
    const pending = proxyPending.get(reply.id)
    if (!pending) return
    proxyPending.delete(reply.id)
    clearTimeout(pending.timer)
    if (reply.error || !reply.result) pending.reject(new Error(reply.error ?? "Invalid proxy reply"))
    else pending.resolve(reply.result)
    return
  }
  const store = parseProxyRequest(data)
  if (store) {
    const pending = listener?.securityProxy(store.command) ?? Promise.reject(new Error("Sidecar is not ready"))
    void pending.then(
      (result) => notifyParent({ type: "security-proxy-result", id: store.id, result }),
      (error) => notifyParent({ type: "security-proxy-result", id: store.id, error: String(error).slice(0, 1024) }),
    )
    return
  }
  const command = parseCommand(data)
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
  if (command.type === "profile-start")
    notifyParent({ type: "profile-started", ok: false, error: "CPU profiling is unsupported by the Bun sidecar" })
  if (command.type === "profile-stop")
    notifyParent({ type: "profile-stopped", ok: false, error: "CPU profiling is unsupported by the Bun sidecar" })
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
      credentialVault: { ...command.credentialVault, key: Buffer.from(command.credentialVault.key, "base64") },
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
  if (typeof command.credentialVault.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(command.credentialVault.key))
    return
  const key = Buffer.from(command.credentialVault.key, "base64")
  if (key.byteLength !== 32 || key.toString("base64") !== command.credentialVault.key) return
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
  if (typeof process.send !== "function") throw new Error("Sidecar IPC channel unavailable")
  const port: ParentPort = {
    postMessage: (message) => process.send!(message),
    on: (event, listener) => process.on(event, listener as never),
  }
  port.on("disconnect", () => {
    void stop()
    setTimeout(() => process.exit(1), ORPHAN_STOP_TIMEOUT_MS).unref?.()
  })
  return port
}
