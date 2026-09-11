export function sshServerIdsToStartOnInitialize(servers: { id: string }[]) {
  return servers.map((server) => server.id)
}

export function expectSshForgeVersion(installed: string | null, expected: string, host: string) {
  if (installed === expected) return
  throw new Error(
    `TurenOS update finished but ${host} still reports ${installed ?? "no version"}; expected ${expected}`,
  )
}

/**
 * Bounded auto-reconnect backoff for a dropped tunnel. Stretches past a
 * minute so a laptop sleep/wake (network down longer than a few seconds)
 * still recovers without user action.
 */
export function sshReconnectDelays() {
  return [1_000, 3_000, 10_000, 30_000, 60_000, 60_000]
}

export async function pollSshHealth(check: () => Promise<boolean>, signal: AbortSignal, interval = 100) {
  while (!signal.aborted) {
    if (await check()) return
    await abortableDelay(interval, signal)
  }
}

function abortableDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timeout = setTimeout(done, duration)
    signal.addEventListener("abort", done, { once: true })
  })
}
