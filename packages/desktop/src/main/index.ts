import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, safeStorage } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { closeSecurityProxy, disconnectSecurityProxy, invokeSecurityProxy, registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { createOnboarding } from "./onboarding"
import { preferAppEnv, spawnLocalServer, type SidecarListener } from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  getPinchZoomEnabled,
  flushWindowState,
  initializeWindows,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
  setPinchZoomEnabled,
  setSessionEndHandler,
} from "./windows"
import { createWslServersController, type WslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { createSshServersController, type SshServersController } from "./ssh/servers"
import { sshControlDir } from "./ssh/runtime"
import { registerSshIpcHandlers } from "./ssh/ipc"
import { rendererCorsOrigins } from "./window-security"
import { currentTauriLegacyDir, readTauriLegacyStores } from "./migrate"
import { getStore } from "./store"
import { createDesktopStorage } from "./storage/bridge"
import { createStorageRemote } from "./storage/client"
import { createDesktopProductStorage } from "./storage/product"
import { hasExistingAppState } from "./install-state"
import { createShutdownCoordinator } from "./shutdown"
import { createProfilerController, type ProfilerController } from "./profiler"
import { withTeardownTimeout } from "./teardown-timeout"
import { loadCredentialSecretKey } from "./secret-key"

// Deliberately still "Forge" after the rename to TurenOS. Electron derives the
// safeStorage keychain service name from `app.getName()` ("<name> Safe Storage"),
// so renaming this points the app at a keychain item that does not exist, Electron
// mints a fresh key, and `loadCredentialSecretKey` throws on the vault record the
// old key wrapped -- there is no regeneration path. The user-visible name comes
// from `productName` in electron-builder.config.ts, which is already TurenOS; this
// value only reaches diagnostics. Change it together with a credential migration.
const APP_NAMES: Record<string, string> = {
  dev: "Forge Dev",
  beta: "Forge Beta",
  prod: "Forge",
}
const APP_IDS: Record<string, string> = {
  dev: "com.turenlabs.forge.dev",
  beta: "com.turenlabs.forge.beta",
  prod: "com.turenlabs.forge",
}
const TEST_ONBOARDING = process.env.FORGE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null
let securityProxyOrigin: string | undefined
let wslServers: WslServersController | undefined
let sshServers: SshServersController | undefined
let profiler: ProfilerController | undefined

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  await boundTeardownStep("securityProxy", closeSecurityProxy)()
  // Every sidecar teardown path funnels through here - quit, relaunch, the
  // updater and the kill-sidecar IPC - so it is the one place an in-flight
  // profile has to be released. Discarding is synchronous and adds nothing
  // measurable to the ~2s quit.
  profiler?.abortForQuit()
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

const boundTeardownStep = (label: string, task: () => Promise<void>) =>
  withTeardownTimeout(label, task, { warn: (message, ...args) => logger.warn(message, ...args) })

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

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "com.turenlabs.forge.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `forge-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.FORGE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Forge Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  let drainPersistence = () => Promise.resolve()
  let resumePersistence = () => undefined
  const shutdownFailed = (error: unknown) => {
    resumePersistence()
    setAppQuitting(false)
    logger.error("failed to stop desktop cleanly", error)
  }
  const shutdown = createShutdownCoordinator({
    flushWindowState: boundTeardownStep("flushWindowState", flushWindowState),
    drainPersistence: boundTeardownStep("drainPersistence", () => drainPersistence()),
    stopSidecars: killSidecar,
    stopWslServers: () => wslServers?.stopAll(),
    stopSshServers: () => sshServers?.stopAll(),
    setAppQuitting,
    quit: () => app.quit(),
    failed: shutdownFailed,
  })
  const stopSidecars = shutdown.stop
  setSessionEndHandler(shutdown.beforeQuit)
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().then(() => {
      app.relaunch()
      app.exit(0)
    }, shutdownFailed)
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("forge://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", shutdown.beforeQuit)

  app.on("will-quit", () => {
    setAppQuitting()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().then(() => app.exit(0), shutdownFailed)
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
  const awaitServerReady = () => Effect.runPromise(Deferred.await(serverReady))

  yield* Effect.promise(() => app.whenReady())
  const credentialVault = loadCredentialSecretKey(getStore(), safeStorage, process.platform)

  const tauri = TEST_ONBOARDING
    ? { merge: (_name: string, store: ReturnType<typeof getStore>) => store }
    : readTauriLegacyStores(currentTauriLegacyDir(app.isPackaged, CHANNEL), (message, error) =>
        logger.warn(message, error),
      )
  const legacyStore = (name: string) => tauri.merge(name, getStore(name))
  app.setAsDefaultProtocolClient("forge")
  registerRendererProtocol()
  setDockIcon()
  const storageRemote = createStorageRemote({ ready: awaitServerReady })
  const storage = createDesktopStorage({
    remote: storageRemote,
    legacy: legacyStore,
  })
  const productStorage = createDesktopProductStorage({
    remote: storageRemote,
    userDataPath: app.getPath("userData"),
    legacy: legacyStore,
    oldLayoutEligible: () =>
      hasExistingAppState(
        existsSync(app.getPath("userData")) ? readdirSync(app.getPath("userData"), { withFileTypes: true }) : [],
      ),
    warn: (message, error) => logger.warn(message, error),
  })
  drainPersistence = async () => {
    storage.seal()
    productStorage.seal()
    const results = await Promise.allSettled([storage.drain(), productStorage.drain()])
    const failed = results.find((result) => result.status === "rejected")
    if (failed) throw failed.reason
  }
  resumePersistence = () => {
    storage.resume()
    productStorage.resume()
  }
  const onboarding = createOnboarding(productStorage)
  const updater = setupAutoUpdater(stopSidecars, productStorage)
  wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        credentialVault,
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
      readServers: () => productStorage.getWslServers("main/wsl"),
      writeServers: (servers) => productStorage.setWslServers("main/wsl", servers),
    },
  )
  sshServers = createSshServersController(
    {
      // Control sockets need a short path (sockaddr_un is ~104 bytes), so they
      // live in a per-user /tmp dir rather than the deep app-data path.
      controlDir: sshControlDir(),
      credentialVault,
      // Only packaged builds carry a real forge binary; in dev FORGE_CLI_COMMAND
      // resolves to bun, which is useless on the remote.
      localForgeBinary: app.isPackaged ? join(process.resourcesPath, "forge-cli") : null,
      appVersion: app.getVersion(),
      corsOrigins: rendererCorsOrigins,
      onPrompt: async () => null,
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
      readServers: () => productStorage.getSshServers("main/ssh"),
      writeServers: (servers) => productStorage.setSshServers("main/ssh", servers),
    },
  )
  profiler = createProfilerController({
    getSidecar: () => server,
    userDataPath: app.getPath("userData"),
    environment: () => ({
      version: app.getVersion(),
      name: app.getName(),
      channel: CHANNEL,
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      userData: app.getPath("userData"),
    }),
    log: (message, extra) => writeLog("profiler", message, extra),
    warn: (message, extra) => writeLog("profiler", message, extra, "warn"),
  })

  registerIpcHandlers({
    securityProxyStore: (command) => {
      if (!server) return Promise.reject(new Error("Local sidecar is not ready"))
      return server.securityProxy(command)
    },
    securityProxyOrigin: () => securityProxyOrigin,
    securityProxyCommand: invokeSecurityProxy,
    killSidecar: () => killSidecar(),
    profiler,
    relaunch,
    awaitInitialization: async () => {
      logger.log("awaiting server ready")
      const res = await awaitServerReady()
      logger.log("server ready", { url: res.url })
      return res
    },
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: (owner) => productStorage.getDefaultServerUrl(owner),
    setDefaultServerUrl: (owner, url) => productStorage.setDefaultServerUrl(owner, url),
    isFirstLaunchOnboardingPending: (owner) => onboarding.isFirstLaunchOnboardingPending(owner),
    finishFirstLaunchOnboarding: (owner) => onboarding.finishFirstLaunchOnboarding(owner),
    isOldLayoutEligible: (owner) => onboarding.isOldLayoutEligible(owner),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    storage,
    releaseProductStorage: (owner) => productStorage.release(owner),
    getPinchZoomEnabled,
    setPinchZoomEnabled,
    getWindowLastActiveUrl: (owner, id, legacy) => productStorage.getWindowLastActiveUrl(owner, id, legacy),
    setWindowLastActiveUrl: (owner, id, value) => productStorage.setWindowLastActiveUrl(owner, id, value),
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
  })
  registerWslIpcHandlers(wslServers)
  registerSshIpcHandlers(sshServers)
  void startNetLog().catch((error) => logger.warn("failed to start net log", error))

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.FORGE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  securityProxyOrigin = url
  // The repository beta workflow supplies an ephemeral probe password; production keeps a random secret.
  const password =
    process.env.FORGE_CHANNEL === "beta" && process.env.FORGE_BETA_SERVER_PASSWORD
      ? process.env.FORGE_BETA_SERVER_PASSWORD
      : randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    // The sidecar has died cleanly in the field with main still alive (exit 0
    // seconds after ready), leaving every window pointed at a dead server with
    // no path back short of relaunching the app. Supervise it: `killSidecar`
    // nulls `server` before any deliberate stop, so an exit that still sees
    // `server` set is unexpected and earns a bounded respawn on the same
    // hostname/port/password — the renderer's connection info stays valid and
    // its event stream simply reconnects.
    const SIDECAR_RESPAWN_LIMIT = 5
    let sidecarRespawns = 0
    const sidecarOptions = (): Parameters<typeof spawnLocalServer>[3] => ({
      userDataPath: app.getPath("userData"),
      credentialVault,
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code) => handleSidecarExit(code),
      securityProxyCommand: invokeSecurityProxy,
    })
    const handleSidecarExit = (code: number) => {
      writeLog("utility", "sidecar exited", { code }, "warn")
      if (!server) return
      server = null
      void boundTeardownStep("securityProxy", disconnectSecurityProxy)().catch(() => undefined)
      if (sidecarRespawns >= SIDECAR_RESPAWN_LIMIT) {
        writeLog("utility", "sidecar exited unexpectedly; respawn limit reached", { code }, "error")
        return
      }
      const attempt = ++sidecarRespawns
      writeLog("utility", "sidecar exited unexpectedly; respawning", { code, attempt }, "error")
      setTimeout(() => {
        void spawnLocalServer(hostname, port, password, sidecarOptions())
          .then(({ listener: respawned }) => {
            server = respawned
            writeLog("utility", "sidecar respawned", { attempt })
          })
          .catch((error) => {
            writeLog("utility", "sidecar respawn failed", { attempt, error: String(error) }, "error")
          })
      }, 1_000 * attempt)
    }
    // `Effect.promise` converts a rejection into a defect, and the sidecar reports
    // startup failures over IPC rather than stderr — so a failed start produced a
    // dead backend with nothing in any log. Name the error before it propagates.
    const { listener, health } = yield* Effect.tryPromise({
      try: () => spawnLocalServer(hostname, port, password, sidecarOptions()),
      catch: (error) => {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
        writeLog("utility", "sidecar failed to start", { error: detail }, "error")
        return error
      },
    }).pipe(Effect.orDie)
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "forge",
      password,
    })

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  yield* Effect.promise(() => productStorage.ready())
  yield* Effect.promise(() => initializeWindows(productStorage))
  if (process.platform === "win32") {
    void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
  }
  void sshServers.initialize().catch((error) => logger.error("ssh server initialization failed", error))
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))

  const windows = yield* Effect.promise(() => restoreMainWindows())
  if (windows.length) {
    createMenu({
      trigger: (id) => {
        const win = getLastFocusedWindow()
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }
})

Effect.runFork(main)
