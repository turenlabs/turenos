import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { resolveForgeCliEnv } from "./forge-cli"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { IS_DEV } from "./constants"
import type { SidecarProfileMessage } from "./profiler/sidecar-profiler"
import type { CredentialVault } from "./secret-key"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
  | SidecarProfileMessage

export type SidecarProfileCapture = {
  samples: number
  durationMs: number
  sampleRateHz: number
}

/**
 * Dev-only CPU profiling of the sidecar, driven over the same `parentPort`
 * channel as start/stop. `stop` hands the sidecar an absolute path and the
 * sidecar writes the `.cpuprofile` itself.
 */
export type SidecarProfiler = {
  start: (sampleIntervalUs: number) => Promise<void>
  stop: (path: string) => Promise<SidecarProfileCapture>
  /** Fire-and-forget; used on teardown where nothing may be awaited. */
  abort: () => void
}

export type SidecarListener = { stop: () => Promise<void>; profile: SidecarProfiler }

const SIDECAR_SERVICE_NAME = "forge server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000
/**
 * A profile command that never comes back means the sidecar is wedged. Bounded
 * so an unresponsive sidecar surfaces as a skipped target in the manifest
 * rather than a settings toggle that hangs forever.
 */
const SIDECAR_PROFILE_TIMEOUT = 15_000

type SpawnLocalServerOptions = {
  userDataPath: string
  credentialVault: CredentialVault
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  Object.assign(process.env, {
    ...(shell ? loadShellEnv(shell, getLogger()) : null),
    FORGE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    FORGE_EXPERIMENTAL_FILEWATCHER: "true",
    FORGE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
      credentialVault: options.credentialVault,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  /**
   * Await a single profile reply from the sidecar. Bounded, and also settles if
   * the sidecar exits, so neither a wedged nor a dead sidecar can leave the
   * settings toggle stuck mid-transition.
   */
  const awaitProfileReply = <T extends SidecarProfileMessage["type"]>(type: T) =>
    new Promise<Extract<SidecarProfileMessage, { type: T }>>((resolve, reject) => {
      if (exited) {
        reject(new Error("Sidecar is not running"))
        return
      }
      const done = (settle: () => void) => {
        clearTimeout(timer)
        child.off("message", onMessage)
        child.off("exit", onExit)
        settle()
      }
      const onMessage = (message: SidecarMessage) => {
        if (message.type !== type) return
        done(() => resolve(message as Extract<SidecarProfileMessage, { type: T }>))
      }
      const onExit = () => done(() => reject(new Error("Sidecar exited during profiling")))
      const timer = setTimeout(
        () => done(() => reject(new Error(`Sidecar did not answer ${type} within ${SIDECAR_PROFILE_TIMEOUT}ms`))),
        SIDECAR_PROFILE_TIMEOUT,
      )
      child.on("message", onMessage)
      child.on("exit", onExit)
    })

  const profilerUnavailable = () => Promise.reject(new Error("Profiler is only available in dev builds"))

  const devProfiler = (): SidecarProfiler => ({
    start: async (sampleIntervalUs: number) => {
      const reply = awaitProfileReply("profile-started")
      child.postMessage({ type: "profile-start", sampleIntervalUs })
      const result = await reply
      if (!result.ok) throw new Error(result.error ?? "Sidecar failed to start profiling")
    },
    stop: async (path: string) => {
      const reply = awaitProfileReply("profile-stopped")
      child.postMessage({ type: "profile-stop", path })
      const result = await reply
      if (!result.ok) throw new Error(result.error ?? "Sidecar failed to stop profiling")
      return {
        samples: result.samples ?? 0,
        durationMs: result.durationMs ?? 0,
        sampleRateHz: result.sampleRateHz ?? 0,
      }
    },
    abort: () => {
      if (exited) return
      try {
        child.postMessage({ type: "profile-abort" })
      } catch {
        // Teardown is allowed to race with the sidecar going away.
      }
    },
  })

  // `IS_DEV` folds to a literal, so a shipped build keeps only the rejecting
  // branch and the message-port profiling protocol drops out of the bundle.
  const profile: SidecarProfiler = IS_DEV
    ? devProfiler()
    : { start: profilerUnavailable, stop: profilerUnavailable, abort: () => {} }

  let stopping: Promise<void> | undefined

  return {
    listener: {
      profile,
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`forge:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

function createSidecarEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  Object.assign(
    env,
    resolveForgeCliEnv({
      packaged: app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      path: env.PATH,
    }),
  )
  if (app.isPackaged) env.FORGE_VIGIL_PATH = join(process.resourcesPath, "vigil")
  if (!app.isPackaged) env.FORGE_DISABLE_CHANNEL_DB = "1"
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
