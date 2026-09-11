import { randomUUID } from "node:crypto"
import type {
  SshForgeCheck,
  SshHostProbe,
  SshJob,
  SshServerConfig,
  SshServerItem,
  SshServerRuntime,
  SshServersEvent,
  SshServersState,
  SshTargetInput,
} from "../../preload/types"
import type { SshConnection, SshConnectionDeps } from "./connection"
import { expectSshForgeVersion, sshReconnectDelays, sshServerIdsToStartOnInitialize } from "./startup"
import { clearSshHostState, sshServerConfig, targetForConfig } from "./policy"
import {
  checkSshRuntime,
  ensureMaster,
  installRemoteForge,
  localPlatformTarget,
  parseSshTarget,
  probeRemote,
  remotePlatformTarget,
  resolveSshTarget,
  sshBinary,
  streamForgeBinary,
  writeRemoteFile,
  type SshPromptRequest,
} from "./runtime"
import { FORGE_REMOTE_SHIM, FORGE_REMOTE_SHIM_PATH } from "./shim"
import { readFile } from "node:fs/promises"

type ControllerLogger = {
  log: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

export type SshServersControllerOptions = {
  logger?: ControllerLogger
  readServers?: () => Promise<SshServerConfig[]> | SshServerConfig[]
  writeServers?: (servers: SshServerConfig[]) => Promise<void> | void
  /** Test seam: replaces the full connect sequence */
  connect?: (
    config: SshServerConfig,
    ctx: { onPrompt: (request: SshPromptRequest) => Promise<string | null> },
  ) => Promise<SshConnection>
  /** Test seam: replaces the remote forge install */
  installForge?: (config: SshServerConfig) => Promise<void>
  /** Test seam: probe without touching ssh */
  probe?: (target: ReturnType<typeof parseSshTarget>) => Promise<SshHostProbe>
  /** Test seam: replaces the post-install remote forge version check */
  forgeCheck?: (config: SshServerConfig) => Promise<SshForgeCheck>
  resolve?: typeof resolveSshTarget
  /** Test seam: reconnect backoff schedule */
  reconnectDelays?: () => number[]
}

export type SshServersController = ReturnType<typeof createSshServersController>

export function createSshServersController(deps: SshConnectionDeps, options?: SshServersControllerOptions) {
  let state: SshServersState = {
    runtime: null,
    servers: [],
    probes: {},
    forgeChecks: {},
    prompt: null,
    job: null,
  }
  const listeners = new Set<(event: SshServersEvent) => void>()
  const connections = new Map<string, SshConnection>()
  const startAttempts = new Map<string, number>()
  const reconnects = new Map<string, { count: number; timer?: ReturnType<typeof setTimeout> }>()
  const pendingPrompts = new Map<string, (response: string | null) => void>()
  let jobAbort: AbortController | undefined
  const logger = options?.logger
  const readServers = options?.readServers ?? (() => [])
  const writeServers = options?.writeServers ?? (() => undefined)
  const binary = deps.binary ?? sshBinary()

  const emit = () => {
    for (const listener of listeners) listener({ type: "state", state })
  }

  const setState = (next: Partial<SshServersState>) => {
    state = { ...state, ...next }
    emit()
  }

  const updateServer = (id: string, update: (item: SshServerItem) => SshServerItem) => {
    setState({ servers: state.servers.map((item) => (item.config.id === id ? update(item) : item)) })
  }

  const setRuntime = (id: string, runtime: SshServerRuntime) => {
    updateServer(id, (item) => ({ ...item, runtime }))
  }

  const setForgeCheck = (id: string, check: SshForgeCheck) => {
    setState({ forgeChecks: { ...state.forgeChecks, [id]: check } })
  }

  const onPrompt = (target: string) => async (request: SshPromptRequest) => {
    const requestId = randomUUID()
    setState({ prompt: { requestId, target, kind: request.kind, message: request.message } })
    const response = await new Promise<string | null>((resolve) => pendingPrompts.set(requestId, resolve))
    if (state.prompt?.requestId === requestId) setState({ prompt: null })
    pendingPrompts.delete(requestId)
    return response
  }

  const beginJob = (job: SshJob): AbortController => {
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

  const runJob = async <T>(job: SshJob, runner: (abort: AbortController) => Promise<T>) => {
    const abort = beginJob(job)
    try {
      const value = await runner(abort)
      endJob(abort)
      return value
    } catch (error) {
      endJob(abort)
      if (error instanceof Error && error.name === "AbortError") return undefined
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  const connect = async (config: SshServerConfig): Promise<SshConnection> => {
    if (options?.connect) return options.connect(config, { onPrompt: onPrompt(config.id) })
    // Lazy: connection.ts pulls in electron-bound modules (server.ts).
    const { connectSshRemote } = await import("./connection")
    return connectSshRemote(config, { ...deps, onPrompt: onPrompt(config.id) })
  }

  const installRemote = async (config: SshServerConfig) => {
    if (options?.installForge) return options.installForge(config)
    const target = targetForConfig(config)
    const abort = new AbortController()
    await ensureMaster(binary, deps.controlDir, target, { onPrompt: onPrompt(config.id), signal: abort.signal })
    const probe = await probeRemote(binary, deps.controlDir, target, { signal: abort.signal })
    if (probe.hasCurl) {
      // The shim's `install` is POSIX sh + curl only - no bash needed.
      await writeRemoteFile(binary, deps.controlDir, target, FORGE_REMOTE_SHIM_PATH, FORGE_REMOTE_SHIM, 0o755, {
        signal: abort.signal,
      })
      await installRemoteForge(binary, deps.controlDir, target, deps.appVersion, { signal: abort.signal })
      return
    }
    const remoteTarget = remotePlatformTarget(probe.platform)
    if (remoteTarget && remoteTarget === localPlatformTarget() && deps.localForgeBinary) {
      await streamForgeBinary(binary, deps.controlDir, target, await readFile(deps.localForgeBinary), {
        signal: abort.signal,
      })
      return
    }
    throw new Error(
      `forge is not installed on ${config.host} and the remote cannot install it (needs curl). ` +
        `Run the TurenOS install script on the remote: curl -fsSL https://raw.githubusercontent.com/turenlabs/turenos/main/install | bash`,
    )
  }

  const refreshForgeCheck = async (config: SshServerConfig) => {
    try {
      if (options?.forgeCheck) {
        if (!state.servers.some((item) => item.config.id === config.id)) return
        setForgeCheck(config.id, await options.forgeCheck(config))
        return
      }
      const target = targetForConfig(config)
      await ensureMaster(binary, deps.controlDir, target, {
        onPrompt: onPrompt(config.id),
      })
      const probe = await probeRemote(binary, deps.controlDir, target)
      if (!state.servers.some((item) => item.config.id === config.id)) return
      setForgeCheck(config.id, {
        host: config.id,
        resolvedPath: probe.forgePath,
        version: probe.forgeVersion,
        expectedVersion: deps.appVersion,
        matchesDesktop: probe.forgeVersion === null ? null : probe.forgeVersion === deps.appVersion,
        error: probe.forgePath
          ? probe.forgeVersion
            ? null
            : "forge is installed but could not run"
          : "forge is not installed on this host",
      })
    } catch (error) {
      logger?.error("ssh forge check failed", {
        id: config.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
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

  const cancelReconnect = (id: string) => {
    // Clear a pending timer without resetting the retry count - retries are
    // counted across consecutive failures and only reset once a connection
    // actually reaches ready.
    const entry = reconnects.get(id)
    if (entry?.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  const scheduleReconnect = (id: string) => {
    const entry = reconnects.get(id) ?? { count: 0 }
    const delay = (options?.reconnectDelays ?? sshReconnectDelays)()[entry.count]
    if (delay === undefined) return
    entry.count += 1
    reconnects.set(id, entry)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (!state.servers.some((item) => item.config.id === id)) return
      if (connections.has(id)) return
      logger?.log("ssh reconnecting", { id, attempt: entry.count })
      void startServer(id)
    }, delay)
  }

  const startServer = async (id: string) => {
    const item = state.servers.find((x) => x.config.id === id)
    if (!item) return
    const attempt = nextStartAttempt(id)
    await stopConnection(id)
    if (!isCurrentStartAttempt(id, attempt)) return
    setRuntime(id, { kind: "starting" })
    logger?.log("ssh connecting", { id, host: item.config.host })
    try {
      const connection = await connect(item.config)
      if (!isCurrentStartAttempt(id, attempt)) {
        try {
          connection.listener.stop()
        } catch {
          /* ignore */
        }
        return
      }
      connections.set(id, connection)
      setRuntime(id, {
        kind: "ready",
        url: connection.url,
        username: connection.username,
        password: connection.password,
      })
      reconnects.set(id, { count: 0 })
      connection.listener.onExit((code, signal) => {
        if (connections.get(id) !== connection) return
        connections.delete(id)
        setRuntime(id, { kind: "failed", message: tunnelFailure(code, signal) })
        logger?.error("ssh tunnel exited", { id, host: item.config.host, code, signal })
        scheduleReconnect(id)
      })
      void refreshForgeCheck(item.config)
      logger?.log("ssh connected", { id, host: item.config.host, url: connection.url })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isCurrentStartAttempt(id, attempt)) return
      setRuntime(id, { kind: "failed", message })
      logger?.error("ssh connection failed", { id, host: item.config.host, message })
      // Connect failures get the same bounded backoff as tunnel drops - a
      // laptop sleep kills the tunnel while the network is still down.
      // A user-cancelled prompt is not retried: that would re-prompt.
      if (error instanceof Error && error.name !== "AbortError") scheduleReconnect(id)
    }
  }

  const stopConnection = async (id: string) => {
    cancelReconnect(id)
    const existing = connections.get(id)
    if (!existing) return
    connections.delete(id)
    try {
      existing.listener.stop()
    } catch {
      /* ignore */
    }
  }

  const refreshFromStore = async () => {
    const persisted = await readServers()
    const items: SshServerItem[] = persisted.map((config) => {
      const existing = state.servers.find((item) => item.config.id === config.id)
      return { config, runtime: existing?.runtime ?? { kind: "stopped" } }
    })
    setState({ servers: items })
  }

  const normalizeInput = (input: SshTargetInput) => {
    const parsed = parseSshTarget(input.host)
    if (!parsed) throw new Error(`Invalid SSH target: ${input.host}`)
    return {
      host: parsed.host,
      user: parsed.user,
      port: input.port ?? parsed.port,
      identityFile: input.identityFile ?? null,
      displayName: input.displayName?.trim() || null,
    }
  }

  return {
    getState() {
      return state
    },
    subscribe(listener: (event: SshServersEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async initialize() {
      await refreshFromStore()
      for (const id of sshServerIdsToStartOnInitialize(state.servers.map((item) => item.config))) {
        void startServer(id)
      }
    },

    async probeRuntime() {
      setState({ runtime: await checkSshRuntime() })
    },

    async probeHost(input: SshTargetInput) {
      const target = normalizeInput(input)
      const key = `probe:${target.user ? target.user + "@" : ""}${target.host}${target.port ? ":" + target.port : ""}`
      const run = async () => {
        if (options?.probe) return options.probe(target)
        const resolved = await (options?.resolve ?? resolveSshTarget)(target)
        const probeTarget = {
          host: target.host,
          user: target.user ?? resolved.user,
          port: target.port ?? resolved.port,
          identityFile: target.identityFile ?? resolved.identityFile,
        }
        await ensureMaster(binary, deps.controlDir, probeTarget, {
          onPrompt: onPrompt(key),
        })
        const remote = await probeRemote(binary, deps.controlDir, probeTarget)
        return {
          host: key,
          sshAvailable: true,
          batchAuth: true,
          platform: remote.platform,
          hasBash: remote.hasBash,
          forgePath: remote.forgePath,
          forgeVersion: remote.forgeVersion,
          error: null,
        }
      }
      await runJob({ kind: "probe", host: key, startedAt: Date.now() }, async () => {
        try {
          const probe = await run()
          setState({ probes: { ...state.probes, [key]: probe } })
        } catch (error) {
          const cancelled = error instanceof Error && error.name === "AbortError"
          setState({
            probes: {
              ...state.probes,
              [key]: {
                host: key,
                sshAvailable: true,
                batchAuth: false,
                platform: null,
                hasBash: false,
                forgePath: null,
                forgeVersion: null,
                error: cancelled ? null : error instanceof Error ? error.message : String(error),
              },
            },
          })
          if (!cancelled) throw error
        }
      })
    },

    async addServer(input: SshTargetInput): Promise<SshServerConfig> {
      const target = normalizeInput(input)
      const resolved = await (options?.resolve ?? resolveSshTarget)(target)
      const config = sshServerConfig(target, resolved, target.displayName)
      if (state.servers.some((item) => item.config.id === config.id)) {
        throw new Error(`${sshDestinationLabel(config)} is already added`)
      }
      await writeServers([...(await readServers()), config])
      setState({ servers: [...state.servers, { config, runtime: { kind: "starting" } }] })
      void startServer(config.id)
      return config
    },

    async removeServer(id: string) {
      invalidateStartAttempt(id)
      await stopConnection(id)
      const config = state.servers.find((item) => item.config.id === id)?.config
      if (config) {
        // Never re-authenticate during removal - if the master is already
        // alive the stop runs over it; otherwise the remote stays up.
        await import("./connection")
          .then(({ stopSshRemote }) => stopSshRemote(config, { ...deps, reachable: false }))
          .catch((error) => {
            logger?.error("ssh remote stop failed", {
              id,
              message: error instanceof Error ? error.message : String(error),
            })
          })
      }
      const remaining = (await readServers()).filter((item) => item.id !== id)
      await writeServers(remaining)
      setState({
        servers: state.servers.filter((item) => item.config.id !== id),
        ...clearSshHostState(state.probes, state.forgeChecks, id),
      })
    },

    startServer,

    async stopRemote(id: string) {
      const config = state.servers.find((item) => item.config.id === id)?.config
      if (!config) return
      invalidateStartAttempt(id)
      await stopConnection(id)
      await import("./connection")
        .then(({ stopSshRemote }) => stopSshRemote(config, { ...deps, onPrompt: onPrompt(id) }))
        .catch((error) => {
          logger?.error("ssh remote stop failed", {
            id,
            message: error instanceof Error ? error.message : String(error),
          })
        })
      setRuntime(id, { kind: "stopped" })
    },

    async installForge(id: string) {
      const config = state.servers.find((item) => item.config.id === id)?.config
      if (!config) return
      await runJob({ kind: "install-forge", id, startedAt: Date.now() }, async () => {
        await installRemote(config)
        await refreshForgeCheck(config)
        expectSshForgeVersion(state.forgeChecks[id]?.version ?? null, deps.appVersion, config.host)
        void startServer(id)
      })
    },

    respondPrompt(requestId: string, response: string | null) {
      const resolve = pendingPrompts.get(requestId)
      pendingPrompts.delete(requestId)
      if (state.prompt?.requestId === requestId) setState({ prompt: null })
      resolve?.(response)
    },

    stopAll() {
      for (const item of state.servers) {
        invalidateStartAttempt(item.config.id)
        cancelReconnect(item.config.id)
      }
      for (const existing of connections.values()) {
        try {
          existing.listener.stop()
        } catch {
          /* ignore */
        }
      }
      connections.clear()
      for (const resolve of pendingPrompts.values()) resolve(null)
      pendingPrompts.clear()
      if (state.prompt) setState({ prompt: null })
    },
  }
}

function sshDestinationLabel(config: SshServerConfig) {
  return `${config.user ? config.user + "@" : ""}${config.hostname ?? config.host}`
}

function tunnelFailure(code: number | null, signal: NodeJS.Signals | null) {
  return `SSH tunnel exited (code=${code ?? "null"} signal=${signal ?? "null"})`
}

export type { SshServerConfig, SshServerItem, SshServerRuntime, SshServersEvent, SshServersState }
