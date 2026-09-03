import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { Schema } from "effect"
import { Global } from "@turenlabs/core/global"
import { Scanner } from "@/security/util/scanner"
import { Process } from "@/util/process"

const QUALIFICATION_REVISION = 1
const QUALIFICATION_TTL = 24 * 60 * 60_000
const COMMAND_TIMEOUT = 5_000
const COMMAND_OUTPUT_LIMIT = 64 * 1024
const CONTAINER_LABEL = "io.turenlabs.mcp-runtime=1"

export const Backend = Schema.Literals(["docker", "local", "qemu"])
export type Backend = typeof Backend.Type

export const SelectableBackend = Schema.Literals(["docker", "local"])
export type SelectableBackend = typeof SelectableBackend.Type

export const LocalProcess = Schema.Struct({ enabled: Schema.Boolean }).annotate({
  identifier: "McpRuntimeLocalProcess",
})
export type LocalProcess = typeof LocalProcess.Type

export const Settings = Schema.Struct({
  version: Schema.Literal(1),
  backend: SelectableBackend,
  localProcess: LocalProcess,
}).annotate({ identifier: "McpRuntimeSettings" })
export type Settings = typeof Settings.Type

export const SettingsInput = Schema.Struct({ backend: SelectableBackend }).annotate({
  identifier: "McpRuntimeSettingsInput",
})
export type SettingsInput = typeof SettingsInput.Type

export const QualificationStatus = Schema.Literals(["unqualified", "qualified", "unavailable", "failed"])

export const DockerQualification = Schema.Struct({
  status: QualificationStatus,
  checkedAt: Schema.Finite,
  expiresAt: Schema.optional(Schema.Finite),
  revision: Schema.Finite,
  executable: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  capabilities: Schema.Array(Schema.String),
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "McpRuntimeDockerQualification" })
export type DockerQualification = typeof DockerQualification.Type

export const BackendStatus = Schema.Struct({
  backend: Backend,
  selected: Schema.Boolean,
  selectable: Schema.Boolean,
  status: Schema.Literals(["available", "unqualified", "qualified", "unavailable", "failed"]),
  version: Schema.optional(Schema.String),
  capabilities: Schema.Array(Schema.String),
  networkPosture: Schema.String,
  detail: Schema.optional(Schema.String),
  checkedAt: Schema.optional(Schema.Finite),
  revision: Schema.optional(Schema.Finite),
}).annotate({ identifier: "McpRuntimeBackendStatus" })
export type BackendStatus = typeof BackendStatus.Type

export const Status = Schema.Struct({
  settings: Settings,
  backends: Schema.Array(BackendStatus),
}).annotate({ identifier: "McpRuntimeStatus" })
export type Status = typeof Status.Type

const SecretBinding = Schema.Struct({
  name: Schema.String,
  secret: Schema.String,
})

export const DockerServer = Schema.Struct({
  backend: Schema.Literal("docker"),
  image: Schema.String,
  command: Schema.Array(Schema.String),
  secrets: Schema.Array(SecretBinding),
  outboundHosts: Schema.Array(Schema.String),
}).annotate({ identifier: "McpRuntimeDockerServer" })
export type DockerServer = typeof DockerServer.Type

export const LocalServer = Schema.Struct({
  backend: Schema.Literal("local"),
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  secrets: Schema.Array(SecretBinding),
}).annotate({ identifier: "McpRuntimeLocalServer" })
export type LocalServer = typeof LocalServer.Type

export const PackageServer = Schema.Struct({
  backend: Schema.Literal("package"),
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  secrets: Schema.Array(SecretBinding),
  environment: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "McpRuntimePackageServer" })
export type PackageServer = typeof PackageServer.Type

export const Server = Schema.Union([DockerServer, LocalServer, PackageServer])
  .pipe(Schema.toTaggedUnion("backend"))
  .annotate({ identifier: "McpRuntimeServer" })
export type Server = typeof Server.Type

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  backend: "docker",
  localProcess: { enabled: false },
}

export const DEFAULT_DOCKER_QUALIFICATION: DockerQualification = {
  status: "unqualified",
  checkedAt: 0,
  revision: QUALIFICATION_REVISION,
  capabilities: [],
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandRunner {
  readonly run: (command: string, args: readonly string[], timeout: number) => Promise<CommandResult>
}

export interface ResolvedServer {
  readonly command: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly generation: number
  readonly containerName?: string
}

export interface Container {
  readonly executable: string
  readonly name: string
}

export interface ResolveInput {
  readonly server: Server
  readonly settings: Settings
  readonly docker: DockerQualification
  readonly directory: string
  readonly secrets: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly generation?: number
}

export const commandRunner: CommandRunner = {
  async run(command, args, timeout) {
    const controller = new AbortController()
    const child = Process.spawn([command, ...args], {
      env: null,
      stdout: "pipe",
      stderr: "pipe",
      abort: controller.signal,
      timeout: 1_000,
    })
    if (!child.stdout || !child.stderr) throw new Error("Docker command output is unavailable")
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        boundedText(child.stdout),
        boundedText(child.stderr),
      ])
      if (timedOut) throw new Error("Docker command timed out")
      return { exitCode, stdout, stderr }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  },
}

let generation = 0
const activeConnections = new Set<() => Promise<void>>()

export function currentGeneration() {
  return generation
}

export function registerConnection(connectionGeneration: number, close: () => Promise<void>) {
  if (connectionGeneration !== generation) return undefined
  activeConnections.add(close)
  return () => activeConnections.delete(close)
}

export async function invalidateActiveConnections() {
  generation += 1
  const active = [...activeConnections]
  activeConnections.clear()
  await Promise.allSettled(active.map((close) => close()))
  return active.length
}

export async function destroyContainer(container: Container, runner: CommandRunner = commandRunner) {
  await runner.run(container.executable, ["rm", "--force", container.name], COMMAND_TIMEOUT).catch(() => undefined)
}

/** Parse Docker's JSON format without exposing untrusted command output. */
export function parseDockerVersion(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== "object" || parsed === null || !("Version" in parsed)) return undefined
    const version = parsed.Version
    return typeof version === "string" && version.trim() ? version.trim() : undefined
  } catch {
    return undefined
  }
}

export function redactDiagnostic(value: string, secrets: readonly (string | undefined)[] = []) {
  return secrets
    .filter((secret): secret is string => Boolean(secret))
    .toSorted((left, right) => right.length - left.length)
    .reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
    .replace(
      /((?:password|secret|token|credential|private.?key|api.?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

export function redactErrorDiagnostic(error: unknown, secrets: readonly (string | undefined)[] = []) {
  const seen = new Set<unknown>()
  const messages: string[] = []
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "object" && "message" in current && typeof current.message === "string"
          ? current.message
          : typeof current === "string"
            ? current
            : ""
    if (message && !message.startsWith("An error occurred in Effect.")) messages.push(message)
    if (typeof current !== "object" || !("cause" in current)) break
    current = current.cause
  }
  return redactDiagnostic(messages.at(-1) ?? "", secrets)
}

export function redactValue(value: unknown, secrets: readonly (string | undefined)[] = []): unknown {
  if (typeof value === "string") return redactDiagnostic(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]))
}

/**
 * This verifies a running daemon plus the flags used by the launch contract.
 * It deliberately does not pull or run an arbitrary probe image.
 */
export async function qualifyDocker(
  input: {
    readonly runner?: CommandRunner
    readonly executable?: string
    readonly now?: () => number
  } = {},
): Promise<DockerQualification> {
  const now = input.now ?? Date.now
  const executable = input.executable ?? (await Scanner.which("docker"))
  if (!executable) {
    return {
      ...DEFAULT_DOCKER_QUALIFICATION,
      status: "unavailable",
      checkedAt: now(),
      detail: "Docker CLI was not found. Install Docker Desktop or Docker Engine, then test again.",
    }
  }

  const resolved = await fs.realpath(executable).catch(() => undefined)
  if (!resolved || !path.isAbsolute(resolved)) {
    return {
      ...DEFAULT_DOCKER_QUALIFICATION,
      status: "unavailable",
      checkedAt: now(),
      detail: "Docker CLI could not be resolved to an absolute executable.",
    }
  }

  const runner = input.runner ?? commandRunner
  try {
    const client = await runner.run(resolved, ["version", "--format", "{{json .Client}}"], COMMAND_TIMEOUT)
    if (client.exitCode !== 0) return qualificationFailure(now(), "Docker client", client)
    const clientVersion = parseDockerVersion(client.stdout)
    if (!clientVersion) return qualificationFailure(now(), "Docker client returned an invalid version", client)

    const server = await runner.run(resolved, ["version", "--format", "{{json .Server}}"], COMMAND_TIMEOUT)
    if (server.exitCode !== 0) return qualificationFailure(now(), "Docker daemon", server)
    const serverVersion = parseDockerVersion(server.stdout)
    if (!serverVersion) return qualificationFailure(now(), "Docker daemon returned an invalid version", server)

    const help = await runner.run(resolved, ["run", "--help"], COMMAND_TIMEOUT)
    if (help.exitCode !== 0) return qualificationFailure(now(), "Docker run capability probe", help)
    const required = [
      "--network",
      "--read-only",
      "--cap-drop",
      "--security-opt",
      "--pids-limit",
      "--memory",
      "--cpus",
      "--user",
      "--tmpfs",
      "--interactive",
    ]
    const missing = required.filter((flag) => !help.stdout.includes(flag))
    if (missing.length > 0) {
      return {
        ...DEFAULT_DOCKER_QUALIFICATION,
        status: "failed",
        checkedAt: now(),
        executable: resolved,
        version: serverVersion,
        detail: `Docker is missing required hardened run flags: ${missing.join(", ")}.`,
      }
    }

    const checkedAt = now()
    return {
      status: "qualified",
      checkedAt,
      expiresAt: checkedAt + QUALIFICATION_TTL,
      revision: QUALIFICATION_REVISION,
      executable: resolved,
      version: `${clientVersion} / daemon ${serverVersion}`,
      capabilities: [
        "daemon",
        "network-none",
        "read-only-rootfs",
        "cap-drop",
        "no-new-privileges",
        "resource-limits",
        "non-root",
        "stdio",
      ],
      detail:
        "Docker daemon and CLI hardened launch flags were verified. No image execution probe was run; approved images are still required.",
    }
  } catch (error) {
    return {
      ...DEFAULT_DOCKER_QUALIFICATION,
      status: "failed",
      checkedAt: now(),
      detail: redactErrorDiagnostic(error) || "Docker qualification failed.",
    }
  }
}

export function status(settings: Settings, docker: DockerQualification, now = Date.now()): Status {
  const current = currentDockerQualification(docker, now)
  return {
    settings,
    backends: [
      {
        backend: "docker",
        selected: settings.backend === "docker",
        selectable: true,
        status: current.status,
        ...(current.version ? { version: current.version } : {}),
        capabilities: current.capabilities,
        networkPosture:
          "No host network, mounts, Docker socket, or inherited host environment. Provider egress is denied until a dedicated allowlist proxy exists.",
        ...(current.detail ? { detail: current.detail } : {}),
        checkedAt: current.checkedAt,
        revision: current.revision,
      },
      {
        backend: "local",
        selected: settings.backend === "local",
        selectable: true,
        status: "available",
        capabilities: ["argv-only", "restricted-environment", "project-cwd", "timeout-cleanup"],
        networkPosture:
          "Trusted local-user responsibility. Only an explicitly approved absolute executable can run; no host environment is inherited.",
        detail: settings.localProcess.enabled
          ? "Local process runtime is explicitly enabled. Each executable is validated again before launch."
          : "Disabled until you explicitly select Local process.",
      },
      {
        backend: "qemu",
        selected: false,
        selectable: false,
        status: "unavailable",
        capabilities: [],
        networkPosture: "MCP service containers use the configured brokered network policy.",
        detail:
          "Preview only. A dedicated MCP VM service runtime needs authenticated host-guest RPC, service lifecycle, readiness, cancellation, scoped network policy, credential isolation, and reconciliation.",
      },
    ],
  }
}

export function currentDockerQualification(value: DockerQualification, now = Date.now()): DockerQualification {
  if (value.status !== "qualified") return value
  if (value.expiresAt !== undefined && value.expiresAt > now) return value
  return {
    ...value,
    status: "unqualified",
    detail: "Docker qualification expired. Test the runtime again before starting a managed server.",
  }
}

const selfHosted = Symbol("forge.mcp-runtime-self-hosted")
type AttachedRuntime = {
  readonly server: Server
  readonly secrets: Readonly<Record<string, string | undefined>>
}
export type SelfHostedEntry<T extends object> = T & { readonly [selfHosted]: AttachedRuntime }

/** Only audited runtime code can attach this non-serializable launch policy. */
export function attach<T extends object>(
  entry: T,
  server: Server,
  secrets: Readonly<Record<string, string | undefined>> = {},
): SelfHostedEntry<T> {
  return { ...entry, [selfHosted]: { server, secrets } }
}

export function serverFor(entry: object): Server | undefined {
  return selfHosted in entry ? (entry as SelfHostedEntry<object>)[selfHosted].server : undefined
}

export function secretsFor(entry: object): Readonly<Record<string, string | undefined>> {
  return selfHosted in entry ? (entry as SelfHostedEntry<object>)[selfHosted].secrets : {}
}

export async function resolve(input: ResolveInput): Promise<ResolvedServer> {
  if (input.server.backend !== "package" && input.settings.backend !== input.server.backend) {
    throw new Error(`MCP runtime is configured for ${input.settings.backend}, not ${input.server.backend}.`)
  }
  if (input.server.backend === "docker") return resolveDocker(input)
  return resolveLocal(input)
}

export async function reconcileDocker(
  qualification: DockerQualification,
  runner: CommandRunner = commandRunner,
): Promise<readonly string[]> {
  const current = currentDockerQualification(qualification)
  if (current.status !== "qualified" || !current.executable) return []
  const listed = await runner.run(
    current.executable,
    ["ps", "--all", "--filter", `label=${CONTAINER_LABEL}`, "--format", "{{.ID}}"],
    COMMAND_TIMEOUT,
  )
  if (listed.exitCode !== 0) return []
  const ids = listed.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => /^[a-f0-9]{12,64}$/i.test(value))
  await Promise.all(ids.map((id) => runner.run(current.executable!, ["rm", "--force", id], COMMAND_TIMEOUT)))
  return ids
}

function qualificationFailure(checkedAt: number, label: string, result: CommandResult): DockerQualification {
  const output = redactDiagnostic(result.stderr || result.stdout)
  const remediation =
    label === "Docker daemon" ? " Start Docker Desktop or Docker Engine, then test the runtime again." : ""
  return {
    ...DEFAULT_DOCKER_QUALIFICATION,
    status: "failed",
    checkedAt,
    detail: `${label} failed${output ? `: ${output}` : ` (exit ${result.exitCode})`}.${remediation}`,
  }
}

function resolveDocker(input: ResolveInput): ResolvedServer {
  if (!("image" in input.server)) throw new Error("Docker MCP runtime received a non-Docker server policy.")
  const server = input.server
  const qualification = currentDockerQualification(input.docker)
  if (qualification.status !== "qualified" || !qualification.executable) {
    throw new Error("Docker runtime is not qualified. Test the runtime before starting a managed server.")
  }
  if (!pinnedImage(server.image)) throw new Error("Managed Docker MCP images must be pinned by sha256 digest.")
  if (!safeArguments(server.command)) throw new Error("Managed Docker MCP command contains an unsafe argument.")
  if (server.outboundHosts.length > 0) {
    throw new Error(
      "Provider egress allowlisting is not implemented yet; Docker MCP servers must declare no outbound hosts.",
    )
  }
  const environment = resolveSecrets(server.secrets, input.secrets)
  const containerName = `turen-mcp-${crypto.randomUUID()}`
  return {
    command: [
      qualification.executable,
      "run",
      "--rm",
      "--init",
      "--interactive",
      "--name",
      containerName,
      "--label",
      CONTAINER_LABEL,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--user",
      "65532:65532",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      ...server.secrets.flatMap((binding) => ["--env", binding.name]),
      server.image,
      ...server.command,
    ],
    cwd: input.directory,
    environment,
    generation: input.generation ?? generation,
    containerName,
  }
}

async function resolveLocal(input: ResolveInput): Promise<ResolvedServer> {
  if (!("executable" in input.server)) throw new Error("Local MCP runtime received a non-local server policy.")
  const server = input.server
  if (server.backend !== "package" && !input.settings.localProcess.enabled) {
    throw new Error(
      "Local process runtime is disabled. Explicitly select Local process before starting a managed server.",
    )
  }
  if (
    !path.isAbsolute(server.executable) ||
    !safeArguments(server.args) ||
    shellExecutable(server.executable) ||
    (pythonInterpreter(server.executable) && server.args[0] !== "-m")
  ) {
    throw new Error("Local MCP runtime requires a safe absolute executable and fixed argv array.")
  }
  const executable = await fs.realpath(server.executable).catch(() => undefined)
  const metadata = executable ? await fs.stat(executable).catch(() => undefined) : undefined
  if (
    !executable ||
    !metadata ||
    !metadata.isFile() ||
    !trustedLocalExecutablePath(executable, input.home ?? os.homedir())
  ) {
    throw new Error("Local MCP executable is outside the trusted local runtime roots.")
  }
  if ((metadata.mode & 0o022) !== 0 || (metadata.uid !== 0 && metadata.uid !== process.getuid?.())) {
    throw new Error("Local MCP executable must be owned by root or the current user and not group/world writable.")
  }
  return {
    command: [executable, ...(pythonInterpreter(executable) ? ["-I", ...server.args] : server.args)],
    cwd: input.directory,
    environment: {
      ...(server.backend === "package" ? server.environment : {}),
      ...resolveSecrets(server.secrets, input.secrets),
    },
    generation: input.generation ?? generation,
  }
}

function resolveSecrets(
  bindings: readonly { name: string; secret: string }[],
  values: Readonly<Record<string, string | undefined>>,
) {
  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length) {
    throw new Error("MCP runtime secret environment names must be unique.")
  }
  return Object.fromEntries(
    bindings.map((binding) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(binding.name) || !/^[A-Z][A-Z0-9_]*$/.test(binding.secret)) {
        throw new Error("MCP runtime secret bindings must use uppercase environment names.")
      }
      const value = values[binding.secret]
      if (!value) throw new Error(`Required MCP runtime secret ${binding.secret} is unavailable.`)
      return [binding.name, value]
    }),
  )
}

function pinnedImage(value: string) {
  return /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value)
}

function safeArguments(values: readonly string[]) {
  return (
    values.length > 0 &&
    values.every((value) => value.length > 0 && value.length <= 4_096 && !value.includes("\0")) &&
    !values.some((value) => ["-c", "--command", "--eval", "-e", "/c"].includes(value))
  )
}

function shellExecutable(value: string) {
  return new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"]).has(
    path.basename(value).toLowerCase(),
  )
}

function pythonInterpreter(value: string) {
  return /^python(?:\d(?:\.\d+)?)?$/.test(path.basename(value).toLowerCase())
}

function localExecutableRoots(home: string) {
  return [
    "/usr/bin",
    "/usr/local/bin",
    "/usr/local/Cellar",
    "/opt/homebrew/bin",
    "/opt/homebrew/Cellar",
    Global.Path.bin,
    path.join(home, ".local/bin"),
  ]
}

export function trustedLocalExecutablePath(filename: string, home = os.homedir()) {
  return localExecutableRoots(home).some((root) => filename.startsWith(root + path.sep))
}

async function boundedText(stream: Readable) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (size >= COMMAND_OUTPUT_LIMIT) continue
    const bounded = chunk.subarray(0, COMMAND_OUTPUT_LIMIT - size)
    chunks.push(bounded)
    size += bounded.length
  }
  return Buffer.concat(chunks, size).toString("utf8")
}

export * as McpRuntime from "./runtime"
