import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const source = resolve(process.argv[2] ?? ".")
const { pollSshHealth } = await import(pathToFileURL(resolve(source, "src/main/ssh/startup.ts")).href)
const { pollWslHealth } = await import(pathToFileURL(resolve(source, "src/main/wsl/startup.ts")).href)

// Synthetic requests retain fixed-size buffers until completion or cancellation.
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: source }).trim()
const started = performance.now()
const concurrency = 32
const rounds = 6
const payloadBytes = 64 * 1024
const requestMs = 1000
let active = 0
let peakActive = 0
let peakRssBytes = 0
const retained: { at: number; rss: number }[] = []
const sample = (phase: string, extra = {}) => {
  const memory = process.memoryUsage()
  peakRssBytes = Math.max(peakRssBytes, memory.rss)
  console.log(
    JSON.stringify({
      utc: new Date().toISOString(),
      head,
      bun: Bun.version,
      pid: process.pid,
      ppid: process.ppid,
      phase,
      concurrency,
      rounds,
      payloadBytes,
      requestMs,
      active,
      peakActive,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBufferBytes: memory.arrayBuffers,
      peakRssBytes,
      elapsedMs: performance.now() - started,
      ...extra,
    }),
  )
}
const sampling = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
}, 5)
sample("start")
for (let round = 0; round < rounds; round++) {
  const roundStarted = performance.now()
  const controllers = Array.from({ length: concurrency }, () => new AbortController())
  const work = controllers.map((controller, index) => {
    const poll = index % 2 ? pollSshHealth : pollWslHealth
    return poll(
      (signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          const payload = Buffer.alloc(payloadBytes, 1)
          active++
          peakActive = Math.max(peakActive, active)
          const done = () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", done)
            active--
            resolve(payload[0] === 0)
          }
          const timer = setTimeout(done, requestMs)
          signal?.addEventListener("abort", done, { once: true })
        }),
      controller.signal,
      1,
    )
  })
  await Bun.sleep(5)
  const cancelled = performance.now()
  controllers.forEach((controller) => controller.abort())
  await Bun.sleep(10)
  sample("post-cancel", { round, cancellationMs: performance.now() - cancelled })
  await Promise.all(work)
  sample("cleanup", { round, cancellationMs: performance.now() - cancelled })
  // Keep baseline and candidate wall time equal so idle samples are comparable.
  await Bun.sleep(Math.max(20, requestMs + 25 - (performance.now() - roundStarted)))
  retained.push({ at: performance.now(), rss: process.memoryUsage().rss })
  sample("idle", { round })
}
clearInterval(sampling)
const first = retained[0]!
const last = retained.at(-1)!
sample("summary", {
  retainedRssBytes: last.rss,
  retainedRssSlopeBytesPerSecond: (last.rss - first.rss) / ((last.at - first.at) / 1000),
  gc: "natural",
  nativeAllocationBytes: null,
})
