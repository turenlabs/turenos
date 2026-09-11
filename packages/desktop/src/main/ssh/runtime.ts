import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as pty from "@lydell/node-pty"
import type { SshPromptKind } from "../../preload/types"
import { FORGE_REMOTE_SHIM_PATH } from "./shim"

export type SshTarget = {
  /** target as typed - user@host, alias, or plain host */
  host: string
  user: string | null
  port: number | null
  identityFile: string | null
}

export type SshResolved = {
  hostname: string
  user: string
  port: number
  identityFile: string | null
}

export type SshPromptRequest = {
  kind: SshPromptKind
  message: string
}

export type SshRunResult = {
  code: number | null
  stdout: string
  stderr: string
}

export type SshPromptResponder = (request: SshPromptRequest) => Promise<string | null>

const DEFAULT_SSH_TIMEOUT_MS = 30_000
const MASTER_CHECK_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_S = 15
const PROMPT_TIMEOUT_MS = 10 * 60_000
/** How long a control master lingers after its last session ends */
const CONTROL_PERSIST = "10m"

export function sshBinary() {
  return process.platform === "win32" ? "ssh.exe" : "ssh"
}

/**
 * Parses `[user@]host[:port]`. A trailing `:digits` is treated as a port;
 * bracketed IPv6 is left alone. Rejects anything that could smuggle ssh
 * options through the destination argument.
 */
export function parseSshTarget(input: string) {
  const value = input.trim()
  if (!value || value.startsWith("-") || /\s/.test(value)) return null
  const userMatch = /^([^@\s]+)@(.+)$/.exec(value)
  const user = userMatch ? userMatch[1] : null
  const rest = userMatch ? userMatch[2] : value
  // A second "@" or a non-numeric colon suffix is malformed input, not a host
  // (ssh destination syntax is exactly [user@]host).
  if (!rest || rest.startsWith("-") || rest.includes("@")) return null
  const portMatch = /^([^:\[\]]+):(\d{1,5})$/.exec(rest)
  if (!portMatch && rest.includes(":")) return null
  const host = portMatch ? portMatch[1] : rest
  const port = portMatch ? Number(portMatch[2]) : null
  if (!host || (port !== null && (port < 1 || port > 65535))) return null
  return { user, host, port }
}

export function sshDestination(target: Pick<SshTarget, "host" | "user">) {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/** Canonical `ssh:user@hostname:port` identity so `myalias` and `user@1.2.3.4` dedupe. */
export function sshTargetId(resolved: SshResolved) {
  return `ssh:${resolved.user}@${resolved.hostname}${resolved.port === 22 ? "" : `:${resolved.port}`}`
}

/**
 * Destination argument must come last: ssh treats anything after it as the
 * remote command. Control commands (-O) therefore can't reuse this list.
 */
function sshArgs(
  target: SshTarget,
  opts: {
    controlPath?: string
    batch?: boolean
    extra?: string[]
  } = {},
) {
  return [
    "-T",
    "-o",
    `BatchMode=${opts.batch === false ? "no" : "yes"}`,
    "-o",
    // Never silently accept a new host key: batch runs can't ask so they fail
    // fast and fall through to the pty path, where "ask" surfaces our host-key
    // confirmation dialog. Changed keys still hard-fail, as ssh intends.
    "StrictHostKeyChecking=ask",
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    ...(opts.controlPath ? ["-S", opts.controlPath] : []),
    ...(target.port ? ["-p", String(target.port)] : []),
    ...(target.identityFile ? ["-i", target.identityFile] : []),
    ...(opts.extra ?? []),
    sshDestination(target),
  ]
}

function controlArgs(controlPathValue: string, target: SshTarget, command: "check" | "exit") {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    "-S",
    controlPathValue,
    "-O",
    command,
    sshDestination(target),
  ]
}

function runSsh(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string | Buffer; signal?: AbortSignal } = {},
) {
  return new Promise<SshRunResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: opts.signal,
    })
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS
    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`ssh timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

// ssh prints these on stderr during perfectly healthy runs: it probes every
// configured IdentityFile and reports missing defaults, and notes host-key
// acceptance under accept-new. Neither is actionable for the user.
const SSH_OUTPUT_NOISE = /identity file .* not accessible|permanently added .+ to the list of known hosts/i

export function summarizeSshOutput(output: string) {
  return output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && !SSH_OUTPUT_NOISE.test(line))
    .slice(-6)
    .join(" ")
    .trim()
    .slice(0, 400)
}

function authFailure(result: SshRunResult) {
  return /permission denied|authentication failed|too many authentication failures|no authentication methods/i.test(
    result.stderr,
  )
}

/**
 * Detects an interactive ssh prompt at the end of recent pty output.
 * ssh prints prompts without a trailing newline, so only the tail matters.
 */
export function detectSshPrompt(tail: string): SshPromptRequest | null {
  const normalized = tail.replace(/\r/g, "")
  const lastLine = normalized.slice(normalized.lastIndexOf("\n") + 1)
  if (/\(yes\/no(?:\/\[fingerprint\])?\)\s*\??\s*$/.test(lastLine)) {
    const block = normalized
      .split("\n")
      .slice(-8)
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
    return { kind: "hostkey", message: block }
  }
  if (/passphrase[^:\n]*:\s*$/i.test(lastLine)) {
    return { kind: "passphrase", message: lastLine.trim() }
  }
  // keyboard-interactive 2FA (OTP, Duo, verification codes) and smartcard PINs
  // share the masked-input UX of a password prompt.
  if (/(password|verification code|one-time|otp|passcode|pin)[^:\n]*:\s*$/i.test(lastLine)) {
    return { kind: "password", message: lastLine.trim() }
  }
  return null
}

/**
 * Spawns ssh under a pty and services interactive prompts through
 * `onPrompt`. Resolves once ssh exits. The caller keeps the returned child
 * when the process is meant to keep running (the control master case).
 */
function spawnSshPty(
  binary: string,
  args: string[],
  opts: { onPrompt: SshPromptResponder; signal?: AbortSignal },
): { child: pty.IPty; done: Promise<SshRunResult & { cancelled: boolean }> } {
  const child = pty.spawn(binary, args, {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
    useConpty: true,
  })
  let output = ""
  let tail = ""
  let promptInFlight = false
  let cancelled = false
  const done = new Promise<SshRunResult & { cancelled: boolean }>((resolve) => {
    child.onExit((event: { exitCode: number }) =>
      resolve({ code: event.exitCode, stdout: output, stderr: "", cancelled }),
    )
  })
  const onAbort = () => {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  child.onData((data: string) => {
    output += data
    tail = (tail + data).slice(-4096)
    if (promptInFlight) return
    const prompt = detectSshPrompt(tail)
    if (!prompt) return
    promptInFlight = true
    void opts
      .onPrompt(prompt)
      .then((response) => {
        promptInFlight = false
        tail = ""
        if (response === null) {
          cancelled = true
          onAbort()
          return
        }
        // A pasted multi-line value would submit as several inputs; strip
        // line breaks so exactly one response goes to the prompt.
        child.write(response.replace(/[\r\n]+/g, "") + "\r")
      })
      .catch(() => {
        promptInFlight = false
        onAbort()
      })
  })
  return { child, done }
}

/**
 * Resolves the effective ssh config for a target (`ssh -G`), so `Host`
 * aliases, `User`, `Port`, `IdentityFile` and `ProxyJump` all behave the way
 * the user's ~/.ssh/config defines them.
 */
export async function resolveSshTarget(target: SshTarget, opts: { signal?: AbortSignal } = {}) {
  const result = await runSsh(sshBinary(), ["-G", sshDestination(target)], {
    timeoutMs: DEFAULT_SSH_TIMEOUT_MS,
    signal: opts.signal,
  })
  if (result.code !== 0) {
    throw new Error(summarizeSshOutput(result.stderr) || `Cannot resolve ssh config for ${sshDestination(target)}`)
  }
  const parsed = parseSshConfig(result.stdout)
  return {
    hostname: parsed.hostname ?? target.host,
    user: target.user ?? parsed.user ?? "unknown",
    port: target.port ?? parsed.port ?? 22,
    // Never adopt ssh -G's identityfile: it reports defaults like ~/.ssh/id_rsa
    // even when nothing is configured, and re-passing them via -i narrows the
    // auth set and spams "identity file not accessible" warnings. ssh resolves
    // configured IdentityFiles itself; we only honor an explicit user input.
    identityFile: target.identityFile,
  }
}

export function parseSshConfig(output: string) {
  const config: Record<string, string> = {}
  for (const line of output.split(/\r?\n/g)) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const key = match[1].toLowerCase()
    if (!(key in config)) config[key] = match[2].trim()
  }
  const port = config.port ? Number(config.port) : undefined
  return {
    hostname: config.hostname,
    user: config.user,
    port: port !== undefined && Number.isInteger(port) && port > 0 ? port : undefined,
    identityfile: config.identityfile?.replace(/^~/, process.env.HOME ?? "~"),
  }
}

// ControlMaster sockets live under a short per-user dir: sockaddr_un paths are
// capped at ~104 bytes on macOS, so nesting under the app's data directory
// overflows (unix_listener: path too long for Unix domain socket).
export function sshControlDir() {
  if (process.platform === "win32") return join(tmpdir(), "forge-ssh")
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user"
  return `/tmp/forge-ssh-${uid}`
}

export function controlPath(controlDir: string, target: SshTarget) {
  const hash = createHash("sha256")
    .update(`${target.user ?? ""}@${target.host}:${target.port ?? ""}`)
    .digest("hex")
    .slice(0, 24)
  return join(controlDir, `cm-${hash}`)
}

export type SshMaster = {
  /** The process holding the master alive; absent when the master outlived its spawner */
  child: ChildProcess | pty.IPty | null
  stop: () => void
}

async function masterAlive(binary: string, target: SshTarget, cp: string, signal?: AbortSignal) {
  const result = await runSsh(binary, controlArgs(cp, target, "check"), {
    timeoutMs: MASTER_CHECK_TIMEOUT_MS,
    signal,
  }).catch(() => ({ code: 1, stdout: "", stderr: "" }))
  return result.code === 0
}

/**
 * Establishes a persistent multiplexed ssh connection (`-M -S -N`). Once the
 * master is up every command and the tunnel multiplex over it without
 * re-authenticating, so an interactive password is only ever asked for once.
 */
// Concurrent ensureMaster calls for the same target (probe + connect overlap)
// would race two pty masters on one control socket. Serialize per socket path.
const masterLocks = new Map<string, Promise<unknown>>()

export async function ensureMaster(
  binary: string,
  controlDir: string,
  target: SshTarget,
  opts: {
    onPrompt: SshPromptResponder
    signal?: AbortSignal
    logger?: (message: string) => void
  },
): Promise<SshMaster> {
  await mkdir(controlDir, { recursive: true, mode: 0o700 })
  const cp = controlPath(controlDir, target)
  const pending = (masterLocks.get(cp) ?? Promise.resolve()).then(() =>
    acquireMaster(binary, cp, target, opts),
  )
  const stored = pending.catch(() => undefined)
  masterLocks.set(cp, stored)
  try {
    return await pending
  } finally {
    if (masterLocks.get(cp) === stored) masterLocks.delete(cp)
  }
}

async function acquireMaster(
  binary: string,
  cp: string,
  target: SshTarget,
  opts: {
    onPrompt: SshPromptResponder
    signal?: AbortSignal
    logger?: (message: string) => void
  },
): Promise<SshMaster> {
  if (await masterAlive(binary, target, cp, opts.signal)) return { child: null, stop: () => undefined }

  const masterArgs = (batch: boolean) => [
    "-M",
    "-o",
    `ControlPersist=${CONTROL_PERSIST}`,
    "-N",
    ...sshArgs(target, { controlPath: cp, batch }),
  ]

  // Key/agent auth: prove it works first, then no pty is needed at all.
  const batch = await runSsh(binary, [...sshArgs(target, { batch: true }), "true"], {
    timeoutMs: (CONNECT_TIMEOUT_S + 5) * 1000,
    signal: opts.signal,
  }).catch((error) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))

  if (batch.code === 0) {
    opts.logger?.("ssh batch auth ok; establishing control master")
    const child = spawn(binary, masterArgs(true), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4096)))
    const deadline = Date.now() + CONNECT_TIMEOUT_S * 1000
    while (Date.now() < deadline) {
      if (await masterAlive(binary, target, cp, opts.signal)) {
        return {
          child,
          stop: () => {
            try {
              child.kill()
            } catch {
              /* ignore */
            }
          },
        }
      }
      if (child.exitCode !== null || child.killed) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    throw new Error(summarizeSshOutput(stderr) || "ssh control master failed to establish")
  }

  if (!authFailure(batch) && batch.code !== 255) {
    throw new Error(summarizeSshOutput(batch.stderr) || `Cannot reach ${sshDestination(target)} over ssh`)
  }

  // Interactive auth: hold the master on a pty and service prompts.
  opts.logger?.("ssh requires interactive auth; starting prompt-capable master")
  const { child, done } = spawnSshPty(binary, masterArgs(false), {
    onPrompt: opts.onPrompt,
    signal: opts.signal,
  })
  let exited = false
  void done.then(() => (exited = true))
  const deadline = Date.now() + PROMPT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await masterAlive(binary, target, cp)) {
      return {
        child,
        stop: () => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
        },
      }
    }
    if (exited) {
      // A user-cancelled prompt must surface as AbortError so callers do not
      // auto-retry into another prompt.
      if ((await done).cancelled) throw new DOMException("Aborted", "AbortError")
      throw new Error("SSH authentication failed (permission denied or connection closed)")
    }
    if (opts.signal?.aborted) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      throw new DOMException("Aborted", "AbortError")
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  throw new Error("ssh authentication timed out")
}

export async function closeMaster(binary: string, controlDir: string, target: SshTarget, signal?: AbortSignal) {
  await runSsh(binary, controlArgs(controlPath(controlDir, target), target, "exit"), {
    timeoutMs: MASTER_CHECK_TIMEOUT_MS,
    signal,
  }).catch(() => undefined)
}

export async function checkSshRuntime(opts: { signal?: AbortSignal } = {}) {
  const result = await runSsh(sshBinary(), ["-V"], {
    timeoutMs: MASTER_CHECK_TIMEOUT_MS,
    signal: opts.signal,
  }).catch((error) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
  if (result.code !== 0) {
    return {
      available: false,
      version: null,
      error: summarizeSshOutput(result.stderr || result.stdout) || "ssh is not available on this machine",
    }
  }
  return { available: true, version: summarizeSshOutput(result.stderr || result.stdout), error: null }
}

/**
 * Runs a remote command over the established control master. The string is
 * executed by the remote login shell (`sshd` runs `$SHELL -c`), so plain
 * POSIX syntax is safe.
 */
export async function runRemote(
  binary: string,
  controlDir: string,
  target: SshTarget,
  remote: string,
  opts: { timeoutMs?: number; input?: string | Buffer; signal?: AbortSignal } = {},
) {
  const cp = controlPath(controlDir, target)
  const result = await runSsh(binary, [...sshArgs(target, { controlPath: cp }), remote], opts)
  if (result.code !== 0) {
    throw new Error(summarizeSshOutput(result.stderr || result.stdout) || `Remote command failed on ${sshDestination(target)}`)
  }
  return result
}

const REMOTE_PROBE_SCRIPT = [
  'printf "FORGE_PROBE platform=%s\\n" "$(uname -sm 2>/dev/null | tr " " "-")"',
  'command -v bash >/dev/null 2>&1 && printf "FORGE_PROBE bash=1\\n"',
  'command -v curl >/dev/null 2>&1 && printf "FORGE_PROBE curl=1\\n"',
  'forge_path=""; if [ -x "$HOME/.forge/bin/forge" ]; then forge_path="$HOME/.forge/bin/forge"; elif command -v forge >/dev/null 2>&1; then forge_path="$(command -v forge)"; fi',
  'if [ -n "$forge_path" ]; then printf "FORGE_PROBE forge_path=%s\\n" "$forge_path"; printf "FORGE_PROBE forge_version=%s\\n" "$("$forge_path" --version 2>/dev/null || true)"; fi',
].join("; ")

export function parseRemoteProbe(output: string) {
  const fields: Record<string, string> = {}
  for (const line of output.split(/\r?\n/g)) {
    // MOTD and profile output can contain key=value text; only our marker counts.
    const match = /^FORGE_PROBE ([a-z_]+)=(.*)$/.exec(line.trim())
    if (match) fields[match[1]] = match[2]
  }
  return {
    platform: fields.platform || null,
    hasBash: fields.bash === "1",
    hasCurl: fields.curl === "1",
    forgePath: fields.forge_path || null,
    forgeVersion: fields.forge_version || null,
  }
}

export async function probeRemote(
  binary: string,
  controlDir: string,
  target: SshTarget,
  opts: { signal?: AbortSignal } = {},
) {
  const result = await runRemote(binary, controlDir, target, REMOTE_PROBE_SCRIPT, {
    timeoutMs: DEFAULT_SSH_TIMEOUT_MS,
    signal: opts.signal,
  })
  return parseRemoteProbe(result.stdout)
}

/** Maps `uname -sm` output to the release target the install script uses. */
export function remotePlatformTarget(platform: string | null) {
  if (!platform) return null
  const [os, arch] = platform.toLowerCase().split("-")
  const osName = os === "darwin" ? "darwin" : os === "linux" ? "linux" : null
  const archName = arch === "x86_64" || arch === "amd64" ? "x64" : arch === "arm64" || arch === "aarch64" ? "arm64" : null
  if (!osName || !archName) return null
  return `${osName}-${archName}`
}

export function localPlatformTarget() {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x64"
  return `${process.platform}-${arch}`
}

/** Writes a file on the remote via `cat` over the master connection. */
export async function writeRemoteFile(
  binary: string,
  controlDir: string,
  target: SshTarget,
  path: string,
  content: string | Buffer,
  mode: number,
  opts: { signal?: AbortSignal } = {},
) {
  const dir = path.slice(0, path.lastIndexOf("/"))
  await runRemote(
    binary,
    controlDir,
    target,
    `mkdir -p "${dir}" && cat > "${path}.tmp" && chmod ${mode.toString(8)} "${path}.tmp" && mv "${path}.tmp" "${path}"`,
    { input: content, signal: opts.signal },
  )
}

/**
 * Installs forge on the remote via the shim's own `install` subcommand, which
 * downloads the public release asset + checksums directly. Self-contained -
 * the remote never depends on the published install script being current.
 * The shim is refreshed by writeRemoteFile before this is ever invoked.
 */
export async function installRemoteForge(
  binary: string,
  controlDir: string,
  target: SshTarget,
  version: string,
  opts: { signal?: AbortSignal } = {},
) {
  await runRemote(
    binary,
    controlDir,
    target,
    `sh ${FORGE_REMOTE_SHIM_PATH} install '${version.replace(/'/g, `'\\''`)}'`,
    { timeoutMs: 10 * 60_000, signal: opts.signal },
  )
}

/** Same-arch fallback: stream a local forge binary to `~/.forge/bin/forge`. */
export async function streamForgeBinary(
  binary: string,
  controlDir: string,
  target: SshTarget,
  binaryContent: Buffer,
  opts: { signal?: AbortSignal } = {},
) {
  await writeRemoteFile(binary, controlDir, target, "$HOME/.forge/bin/forge", binaryContent, 0o755, opts)
}

export type SshTunnel = {
  child: ChildProcess
  localPort: number
  stderrTail: () => string
  stop: () => void
  onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
}

/** Opens the local forward over the master: `ssh -S cp -L 127.0.0.1:L:127.0.0.1:R`. */
export function spawnTunnel(
  binary: string,
  controlDir: string,
  target: SshTarget,
  localPort: number,
  remotePort: number,
  opts: { onLine?: (text: string) => void; signal?: AbortSignal } = {},
): SshTunnel {
  const cp = controlPath(controlDir, target)
  const spec = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`
  const child = spawn(
    binary,
    [
      ...sshArgs(target, { controlPath: cp }),
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "TCPKeepAlive=yes",
      "-L",
      spec,
      // A multiplexed "-N" session exits immediately - there is no command
      // channel to hold. Hold one open with a remote sleep so this child's
      // exit still signals a dropped connection.
      "while :; do sleep 86400; done",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  )
  let stderr = ""
  const collect = (chunk: Buffer) => {
    const text = (stderr + chunk.toString("utf8")).slice(-4096)
    stderr = text
    text
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => opts.onLine?.(line))
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const onAbort = () => {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  child.once("exit", () => {
    opts.signal?.removeEventListener("abort", onAbort)
    // Forwards registered through the mux persist on the master even after the
    // session that created them ends - release the listener explicitly or the
    // local port stays bound (and the next connect cannot re-register it).
    try {
      spawn(binary, ["-o", "BatchMode=yes", "-S", cp, "-O", "cancel", "-L", spec, sshDestination(target)], {
        stdio: "ignore",
        windowsHide: true,
      }).unref()
    } catch {
      /* master may already be gone */
    }
  })
  return {
    child,
    localPort,
    stderrTail: () => stderr,
    stop: onAbort,
    onExit: (cb) => child.once("exit", cb),
  }
}
