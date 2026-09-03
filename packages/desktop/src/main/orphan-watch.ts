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
 * The sidecar exists only to serve the Electron main process. Every teardown
 * path it has - the `stop` command, `child.kill()`, `child-process-gone` - needs
 * the parent to still be running to drive it, so none of them survive a SIGKILL
 * of main. Chromium does normally terminate a `utilityProcess` when the browser
 * process dies, from its IO thread, so this fires almost never; it is the
 * backstop for when that does not happen, because a surviving sidecar is
 * expensive: it holds the HTTP port, keeps writing to the databases the next
 * launch will open, and its own children (MCP servers, LSPs, ptys) stay
 * legitimately parented to it, so the `ppid === 1` sweep that reaps stranded MCP
 * servers never sees them.
 *
 * The signal is `process.ppid` becoming 1: POSIX reparents orphans to init. We
 * only trust it once the pid has actually *changed* from what we started under,
 * so a process legitimately launched by pid 1 is never mistaken for an orphan.
 *
 * We deliberately do not use a parent heartbeat as a second signal. Unlike the
 * stdio MCP children there is no pipe to watch - Electron rejects any `stdin`
 * mode other than `ignore` for a utility process, and `process.parentPort`
 * exposes no close/disconnect event - so a heartbeat would have to be a timeout
 * on parent silence. That trades a hang we have never observed for a real
 * false-positive: a suspended laptop or a paused main process would look
 * identical to a dead one and would kill a healthy sidecar holding user data.
 * On Windows, where there is no reparenting to observe, Chromium's job object
 * already tears the child down with the browser process.
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
