import path from "path"
import { chmodSync, closeSync, openSync, rmSync } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import { getHeapSpaceStatistics, getHeapStatistics, writeHeapSnapshot } from "node:v8"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Layer, Logger, ManagedRuntime, References } from "effect"
import { Flag } from "@turenlabs/core/flag/flag"
import { Global } from "@turenlabs/core/global"
import { Logging } from "@turenlabs/core/observability/logging"

const MINUTE = 60_000
const MB = 1024 ** 2
// Fractions of the real heap_size_limit, in percent. The limit differs per runtime (Electron's pointer-compressed
// V8 caps the sidecar at 4 GB whatever --max-old-space-size says, Bun reports its own), so nothing here is absolute.
const LEVELS = [60, 75, 90]
// A level re-arms once usage drops this many points below it.
const REARM = 5
// Below this limit (Bun reports a small one) the fractions are meaningless, so the watchdog never triggers.
const FLOOR = 1024 ** 3
const SNAPSHOT_LEVEL = 90
const SNAPSHOT_KEEP_MS = 7 * 24 * 60 * MINUTE
// A file touched this recently may still be mid-write.
const SNAPSHOT_GUARD_MS = 10 * MINUTE
const SNAPSHOT = /^(heap-|Heap\.).+\.heapsnapshot$/

let timer: Timer | undefined
let lock = false
let announced = false
let fired: number[] = []

function percent(stat: { used_heap_size: number; heap_size_limit: number }) {
  return (stat.used_heap_size / stat.heap_size_limit) * 100
}

// The highest level the sample has reached, or undefined below the first level or when the limit is unusable.
export function level(stat: { used_heap_size: number; heap_size_limit: number }) {
  if (stat.heap_size_limit < FLOOR) return undefined
  return LEVELS.findLast((item) => percent(stat) >= item)
}

export function nearLimit(stat: { used_heap_size: number; heap_size_limit: number }) {
  return level(stat) === SNAPSHOT_LEVEL
}

// Reports a level only on its first crossing. Crossing several at once reports the highest and disarms the lower
// ones too, and a level re-arms only after usage falls REARM points below it.
export function advance(
  armed: readonly number[],
  stat: { used_heap_size: number; heap_size_limit: number },
): { fired: number[]; level: number | undefined } {
  if (stat.heap_size_limit < FLOOR) return { fired: [], level: undefined }
  const reached = LEVELS.filter((item) => percent(stat) >= item)
  const kept = armed.filter((item) => percent(stat) >= item - REARM)
  const top = reached.findLast((item) => !kept.includes(item))
  return { fired: [...new Set([...kept, ...reached])], level: top }
}

// Pre-creates the file with mode 0600: a snapshot holds key material, passwords and prompts. The final chmod covers
// a runtime that replaces the file instead of writing into it.
export function writeSnapshot(file: string) {
  closeSync(openSync(file, "wx", 0o600))
  try {
    writeHeapSnapshot(file)
  } catch (error) {
    rmSync(file, { force: true })
    throw error
  }
  chmodSync(file, 0o600)
}

// Under Bun the watchdog above works from a "limit" the runtime reports (a few gigabytes, and different from run to
// run), but JavaScriptCore has no cap, so a fraction of that figure says little, and the watchdog writes to standard
// error, which is not always kept. These are absolute sizes of the JS heap (objects plus string and array-buffer
// memory) written to `forge.log`, and the first thing wanted when one is crossed is what the heap is made of, not a
// snapshot.
const MEMORY_LEVELS = [1, 2, 3, 4, 6, 8].map((gigabytes) => gigabytes * 1024 ** 3)
const MEMORY_REARM = 256 * MB
const TOP_TYPES = 8
const TOP_TYPES_AT_LEVEL = 20

// The highest absolute level crossed. Like `advance`, a level re-arms only after usage falls MEMORY_REARM below it,
// and crossing several at once reports the highest.
export function advanceMemory(armed: readonly number[], bytes: number): { fired: number[]; level: number | undefined } {
  const reached = MEMORY_LEVELS.filter((item) => bytes >= item)
  const kept = armed.filter((item) => bytes >= item - MEMORY_REARM)
  const top = reached.findLast((item) => !kept.includes(item))
  return { fired: [...new Set([...kept, ...reached])], level: top === undefined ? undefined : top / 1024 ** 3 }
}

// The largest object types and how much each grew since the previous sample, as `Type=count` and `Type +delta` lists.
// Counts are of objects, not bytes, but a type whose count climbs sample after sample is the one that is leaking.
export function describeTypes(
  counts: Readonly<Record<string, number>>,
  previous: Readonly<Record<string, number>> | undefined,
  limit = TOP_TYPES,
) {
  const entries = Object.entries(counts).toSorted((a, b) => b[1] - a[1])
  const grew = previous
    ? entries
        .map(([name, count]) => [name, count - (previous[name] ?? 0)] as const)
        .filter(([, delta]) => delta > 0)
        .toSorted((a, b) => b[1] - a[1])
    : []
  return {
    top: entries
      .slice(0, limit)
      .map(([name, count]) => `${name}=${count}`)
      .join(" "),
    grew: grew
      .slice(0, limit)
      .map(([name, delta]) => `${name} +${delta}`)
      .join(" "),
  }
}

// One shared logger for the life of the process. `forge.log` is written through an Effect logger, which the plain
// timers in this module have no access to, so the layer is built once and each sample logs through it.
const runtime = ManagedRuntime.make(
  Logger.layer([...Logging.loggers()], { mergeWithExisting: false }).pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.orDie,
    Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
  ),
)

type JscStats = {
  readonly heapSize: number
  readonly heapCapacity: number
  readonly extraMemorySize: number
  readonly objectCount: number
  readonly protectedObjectCount: number
  readonly objectTypeCounts: Readonly<Record<string, number>>
}

let memoryTimer: Timer | undefined
let memoryArmed: number[] = []
let memoryPrevious: Readonly<Record<string, number>> | undefined

// Samples JavaScriptCore every minute: cheap (a few milliseconds even on a multi-gigabyte heap) and always on, so a
// slow climb is visible in `forge.log` long before it matters. Logs an info line each time and a warning with the
// full type list when the heap crosses an absolute level.
function startMemorySampler() {
  if (memoryTimer) return
  void import("bun:jsc").then(({ heapStats, memoryUsage }) => {
    const run = () => {
      const stats: JscStats = heapStats()
      // The allocator's own view. JavaScriptCore drops a value from its accounting the moment it is collected, but the
      // allocator keeps the pages for tens of seconds before returning them, so under allocation churn resident size
      // runs well above `heapMB` + `extraMB`. `nativeMB` is what is actually held; the gap to JS is what is lingering.
      const native = memoryUsage()
      const heap = stats.heapSize + stats.extraMemorySize
      const next = advanceMemory(memoryArmed, heap)
      memoryArmed = next.fired
      const types = describeTypes(stats.objectTypeCounts, memoryPrevious)
      memoryPrevious = stats.objectTypeCounts
      const fields = {
        rssMB: Math.round(process.memoryUsage().rss / MB),
        nativeMB: Math.round(native.current / MB),
        nativePeakMB: Math.round(native.peak / MB),
        heapMB: Math.round(stats.heapSize / MB),
        extraMB: Math.round(stats.extraMemorySize / MB),
        objects: stats.objectCount,
        protectedObjects: stats.protectedObjectCount,
        top: types.top,
        grew: types.grew,
      }
      void runtime.runPromise(
        next.level === undefined
          ? Effect.logInfo("Backend memory", fields)
          : Effect.logWarning("Backend memory level crossed", {
              ...fields,
              levelGB: next.level,
              top: describeTypes(stats.objectTypeCounts, undefined, TOP_TYPES_AT_LEVEL).top,
            }),
      )
    }
    run()
    memoryTimer = setInterval(run, MINUTE)
    memoryTimer.unref?.()
  })
}

// A missing file or directory is expected (a concurrent prune, a fresh install); anything else would leave sensitive
// snapshots in place, so it is reported. Pruning stays non-fatal either way.
function ignoreMissing(action: string, target: string) {
  return (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    process.stderr.write(
      `heap watchdog: ${action} failed for ${target}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

// Keeps only the newest snapshot, and only while it is younger than a week. Files modified in the last 10 minutes
// are left alone. Runs once at startup.
export async function prune(dir: string, now = Date.now()) {
  const files = await readdir(dir).catch((error) => {
    ignoreMissing("listing", dir)(error)
    return []
  })
  const found = await Promise.all(
    files
      .filter((name) => SNAPSHOT.test(name))
      .map((name) => {
        const file = path.join(dir, name)
        return stat(file)
          .then((info) => ({ file, time: info.mtimeMs }))
          .catch((error) => {
            ignoreMissing("stat", file)(error)
          })
      }),
  )
  await Promise.all(
    found
      .filter((item) => item !== undefined)
      .toSorted((a, b) => b.time - a.time)
      .filter((item, index) => (index > 0 || now - item.time > SNAPSHOT_KEEP_MS) && now - item.time > SNAPSHOT_GUARD_MS)
      .map((item) => rm(item.file, { force: true }).catch(ignoreMissing("removing", item.file))),
  )
}

// Always logs; only the 90% level writes a snapshot, and only when FORGE_AUTO_HEAP_SNAPSHOT opts in. Serializing a
// heap that is at its limit can itself run out of memory, so the snapshot is best-effort. `announce` is for the
// server path: the CLI shares this function and its stderr is the user's terminal.
export function start(options?: { announce?: boolean }) {
  if (options?.announce && !announced) {
    announced = true
    process.stderr.write(`heap watchdog: limit=${Math.round(getHeapStatistics().heap_size_limit / MB)}\n`)
  }
  // Only the long-running server samples. A CLI command would be held open by the timer for no benefit.
  if (options?.announce && process.versions.bun) startMemorySampler()
  if (timer) return

  void prune(Global.Path.log)

  const run = async () => {
    const stats = getHeapStatistics()
    const next = advance(fired, stats)
    fired = next.fired
    if (next.level === undefined) return

    const memory = process.memoryUsage()
    const spaces = Object.fromEntries(getHeapSpaceStatistics().map((item) => [item.space_name, item.space_used_size]))
    process.stderr.write(
      `heap watchdog: level=${next.level} used=${Math.round(stats.used_heap_size / MB)} total=${Math.round(stats.total_heap_size / MB)} limit=${Math.round(stats.heap_size_limit / MB)} rss=${Math.round(memory.rss / MB)} external=${Math.round(memory.external / MB)} arrayBuffers=${Math.round(memory.arrayBuffers / MB)} old_space=${Math.round((spaces.old_space ?? 0) / MB)} new_space=${Math.round((spaces.new_space ?? 0) / MB)} large_object_space=${Math.round((spaces.large_object_space ?? 0) / MB)} code_space=${Math.round((spaces.code_space ?? 0) / MB)}\n`,
    )
    if (next.level !== SNAPSHOT_LEVEL || !Flag.FORGE_AUTO_HEAP_SNAPSHOT || lock) return

    lock = true
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    process.stderr.write(`heap watchdog: writing snapshot ${file}\n`)
    await Promise.resolve()
      .then(() => writeSnapshot(file))
      .catch((error) => {
        process.stderr.write(
          `heap watchdog: snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      })
    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
