import __cjs_mod__ from "node:module"
const __filename = import.meta.filename
const __dirname = import.meta.dirname
const require2 = __cjs_mod__.createRequire(import.meta.url)
import * as http from "node:http"
import * as tls from "node:tls"
import { writeFile } from "node:fs/promises"
import { D as DEFAULT_SAMPLE_INTERVAL_US, i as isProfileOutputPath } from "./chunks/run-B35hXfDf.js"
import "node:path"
const ORPHAN_POLL_MS = 2e3
function watchOrphaned(options) {
  const readParent = () => process.ppid
  const platform = process.platform
  const startedUnder = readParent()
  let stop2 = () => {}
  const orphaned = new Promise((resolve) => {
    if (platform === "win32") return
    const timer = setInterval(() => {
      const current = readParent()
      if (current !== 1 || current === startedUnder) return
      resolve(`parent ${startedUnder} exited`)
    }, ORPHAN_POLL_MS)
    timer.unref?.()
    stop2 = () => clearInterval(timer)
  })
  return { orphaned, stop: () => stop2() }
}
function createV8CpuProfiler() {
  let session
  let starting
  const postOn = (active) => {
    return (method, params) =>
      new Promise((resolve, reject) => {
        const post = active.post.bind(active)
        post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
      })
  }
  const disconnect = () => {
    const active = session
    session = void 0
    starting = void 0
    if (!active) return
    try {
      active.disconnect()
    } catch {}
  }
  return {
    running: () => session !== void 0,
    async start(sampleIntervalUs = DEFAULT_SAMPLE_INTERVAL_US) {
      if (starting) return starting
      if (session) throw new Error("CPU profiler already running")
      starting = (async () => {
        const inspector = await import("node:inspector")
        const active = new inspector.Session()
        active.connect()
        const post = postOn(active)
        try {
          await post("Profiler.enable")
          await post("Profiler.setSamplingInterval", { interval: sampleIntervalUs })
          await post("Profiler.start")
        } catch (error) {
          try {
            active.disconnect()
          } catch {}
          throw error
        }
        session = active
      })()
      try {
        await starting
      } finally {
        starting = void 0
      }
    },
    async stop() {
      const active = session
      if (!active) throw new Error("CPU profiler is not running")
      const post = postOn(active)
      try {
        const result = await post("Profiler.stop")
        const profile = result?.profile
        const samples = profile?.samples?.length ?? 0
        const startTime = profile?.startTime ?? 0
        const endTime = profile?.endTime ?? 0
        const durationUs = Math.max(0, endTime - startTime)
        return {
          profile,
          samples,
          durationMs: durationUs / 1e3,
          sampleRateHz: durationUs > 0 ? Math.round(samples / (durationUs / 1e6)) : 0,
        }
      } finally {
        disconnect()
      }
    },
    abort: disconnect,
  }
}
function parseProfileCommand(value) {
  if (!value || typeof value !== "object") return
  const command = value
  if (command.type === "profile-abort") return { type: "profile-abort" }
  if (command.type === "profile-start") {
    const interval = command.sampleIntervalUs
    const sampleIntervalUs =
      typeof interval === "number" && Number.isFinite(interval) && interval >= 10 && interval <= 1e6
        ? Math.round(interval)
        : DEFAULT_SAMPLE_INTERVAL_US
    return { type: "profile-start", sampleIntervalUs }
  }
  if (command.type === "profile-stop") {
    if (!isProfileOutputPath(command.path)) return
    return { type: "profile-stop", path: command.path }
  }
  return
}
function createSidecarProfiler() {
  const profiler2 = createV8CpuProfiler()
  return {
    running: profiler2.running,
    abort: profiler2.abort,
    async handle(command, reply) {
      if (command.type === "profile-abort") {
        profiler2.abort()
        return
      }
      if (command.type === "profile-start") {
        try {
          await profiler2.start(command.sampleIntervalUs)
          reply({ type: "profile-started", ok: true })
        } catch (error) {
          reply({ type: "profile-started", ok: false, error: message(error) })
        }
        return
      }
      try {
        const capture = await profiler2.stop()
        await writeFile(command.path, JSON.stringify(capture.profile))
        reply({
          type: "profile-stopped",
          ok: true,
          samples: capture.samples,
          durationMs: capture.durationMs,
          sampleRateHz: capture.sampleRateHz,
        })
      } catch (error) {
        reply({ type: "profile-stopped", ok: false, error: message(error) })
      }
    },
  }
}
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
const ORPHAN_STOP_TIMEOUT_MS = 5e3
const parentPort = getParentPort()
let listener
const profiler = createSidecarProfiler()
parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
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
function watchParent() {
  const watch = watchOrphaned()
  void watch.orphaned.then((reason) => {
    watch.stop()
    process.stderr.write(`sidecar orphaned (${reason}); shutting down
`)
    setTimeout(() => process.exit(1), ORPHAN_STOP_TIMEOUT_MS).unref?.()
    return stop()
  })
}
async function start(command) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath, command.vaultKey)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Server } = await import("./chunks/node-DPH4C2U3.js")
    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "forge",
      password: command.password,
      cors: ["forge-internal://renderer"],
    })
    notifyParent({ type: "ready" })
  } catch (error) {
    notifyParent({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}
async function stop() {
  profiler?.abort()
  try {
    await listener?.stop()
  } finally {
    listener = void 0
    notifyParent({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}
function notifyParent(message2) {
  try {
    parentPort.postMessage(message2)
  } catch (error) {
    console.warn("failed to notify parent", error)
  }
}
function prepareSidecarEnv(password, userDataPath, vaultKey) {
  Object.assign(process.env, {
    FORGE_SERVER_USERNAME: "forge",
    FORGE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
    FORGE_REVERSING_VAULT_KEY: vaultKey,
  })
}
function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => Boolean(value))
    for (const host of loopback) {
      if (items.some((value) => value.toLowerCase() === host)) continue
      items.push(host)
    }
    process.env[key] = items.join(",")
  }
  upsert("NO_PROXY")
  upsert("no_proxy")
}
function useSystemCertificates() {
  try {
    const nodeTls = tls
    nodeTls.setDefaultCACertificates([
      .../* @__PURE__ */ new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}
function useEnvProxy() {
  try {
    http.setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}
function parseCommand(value) {
  if (!value || typeof value !== "object") return
  const command = value
  if (command.type === "stop") return { type: "stop" }
  if (typeof command.type === "string" && command.type.startsWith("profile-")) {
    return parseProfileCommand(value)
  }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (typeof command.vaultKey !== "string" || Buffer.from(command.vaultKey, "base64").byteLength !== 32) return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    vaultKey: command.vaultKey,
  }
}
function serializeError(error) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}
function getParentPort() {
  const port = process.parentPort
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
