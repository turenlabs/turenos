import { resolve } from "node:path"
import { existsSync } from "node:fs"

const root = resolve(process.argv[2] ?? ".")
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim()
const candidate = existsSync(`${root}/src/main/sidecar-supervisor.ts`)
const source = candidate ? "" : await Bun.file(`${root}/src/main/index.ts`).text()
const begin = source.indexOf("    const SIDECAR_RESPAWN_LIMIT")
const end = source.indexOf("    // `Effect.promise`", begin)
if (!candidate && (begin < 0 || end < 0)) throw new Error("Inspected baseline callback not found")
const block = candidate ? "" : new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(begin, end))
const create = candidate ? (await import(`${root}/src/main/sidecar-supervisor.ts`)).createSidecarSupervisor : undefined
const concurrency = 8
const rounds = 6
const children = new Set<ReturnType<typeof Bun.spawn>>()
const childMeasurements: unknown[] = []
const childCompletions: Promise<unknown>[] = []
let spawnedAfterStop = 0
let adoptedAfterStop = 0
let peakRss = 0
const started = performance.now()
const sample = (phase: string, round: number) => {
  const memory = process.memoryUsage()
  peakRss = Math.max(peakRss, memory.rss)
  const row = {
    utc: new Date().toISOString(),
    head,
    candidate,
    bun: Bun.version,
    pid: process.pid,
    ppid: process.ppid,
    phase,
    round,
    concurrency,
    rounds,
    syntheticInitialListener: true,
    schedulerDelayMs: 20,
    childLifetimeMs: 150,
    childBufferBytes: 65536,
    elapsedMs: performance.now() - started,
    activeChildren: children.size,
    spawnedAfterStop,
    adoptedAfterStop,
    ...memory,
    nativeAllocationBytes: null,
  }
  console.log(JSON.stringify(row))
  return row
}
const spawn = async () => {
  spawnedAfterStop++
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const bytes=Buffer.alloc(65536,7);console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,...process.memoryUsage(),nativeAllocationBytes:null}));setTimeout(()=>{if(bytes[0]!==7)throw Error("buffer")},150)',
    ],
    { stdout: "pipe", stderr: "ignore" },
  )
  children.add(child)
  childCompletions.push(
    (async () => {
      const text = await new Response(child.stdout).text()
      if (text.trim()) childMeasurements.push(JSON.parse(text))
      await child.exited
      children.delete(child)
    })(),
  )
  return {
    listener: {
      stop: async () => {
        child.kill()
        await child.exited
      },
    },
  }
}
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 5)
const first = sample("warmup", 0)
for (let round = 1; round <= rounds; round++) {
  const roundStarted = performance.now()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      if (create) {
        let exit!: (code: number) => void
        let initial = true
        let stopped = false
        const supervisor = create({
          spawn: async (onExit: (code: number) => void) => {
            exit = onExit
            if (!initial) return spawn()
            initial = false
            return { listener: { stop: async () => {} } }
          },
          ready: () => {
            if (stopped) adoptedAfterStop++
          },
          exited: () => {},
          respawning: () => {},
          exhausted: () => {},
          failed: () => {},
          delayMs: 20,
        })
        await supervisor.start()
        exit(0)
        stopped = true
        supervisor.stop()
        return
      }
      const fixture = new Function(
        "spawnLocalServer",
        "setTimeout",
        `
      let stopped = false, server = { stop: async () => {} };
      const app = { getPath: () => "scratch" }, credentialVault = {};
      const hostname = "127.0.0.1", port = 0, password = "synthetic";
      const writeLog = () => {}, disconnectSecurityProxy = async () => {}, invokeSecurityProxy = async () => {};
      const boundTeardownStep = (_name, task) => task;
      ${block}
      return { exit: handleSidecarExit, stop: () => { stopped = true; server = null }, owned: () => stopped && Boolean(server) };
    `,
      )(spawn, (callback: () => void) => setTimeout(callback, 20))
      fixture.exit(0)
      fixture.stop()
      await Bun.sleep(40)
      if (fixture.owned()) adoptedAfterStop++
    }),
  )
  await Bun.sleep(candidate ? 40 : 0)
  sample("post-shutdown", round)
  await Promise.all(childCompletions)
  sample("cleanup", round)
  await Bun.sleep(Math.max(0, 225 - (performance.now() - roundStarted)))
}
await Bun.sleep(100)
clearInterval(sampler)
const final = sample("idle", rounds)
console.log(
  JSON.stringify({
    utc: new Date().toISOString(),
    phase: "summary",
    head,
    candidate,
    bun: Bun.version,
    pid: process.pid,
    concurrency,
    rounds,
    spawnedAfterStop,
    adoptedAfterStop,
    activeChildren: children.size,
    peakSampledRssBytes: peakRss,
    retainedRssBytes: final.rss,
    retainedHeapBytes: final.heapUsed,
    retainedExternalBytes: final.external,
    endpointRssSlopeBytesPerSecond: (final.rss - first.rss) / ((final.elapsedMs - first.elapsedMs) / 1000),
    elapsedMs: final.elapsedMs,
    childMeasurements,
    nativeAllocationBytes: null,
  }),
)
if (children.size || (candidate && (spawnedAfterStop || adoptedAfterStop))) throw new Error("Shutdown ownership failed")
