/** How often the watchdog re-reads our parent pid. */
const ORPHAN_POLL_MS = 2_000

export type OrphanWatch = {
  /** Resolves with a human-readable reason once the process that forked us is gone. */
  readonly orphaned: Promise<string>
  readonly stop: () => void
}

export type OrphanWatchOptions = {
  ppid?: () => number
  intervalMs?: number
  platform?: string
}

/**
 * Resolve once the process that forked us is gone.
 *
 * The sidecar exits on Bun's cross-platform IPC `disconnect` event when its
 * parent goes away. This PPID poll is the Unix backstop in case that channel
 * signal is missed, because a surviving sidecar is
 * expensive: it holds the HTTP port, keeps writing to the databases the next
 * launch will open, and its own children (MCP servers, LSPs, ptys) stay
 * legitimately parented to it, so the `ppid === 1` sweep that reaps stranded MCP
 * servers never sees them.
 *
 * The signal is `process.ppid` becoming 1: POSIX reparents orphans to init. We
 * only trust it once the pid has actually *changed* from what we started under,
 * so a process legitimately launched by pid 1 is never mistaken for an orphan.
 *
 * No heartbeat is needed: the IPC channel reports parent disconnection on
 * every supported platform, and the PPID check only covers Unix as backup.
 */
export function watchOrphaned(options?: OrphanWatchOptions): OrphanWatch {
  const readParent = options?.ppid ?? (() => process.ppid)
  const platform = options?.platform ?? process.platform
  const startedUnder = readParent()
  let stop = () => {}
  const orphaned = new Promise<string>((resolve) => {
    if (platform === "win32") return
    const timer = setInterval(() => {
      const current = readParent()
      if (current !== 1 || current === startedUnder) return
      resolve(`parent ${startedUnder} exited`)
    }, options?.intervalMs ?? ORPHAN_POLL_MS)
    // Never hold the process open on the watchdog's account.
    timer.unref?.()
    stop = () => clearInterval(timer)
  })
  return { orphaned, stop: () => stop() }
}
