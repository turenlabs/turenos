import { createConnection, createServer } from "node:net"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { SshServerConfig } from "../../preload/types"
import type { CredentialVault } from "../secret-key"
import { pollSshHealth } from "./startup"
import {
  REMOTE_ATTACH_PROBE_SCRIPT,
  classifyAttach,
  parseAttachProbe,
  verifyDescriptor,
  type AttachRecord,
} from "./persistent"
import {
  FORGE_REMOTE_SHIM,
  FORGE_REMOTE_SHIM_PATH,
  parseRemoteState,
  remoteEnsureScript,
  remoteInstallMissing,
} from "./shim"
import {
  closeMaster,
  ensureMaster,
  installRemoteForge,
  localPlatformTarget,
  probeRemote,
  remotePlatformTarget,
  runRemote,
  spawnTunnel,
  sshBinary,
  streamForgeBinary,
  summarizeSshOutput,
  writeRemoteFile,
  type SshPromptResponder,
  type SshTarget,
} from "./runtime"

export type SshConnection = {
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
  /** Present when the connection attached to a managed persistent server */
  persistent?: { serverID: string }
}

export class ForgeRemoteMissingError extends Error {
  constructor(message = "forge is not installed on the remote host") {
    super(message)
    this.name = "ForgeRemoteMissingError"
  }
}

export type SshConnectionDeps = {
  binary?: string
  controlDir: string
  credentialVault: CredentialVault
  /** Packaged-only local forge binary path for the same-arch stream fallback */
  localForgeBinary?: string | null
  appVersion: string
  corsOrigins: () => string[]
  onPrompt: SshPromptResponder
  onLine?: (text: string) => void
  /** Test seam: try to occupy the local port while the forward is starting. */
  onReservedPort?: (port: number) => void
  signal?: AbortSignal
}

function targetFor(config: SshServerConfig): SshTarget {
  return {
    host: config.host,
    user: config.user,
    port: config.port,
    identityFile: config.identityFile,
  }
}

/**
 * Full connect for one configured ssh server: establish (or reuse) the
 * control master and check for a managed persistent server. A persistent
 * server is attached through its attach record without touching the shim or
 * sending the vault key. Otherwise refresh the remote lifecycle shim, ensure
 * the daemonized `forge serve` is up, then open the loopback tunnel and wait
 * for health.
 */
export async function connectSshRemote(config: SshServerConfig, deps: SshConnectionDeps): Promise<SshConnection> {
  const binary = deps.binary ?? sshBinary()
  const target = targetFor(config)

  await ensureMaster(binary, deps.controlDir, target, {
    onPrompt: deps.onPrompt,
    signal: deps.signal,
  })

  const probe = await runRemote(binary, deps.controlDir, target, "sh -s", {
    timeoutMs: 20_000,
    input: REMOTE_ATTACH_PROBE_SCRIPT,
    signal: deps.signal,
  })
  const classification = classifyAttach(config, parseAttachProbe(probe.stdout))
  if (classification.kind === "conflict") throw new Error(classification.message)
  if (classification.kind === "attach-existing") return attachPersistent(config, classification.record, deps)

  // Always refresh the shim - it is small, and an outdated copy self-heals.
  await writeRemoteFile(binary, deps.controlDir, target, FORGE_REMOTE_SHIM_PATH, FORGE_REMOTE_SHIM, 0o755, {
    signal: deps.signal,
  })

  const state = await ensureRemote(binary, deps.controlDir, target, deps).catch(async (error) => {
    if (!(error instanceof ForgeRemoteMissingError)) throw error
    await installForgeRemote(config, deps)
    return ensureRemote(binary, deps.controlDir, target, deps)
  })

  // Lazy: ../server pulls in Electron, which the persistent attach path never needs.
  const { checkHealth } = await import("../server")
  const { tunnel, url, stop } = await openTunnel(config, deps, state.port, (url) => checkHealth(url, state.password))
  return {
    listener: { stop, onExit: (cb) => tunnel.onExit(cb) },
    url,
    username: state.username,
    password: state.password,
  }
}

async function attachPersistent(
  config: SshServerConfig,
  record: AttachRecord,
  deps: SshConnectionDeps,
): Promise<SshConnection> {
  const authorization = `Basic ${Buffer.from(`${record.username}:${record.password}`).toString("base64")}`
  const describe = (url: string) =>
    fetch(new URL("/global/server", url), { headers: { authorization }, signal: AbortSignal.timeout(3000) })
  // Any answer below 500 means the tunnel reaches the server. A rejection (a rotated password, or a
  // server without the descriptor route) will not change by retrying, so it is reported below at once.
  const { tunnel, url, stop } = await openTunnel(config, deps, Number(new URL(record.url).port), (url) =>
    describe(url).then(
      (response) => response.status < 500,
      () => false,
    ),
  ).catch((error: Error) => {
    if (error.message !== "ssh tunnel health check timed out") throw error
    throw new Error(
      `${config.host} publishes persistent server ${record.serverID}, but it is not answering on ${record.url}. Check the service on the host (for example systemctl status turenos).`,
    )
  })
  await describe(url)
    .then(async (response) => {
      if (!response.ok)
        throw new Error(
          `TurenOS server ${record.serverID} on ${config.host} refused its descriptor request (HTTP ${response.status})`,
        )
      verifyDescriptor(record, await response.json())
    })
    .catch((error) => {
      stop()
      throw error
    })
  return {
    listener: { stop, onExit: (cb) => tunnel.onExit(cb) },
    url,
    username: record.username,
    password: record.password,
    persistent: { serverID: record.serverID },
  }
}

async function openTunnel(
  config: SshServerConfig,
  deps: SshConnectionDeps,
  remotePort: number,
  healthy: (url: string) => Promise<boolean>,
) {
  const binary = deps.binary ?? sshBinary()
  const directory = await mkdtemp(join(deps.controlDir, "f-"))
  const socketPath = join(directory, "s")
  const sockets = new Set<ReturnType<typeof createConnection>>()
  const proxy = createServer((socket) => {
    const upstream = createConnection(socketPath)
    sockets.add(socket)
    sockets.add(upstream)
    socket.on("error", () => upstream.destroy())
    upstream.on("error", () => socket.destroy())
    socket.on("close", () => sockets.delete(socket))
    upstream.on("close", () => sockets.delete(upstream))
    socket.pipe(upstream).pipe(socket)
  })
  const dispose = () => {
    if (proxy.listening) proxy.close()
    for (const socket of sockets) socket.destroy()
  }
  let tunnel: ReturnType<typeof spawnTunnel>
  let localPort: number
  try {
    localPort = await new Promise<number>((resolve, reject) => {
      proxy.once("error", reject)
      proxy.listen(0, "127.0.0.1", () => {
        proxy.removeListener("error", reject)
        const address = proxy.address()
        if (!address || typeof address === "string") return reject(new Error("Failed to bind tunnel proxy"))
        resolve(address.port)
      })
    })
    deps.onReservedPort?.(localPort)
    tunnel = spawnTunnel(binary, deps.controlDir, targetFor(config), socketPath, remotePort, {
      onLine: deps.onLine,
      signal: deps.signal,
    })
  } catch (error) {
    dispose()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const stop = () => {
    dispose()
    tunnel.stop()
  }
  tunnel.onExit(() => {
    dispose()
    void rm(directory, { recursive: true, force: true }).catch(() => undefined)
  })

  const url = `http://127.0.0.1:${localPort}`
  const startup = new AbortController()
  const health = pollSshHealth(() => healthy(url), startup.signal)
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("ssh tunnel health check timed out")), 20_000)
  })
  const exited = new Promise<never>((_, reject) => {
    tunnel.onExit((code, signal) =>
      reject(
        new Error(
          `ssh tunnel exited before becoming healthy (code=${code ?? "null"} signal=${signal ?? "null"}) ${summarizeSshOutput(tunnel.stderrTail())}`,
        ),
      ),
    )
  })
  try {
    await Promise.race([health, timedOut, exited])
  } catch (error) {
    stop()
    throw error
  } finally {
    clearTimeout(timeout!)
    startup.abort()
  }
  return { tunnel, url, stop }
}

async function ensureRemote(binary: string, controlDir: string, target: SshTarget, deps: SshConnectionDeps) {
  const result = await runRemote(binary, controlDir, target, "sh -s", {
    timeoutMs: 90_000,
    input: remoteEnsureScript({
      corsOrigins: deps.corsOrigins(),
      keyID: deps.credentialVault.keyID,
      key: deps.credentialVault.key,
    }),
    signal: deps.signal,
  }).catch((error) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
  if (result.code !== 0 && remoteInstallMissing(result.stderr + result.stdout)) {
    throw new ForgeRemoteMissingError()
  }
  if (result.code !== 0) {
    throw new Error(summarizeSshOutput(result.stderr || result.stdout) || "forge-remote ensure failed")
  }
  const state = parseRemoteState(result.stdout)
  if (!state) throw new Error("forge-remote ensure produced no state")
  return state
}

/**
 * Installs a version-matched forge on the remote. Order: the public install
 * script over curl; then streaming the desktop's bundled binary when the
 * remote arch matches this machine.
 */
async function installForgeRemote(config: SshServerConfig, deps: SshConnectionDeps) {
  const binary = deps.binary ?? sshBinary()
  const target = targetFor(config)
  const probe = await probeRemote(binary, deps.controlDir, target, { signal: deps.signal })

  if (probe.hasCurl) {
    await installRemoteForge(binary, deps.controlDir, target, deps.appVersion, { signal: deps.signal })
    return
  }

  const remoteTarget = remotePlatformTarget(probe.platform)
  const localBinary = deps.localForgeBinary
  if (remoteTarget && remoteTarget === localPlatformTarget() && localBinary) {
    await streamForgeBinary(binary, deps.controlDir, target, await readFile(localBinary), { signal: deps.signal })
    return
  }

  throw new Error(
    `forge is not installed on ${sshDest(config)} and the remote cannot install it (needs curl). ` +
      `Run the TurenOS install script on the remote: curl -fsSL https://raw.githubusercontent.com/turenlabs/turenos/main/install | bash`,
  )
}

function sshDest(config: SshServerConfig) {
  return `${config.user ? config.user + "@" : ""}${config.host}`
}

/**
 * Graceful remote shutdown for `stopRemote` / removal. When `reachable` is
 * false we never re-authenticate - a removal must not pop a password prompt;
 * the daemonized remote stays up and can be stopped manually or on re-add.
 */
export async function stopSshRemote(
  config: SshServerConfig,
  deps: Pick<SshConnectionDeps, "controlDir" | "onPrompt" | "signal"> & { binary?: string; reachable?: boolean },
) {
  const binary = deps.binary ?? sshBinary()
  const target = targetFor(config)
  if (deps.reachable !== false) {
    await ensureMaster(binary, deps.controlDir, target, {
      onPrompt: deps.onPrompt,
      signal: deps.signal,
    })
  }
  await runRemote(binary, deps.controlDir, target, `sh ${FORGE_REMOTE_SHIM_PATH} stop`, {
    timeoutMs: 20_000,
    signal: deps.signal,
  }).catch(() => undefined)
  await closeMaster(binary, deps.controlDir, target, deps.signal)
}
