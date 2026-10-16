import { pollHealth } from "../health"

export const pollWslHealth = pollHealth

export function wslServerIdsToStartOnInitialize(servers: { id: string }[]) {
  return servers.map((server) => server.id)
}

export function expectForgeVersion(installed: string | null, expected: string, distro = "Debian") {
  if (installed === expected) return
  throw new Error(
    `TurenOS update finished but ${distro} still reports ${installed ?? "no version"}; expected ${expected}`,
  )
}

export const pendingRestartAfterWslInstall = (runtime: { available: boolean }) => !runtime.available
