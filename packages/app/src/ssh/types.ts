export type SshTargetInput = {
  /** [user@]host as typed, including ~/.ssh/config aliases */
  host: string
  port?: number | null
  identityFile?: string | null
  displayName?: string | null
}

export type SshServerConfig = {
  /** Canonical `ssh:user@hostname:port` identity, resolved via `ssh -G` */
  id: string
  /** Target as typed - passed to ssh so config aliases resolve naturally */
  host: string
  user: string | null
  hostname: string | null
  port: number | null
  identityFile: string | null
  displayName: string | null
}

export type SshHostProbe = {
  host: string
  /** ssh client binary is present on this machine */
  sshAvailable: boolean
  /** BatchMode (key/agent) auth succeeded without a prompt */
  batchAuth: boolean
  platform: string | null
  hasBash: boolean
  forgePath: string | null
  forgeVersion: string | null
  error: string | null
}

export type SshForgeCheck = {
  host: string
  resolvedPath: string | null
  version: string | null
  expectedVersion: string | null
  matchesDesktop: boolean | null
  error: string | null
}

export type SshServerRuntime =
  | { kind: "starting" }
  | { kind: "ready"; url: string; username: string | null; password: string | null }
  | { kind: "failed"; message: string }
  | { kind: "stopped" }

export type SshServerItem = {
  config: SshServerConfig
  runtime: SshServerRuntime
}

export type SshPromptKind = "password" | "passphrase" | "hostkey" | "confirm"

export type SshPrompt = {
  /** Correlates the response back to the pending ssh invocation */
  requestId: string
  /** Server id (or pending host) the prompt belongs to */
  target: string
  kind: SshPromptKind
  /** The literal prompt text ssh printed (includes fingerprint for hostkey) */
  message: string
}

export type SshJob =
  | { kind: "probe"; host: string; startedAt: number }
  | { kind: "install-forge"; id: string; startedAt: number }

export type SshRuntimeCheck = {
  available: boolean
  version: string | null
  error: string | null
}

export type SshServersState = {
  runtime: SshRuntimeCheck | null
  servers: SshServerItem[]
  probes: Record<string, SshHostProbe>
  forgeChecks: Record<string, SshForgeCheck>
  prompt: SshPrompt | null
  job: SshJob | null
}

export type SshServersEvent = { type: "state"; state: SshServersState }

export type SshServersPlatform = {
  getState(): Promise<SshServersState>
  subscribe(cb: (event: SshServersEvent) => void): () => void
  probeRuntime(): Promise<void>
  probeHost(input: SshTargetInput): Promise<void>
  installForge(id: string): Promise<void>
  addServer(input: SshTargetInput): Promise<SshServerConfig>
  removeServer(id: string): Promise<void>
  startServer(id: string): Promise<void>
  /** Stop the daemonized forge server on the remote (connection may be re-added later) */
  stopRemote(id: string): Promise<void>
  /** Answer the pending interactive ssh prompt; null cancels */
  respondPrompt(requestId: string, response: string | null): Promise<void>
}
