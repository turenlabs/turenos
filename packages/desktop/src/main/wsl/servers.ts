import type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslForgeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "../../preload/types"
import { expectForgeVersion, pendingRestartAfterWslInstall, wslServerIdsToStartOnInitialize } from "./startup"
import { clearWslDistroState, wslServerIdToRestart } from "./policy"
import {
  installWslDistro,
  installWslForge,
  installWslRuntimeElevated,
  listInstalledWslDistros,
  listOnlineWslDistros,
  openWslTerminal,
  probeWslDistro,
  probeWslRuntime,
  readWslCommandVersion,
  resolveWslForge,
  summarize,
} from "./runtime"

type RunningSidecar = {
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
}

type SpawnSidecar = (distro: string) => Promise<RunningSidecar>

type ControllerLogger = {
  log: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

type WslServersControllerOptions = {
  logger?: ControllerLogger
  readServers?: () => Promise<WslServerConfig[]> | WslServerConfig[]
  writeServers?: (servers: WslServerConfig[]) => Promise<void> | void
  probeDistro?: typeof probeWslDistro
  resolveForge?: typeof resolveWslForge
  readCommandVersion?: typeof readWslCommandVersion
}

export type WslServersController = ReturnType<typeof createWslServersController>

export function wslServerIdForDistro(distro: string) {
  return `wsl:${distro}`
}

export function createWslServersController(
  appVersion: string,
  spawnSidecar: SpawnSidecar,
  options?: WslServersControllerOptions,
) {
  let state: WslServersState = initialState()
  const listeners = new Set<(event: WslServersEvent) => void>()
  const sidecars = new Map<string, RunningSidecar>()
  const startAttempts = new Map<string, number>()
  let jobAbort: AbortController | undefined
  const logger = options?.logger
  const readServers = options?.readServers ?? (() => [])
  const writeServers = options?.writeServers ?? (() => undefined)
  const probeDistro = options?.probeDistro ?? probeWslDistro

  const emit = () => {
    for (const listener of listeners) listener({ type: "state", state })
  }

  const setState = (next: Partial<WslServersState>) => {
    state = { ...state, ...next }
    emit()
  }

  const persistServers = (servers: WslServerConfig[]) => writeServers(servers)

  const updateServer = (id: string, update: (item: WslServerItem) => WslServerItem) => {
    const next = state.servers.map((item) => (item.config.id === id ? update(item) : item))
    setState({ servers: next })
  }

  const beginJob = (job: WslJob): AbortController => {
    jobAbort?.abort()
    const abort = new AbortController()
    jobAbort = abort
    setState({ job })
    return abort
  }

  const endJob = (abort: AbortController) => {
    if (jobAbort !== abort) return
    jobAbort = undefined
    setState({ job: null })
  }

  const refreshFromStore = async () => {
    const persisted = await readServers()
    const items: WslServerItem[] = persisted.map((config) => {
      const existing = state.servers.find((item) => item.config.id === config.id)
      return {
        config,
        runtime: existing?.runtime ?? { kind: "stopped" },
      }
    })
    setState({ servers: items })
  }

  const setRuntime = (id: string, runtime: WslServerRuntime) => {
    updateServer(id, (item) => ({ ...item, runtime }))
  }

  const setForgeCheck = (distro: string, check: WslForgeCheck) => {
    setState({
      forgeChecks: {
        ...state.forgeChecks,
        [distro]: check,
      },
    })
  }

  const checkForge = async (distro: string, opts?: { signal?: AbortSignal }) => {
    const resolved = await (options?.resolveForge ?? resolveWslForge)(distro, opts)
    const version = resolved
      ? await (options?.readCommandVersion ?? readWslCommandVersion)(resolved, distro, opts)
      : null
    return forgeCheck(distro, resolved, version, appVersion)
  }

  const refreshForgeCheck = async (distro: string, opts?: { signal?: AbortSignal }) => {
    setForgeCheck(distro, await checkForge(distro, opts))
  }

  const probeAddableDistros = async (distros: string[], opts?: { signal?: AbortSignal }) => {
    const unique = [...new Set(distros)]
    const distroProbes = await Promise.all(
      unique
        .filter((distro) => !state.distroProbes[distro])
        .map(async (distro) => [distro, await probeDistro(distro, opts)] as const),
    )
    if (distroProbes.length) {
      setState({ distroProbes: { ...state.distroProbes, ...Object.fromEntries(distroProbes) } })
    }

    const forgeChecks = await Promise.all(
      unique
        .filter((distro) => distroProbeReady(state.distroProbes[distro]))
        .filter((distro) => !state.forgeChecks[distro])
        .map(async (distro) => [distro, await checkForge(distro, opts)] as const),
    )
    if (forgeChecks.length) {
      setState({ forgeChecks: { ...state.forgeChecks, ...Object.fromEntries(forgeChecks) } })
    }
  }

  const hasServer = (id: string, distro: string) => {
    return state.servers.some((item) => item.config.id === id && item.config.distro === distro)
  }

  const refreshForgeCheckBackground = (id: string, distro: string) => {
    void checkForge(distro)
      .then((check) => {
        if (!hasServer(id, distro)) return
        setForgeCheck(distro, check)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        logger?.error("wsl forge check failed", { id, distro, message })
      })
  }

  const refreshForgeChecks = async () => {
    await Promise.all(
      state.servers.map((item) =>
        checkForge(item.config.distro)
          .then((check) => {
            if (!hasServer(item.config.id, item.config.distro)) return
            setForgeCheck(item.config.distro, check)
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            logger?.error("wsl forge check failed", {
              id: item.config.id,
              distro: item.config.distro,
              message,
            })
          }),
      ),
    )
  }

  const refreshDistroLists = async (opts: { signal?: AbortSignal }) => {
    const [installed, online] = await Promise.all([listInstalledWslDistros(opts), listOnlineWslDistros(opts)])
    return { installed, online }
  }

  const nextStartAttempt = (id: string) => {
    const next = (startAttempts.get(id) ?? 0) + 1
    startAttempts.set(id, next)
    return next
  }

  const invalidateStartAttempt = (id: string) => {
    startAttempts.set(id, (startAttempts.get(id) ?? 0) + 1)
  }

  const isCurrentStartAttempt = (id: string, attempt: number) => {
    return startAttempts.get(id) === attempt && state.servers.some((item) => item.config.id === id)
  }

  const startServer = async (id: string) => {
    const item = state.servers.find((x) => x.config.id === id)
    if (!item) return
    const attempt = nextStartAttempt(id)
    await stopServerInternal(id)
    if (!isCurrentStartAttempt(id, attempt)) return
    setRuntime(id, { kind: "starting" })
    logger?.log("wsl sidecar starting", { id, distro: item.config.distro })
    try {
      const sidecar = await spawnSidecar(item.config.distro)
      if (!isCurrentStartAttempt(id, attempt)) {
        try {
          sidecar.listener.stop()
        } catch {
          // ignore stop errors for stale sidecars
        }
        return
      }
      sidecars.set(id, sidecar)
      setRuntime(id, {
        kind: "ready",
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })
      sidecar.listener.onExit((code, signal) => {
        if (sidecars.get(id) !== sidecar) return
        sidecars.delete(id)
        const message = startupFailure(code, signal)
        setRuntime(id, { kind: "failed", message })
        logger?.error("wsl sidecar exited", { id, distro: item.config.distro, code, signal })
      })
      refreshForgeCheckBackground(id, item.config.distro)
      logger?.log("wsl sidecar ready", { id, distro: item.config.distro, url: sidecar.url })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isCurrentStartAttempt(id, attempt)) return
      setRuntime(id, { kind: "failed", message })
      // Without this, an Ubuntu-style silent failure leaves no trace in
      // main.log — the controller captures the message in its state but
      // nothing surfaces unless the user opens the WSL servers dialog.
      logger?.error("wsl sidecar failed to start", { id, distro: item.config.distro, message })
    }
  }

  const stopServerInternal = async (id: string) => {
    const existing = sidecars.get(id)
    if (!existing) return
    sidecars.delete(id)
    try {
      existing.listener.stop()
    } catch {
      // ignore stop errors
    }
  }

  const runJob = async <T>(job: WslJob, runner: (abort: AbortController) => Promise<T>) => {
    const abort = beginJob(job)
    try {
      const value = await runner(abort)
      endJob(abort)
      return value
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        endJob(abort)
        return undefined
      }
      const err = error instanceof Error ? error : new Error(String(error))
      endJob(abort)
      throw err
    }
  }

  return {
    getState() {
      return state
    },
    subscribe(listener: (event: WslServersEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async initialize() {
      await refreshFromStore()
      void refreshForgeChecks()
      for (const id of wslServerIdsToStartOnInitialize(state.servers.map((item) => item.config))) void startServer(id)
    },

    async probeRuntime() {
      await runJob({ kind: "runtime", startedAt: Date.now() }, async (abort) => {
        const runtime = await probeWslRuntime({ signal: abort.signal })
        setState({
          runtime,
          pendingRestart: state.pendingRestart && !runtime.available ? state.pendingRestart : false,
        })
      })
    },

    async refreshDistros() {
      await runJob({ kind: "distros", startedAt: Date.now() }, async (abort) => {
        setState(await refreshDistroLists({ signal: abort.signal }))
      })
    },

    async installWsl() {
      await runJob({ kind: "install-wsl", startedAt: Date.now() }, async (abort) => {
        const result = await installWslRuntimeElevated({ signal: abort.signal })
        if (result.code !== 0) {
          const message = summarize(result.stderr || result.stdout) || "WSL installation failed"
          throw new Error(message)
        }
        const runtime = await probeWslRuntime({ signal: abort.signal })
        setState({ runtime, pendingRestart: pendingRestartAfterWslInstall(runtime) })
      })
    },

    async installDistro(name: string) {
      await runJob({ kind: "install-distro", distro: name, startedAt: Date.now() }, async (abort) => {
        const result = await installWslDistro(name, { signal: abort.signal })
        if (result.code !== 0) {
          const message = summarize(result.stderr || result.stdout) || `Failed to install distro: ${name}`
          throw new Error(message)
        }
        const distros = await refreshDistroLists({ signal: abort.signal })
        const probe = await probeDistro(name, { signal: abort.signal })
        setState({
          ...distros,
          distroProbes: { ...state.distroProbes, [name]: probe },
        })
      })
    },

    async probeAddable(distros: string[]) {
      if (!distros.length) return
      await runJob({ kind: "probe-addable", distros, startedAt: Date.now() }, async (abort) => {
        await probeAddableDistros(distros, { signal: abort.signal })
      })
    },

    async installForge(name: string) {
      await runJob({ kind: "install-forge", distro: name, startedAt: Date.now() }, async (abort) => {
        const result = await installWslForge(appVersion, name, { signal: abort.signal })
        if (result.code !== 0) {
          throw new Error(summarize(result.stderr || result.stdout) || "TurenOS installation failed")
        }
        await refreshForgeCheck(name, { signal: abort.signal })
        expectForgeVersion(state.forgeChecks[name]?.version ?? null, appVersion, name)
        const id = wslServerIdToRestart(state.servers, name)
        if (id) await startServer(id)
      })
    },

    async openTerminal(name: string) {
      await openWslTerminal(name)
    },

    async addServer(distro: string): Promise<WslServerConfig> {
      const id = wslServerIdForDistro(distro)
      if (state.servers.some((item) => item.config.id === id)) {
        throw new Error(`${distro} is already added`)
      }
      const config: WslServerConfig = {
        id,
        distro,
      }
      await persistServers([...(await readServers()), config])
      setState({
        servers: [...state.servers, { config, runtime: { kind: "starting" } }],
      })
      void startServer(id)
      return config
    },

    async removeServer(id: string) {
      const distro = state.servers.find((item) => item.config.id === id)?.config.distro
      invalidateStartAttempt(id)
      await stopServerInternal(id)
      const remaining = (await readServers()).filter((item) => item.id !== id)
      await persistServers(remaining)
      setState({
        servers: state.servers.filter((item) => item.config.id !== id),
        ...(distro ? clearWslDistroState(state.distroProbes, state.forgeChecks, distro) : {}),
      })
    },

    startServer,

    stopAll() {
      for (const item of state.servers) invalidateStartAttempt(item.config.id)
      for (const existing of sidecars.values()) {
        try {
          existing.listener.stop()
        } catch {
          // ignore
        }
      }
      sidecars.clear()
    },
  }
}

function initialState(): WslServersState {
  return {
    runtime: null,
    installed: [],
    online: [],
    distroProbes: {},
    forgeChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  }
}

function forgeCheck(
  distro: string,
  resolvedPath: string | null,
  version: string | null,
  expectedVersion: string,
): WslForgeCheck {
  if (!resolvedPath) {
    return {
      distro,
      resolvedPath: null,
      version: null,
      expectedVersion,
      matchesDesktop: null,
      error: "forge is not installed in this distro",
    }
  }
  if (!version) {
    return {
      distro,
      resolvedPath,
      version: null,
      expectedVersion,
      matchesDesktop: null,
      error: "forge is installed but could not run",
    }
  }
  return {
    distro,
    resolvedPath,
    version,
    expectedVersion,
    matchesDesktop: version === expectedVersion,
    error: null,
  }
}

function distroProbeReady(probe: WslDistroProbe | undefined) {
  return !!probe?.canExecute && probe.hasBash && probe.hasCurl
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null) {
  return `WSL server exited after startup (code=${code ?? "null"} signal=${signal ?? "null"})`
}

// Re-export types used by callers
export type {
  WslInstalledDistro,
  WslOnlineDistro,
  WslRuntimeCheck,
  WslDistroProbe,
  WslForgeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
}
