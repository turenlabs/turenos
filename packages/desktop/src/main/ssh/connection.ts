import { createServer } from "node:net"
import { readFile } from "node:fs/promises"
import type { SshServerConfig } from "../../preload/types"
import { checkHealth } from "../server"
import type { CredentialVault } from "../secret-key"
import { pollSshHealth } from "./startup"
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
 * control master, refresh the remote lifecycle shim, ensure the daemonized
 * `forge serve` is up, then open the loopback tunnel and wait for health.
 */
export async function connectSshRemote(
  config: SshServerConfig,
  deps: SshConnectionDeps,
): Promise<SshConnection> {
  const binary = deps.binary ?? sshBinary()
  const target = targetFor(config)

  await ensureMaster(binary, deps.controlDir, target, {
    onPrompt: deps.onPrompt,
    signal: deps.signal,
  })

  // Always refresh the shim - it is small, and an outdated copy self-heals.
  await writeRemoteFile(binary, deps.controlDir, target, FORGE_REMOTE_SHIM_PATH, FORGE_REMOTE_SHIM, 0o755, {
    signal: deps.signal,
  })

  const state = await ensureRemote(binary, deps.controlDir, target, deps).catch(async (error) => {
    if (!(error instanceof ForgeRemoteMissingError)) throw error
    await installForgeRemote(config, deps)
    return ensureRemote(binary, deps.controlDir, target, deps)
  })

  const localPort = await allocatePort()
  const tunnel = spawnTunnel(binary, deps.controlDir, target, localPort, state.port, {
    onLine: deps.onLine,
    signal: deps.signal,
  })

  const url = `http://127.0.0.1:${localPort}`
  const startup = new AbortController()
  const health = pollSshHealth(() => checkHealth(url, state.password), startup.signal)
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
    tunnel.stop()
    throw error
  } finally {
    clearTimeout(timeout!)
    startup.abort()
  }

  return {
    listener: { stop: () => tunnel.stop(), onExit: (cb) => tunnel.onExit(cb) },
    url,
    username: state.username,
    password: state.password,
  }
}

async function ensureRemote(
  binary: string,
  controlDir: string,
  target: SshTarget,
  deps: SshConnectionDeps,
) {
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

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
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
