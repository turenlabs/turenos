import { lobbyAgentKillSignal } from "./lobby-agent-controller"

const KILL_SWITCH_TIMEOUT_MS = 10_000

export type KillSwitchSessionClient = {
  interruptAll: (options?: { signal?: AbortSignal }) => Promise<{
    data?: { data?: { interrupted: number; failed: number } }
  }>
}

export class KillSwitchError extends Error {
  constructor(
    readonly interrupted: number,
    readonly failedServers: number,
    readonly failedRoots: number,
  ) {
    super(
      interrupted > 0
        ? `Stopped ${interrupted} active agent roots, but ${failedRoots} roots and ${failedServers} servers did not complete the request.`
        : `${failedRoots} roots and ${failedServers} servers did not complete the kill switch request.`,
    )
    this.name = "KillSwitchError"
  }
}

export async function killRunningAgents(clients: readonly KillSwitchSessionClient[]) {
  lobbyAgentKillSignal.trip()
  const results = await Promise.allSettled(clients.map(interruptAll))
  const interrupted = results.reduce(
    (total, result) => total + (result.status === "fulfilled" ? result.value.interrupted : 0),
    0,
  )
  const failedRoots = results.reduce(
    (total, result) => total + (result.status === "fulfilled" ? result.value.failed : 0),
    0,
  )
  const failedServers = results.filter((result) => result.status === "rejected").length
  if (failedServers > 0 || failedRoots > 0) throw new KillSwitchError(interrupted, failedServers, failedRoots)
  return interrupted
}

async function interruptAll(client: KillSwitchSessionClient) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      client.interruptAll({ signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("Kill switch request timed out"))
        }, KILL_SWITCH_TIMEOUT_MS)
      }),
    ])
    const result = response.data?.data
    if (typeof result?.interrupted !== "number" || typeof result.failed !== "number")
      throw new Error("Kill switch response did not include interruption counts")
    return result
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
