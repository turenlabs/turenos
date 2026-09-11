import type { SshForgeCheck, SshHostProbe, SshServerConfig } from "../../preload/types"
import { sshTargetId, type SshResolved, type SshTarget } from "./runtime"

export function sshServerConfig(
  target: SshTarget,
  resolved: SshResolved,
  displayName: string | null,
): SshServerConfig {
  return {
    id: sshTargetId(resolved),
    host: target.host,
    user: resolved.user || target.user,
    hostname: resolved.hostname,
    port: resolved.port === 22 ? null : resolved.port,
    identityFile: target.identityFile ?? resolved.identityFile ?? null,
    displayName,
  }
}

export function targetForConfig(config: SshServerConfig): SshTarget {
  return {
    host: config.host,
    user: config.user,
    port: config.port,
    identityFile: config.identityFile,
  }
}

export function sshServerIdToRestart(servers: { config: SshServerConfig }[], id: string) {
  return servers.find((item) => item.config.id === id)?.config.id
}

export function clearSshHostState(
  probes: Record<string, SshHostProbe>,
  forgeChecks: Record<string, SshForgeCheck>,
  id: string,
) {
  const nextProbes = { ...probes }
  const nextForgeChecks = { ...forgeChecks }
  delete nextProbes[id]
  delete nextForgeChecks[id]
  return { probes: nextProbes, forgeChecks: nextForgeChecks }
}

export function requireSshIpcString(name: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Invalid ${name}`)
}

export function requireSshIpcTarget(value: unknown): {
  host: string
  port: number | null
  identityFile: string | null
  displayName: string | null
} {
  if (!value || typeof value !== "object") throw new Error("Invalid ssh target")
  const input = value as Record<string, unknown>
  const host = requireSshIpcString("host", input.host)
  const port = input.port === null || input.port === undefined ? null : Number(input.port)
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid port")
  return {
    host,
    port,
    identityFile: typeof input.identityFile === "string" && input.identityFile ? input.identityFile : null,
    displayName: typeof input.displayName === "string" && input.displayName ? input.displayName : null,
  }
}
