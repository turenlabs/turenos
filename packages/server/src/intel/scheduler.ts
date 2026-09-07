import { Effect } from "effect"
import { POLL_INTERVAL_MS } from "./sources"
import type { FetchFn } from "./sources"
import { defaultFetch } from "./sources"
import { pollOnce, readCache } from "./ingest"

export const isStale = (lastPollAt: number | undefined, now: number): boolean => {
  if (lastPollAt === undefined) return true
  return now - lastPollAt >= POLL_INTERVAL_MS
}

// On-boot freshness check: the status row (cache file) is the source of truth,
// never an in-memory timer. Call once at startup; the tick below only polls
// when the stored row is stale.
export const ensureFreshOnBoot = (
  fetchFn: FetchFn = defaultFetch,
  now: number = Date.now(),
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const cache = yield* readCache()
    if (!isStale(cache.lastPollAt, now)) return false
    yield* pollOnce(fetchFn, now)
    return true
  }).pipe(Effect.catch(() => Effect.succeed(false)))

// Process-wide overlap guard: the cache file is read-modify-write, so two
// overlapping polls (slow poll vs. tick, or two schedulers in one process)
// would clobber each other. Skipped ticks simply wait for the next interval.
let pollInFlight = false

const tickOnce = async (fetchFn: FetchFn, now: number): Promise<void> => {
  if (pollInFlight) return
  pollInFlight = true
  try {
    await Effect.runPromise(ensureFreshOnBoot(fetchFn, now))
  } catch {
    // ensureFreshOnBoot already reports failure as false; unreachable.
  } finally {
    pollInFlight = false
  }
}

// Manual refresh. Same overlap guard as the tick, but forced: staleness
// gates the advisory schedule, never a user asking for fresh intel now.
export const pollNow = (fetchFn: FetchFn = defaultFetch, now: number = Date.now()): Promise<void> => {
  if (pollInFlight) return Promise.resolve()
  pollInFlight = true
  return Effect.runPromise(pollOnce(fetchFn, now).pipe(Effect.asVoid)).finally(() => {
    pollInFlight = false
  })
}

// 6h advisory tick. The interval only wakes us up; staleness of the stored
// row decides whether a poll happens, so restarts never double-poll.
export const startScheduler = (
  fetchFn: FetchFn = defaultFetch,
  now: () => number = Date.now,
): { readonly stop: () => void } => {
  void tickOnce(fetchFn, now())
  const timer = setInterval(() => {
    void tickOnce(fetchFn, now())
  }, POLL_INTERVAL_MS)
  if (typeof timer.unref === "function") timer.unref()
  return { stop: () => clearInterval(timer) }
}
