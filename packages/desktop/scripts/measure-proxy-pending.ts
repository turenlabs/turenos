import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(process.argv[2] ?? ".")
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim()
const candidate = existsSync(`${root}/src/main/sidecar-proxy.ts`)
const rounds = 6
const batch = 32
const payloadBytes = 65536
let report!: (value: Record<string, number>) => void
const child = Bun.spawn(
  [
    process.execPath,
    "-e",
    `
  let commands = [];
  setTimeout(() => process.exit(0), 5_000).unref();
  process.on("message", (message) => {
    if (message.type === "security-proxy-command") { commands.push(message); return; }
    if (message.type === "clear") commands = [];
    process.send({pid:process.pid,ppid:process.ppid,retainedCommands:commands.length,...process.memoryUsage()});
  });
`,
  ],
  {
    stdout: "ignore",
    stderr: "ignore",
    ipc: (value) => {
      report(value)
    },
  },
)
const remote = (type: string) =>
  new Promise<Record<string, number>>((resolve) => {
    report = resolve
    child.send({ type })
  })
const sent = new Set<string>()
const send = (message: { id: string }) => {
  sent.add(message.id)
  child.send(message)
}
const proxy = await (async () => {
  if (candidate) {
    const { createSidecarProxy } = await import(`${root}/src/main/sidecar-proxy.ts`)
    return createSidecarProxy(send)
  }
  const source = await Bun.file(`${root}/src/main/sidecar.ts`).text()
  const begin = source.indexOf("function requestSecurityProxy(")
  const end = source.indexOf("function armStartupDiagnostics", begin)
  if (begin < 0 || end < 0) throw new Error("Inspected baseline function not found")
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(begin, end))
  return new Function(
    "randomUUID",
    "notifyParent",
    `
    const proxyPending = new Map();
    ${code}
    return {request:requestSecurityProxy, stop:()=>{
      for(const item of proxyPending.values()){clearTimeout(item.timer);item.reject(new Error("fixture stopped"))}
      proxyPending.clear();
    }};
  `,
  )(randomUUID, send)
})()
const started = performance.now()
let rejected = 0
let peakRss = 0
const sample = async (phase: string, round: number, latencyMs = 0) => {
  const childMemory = await remote("report")
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
    rounds,
    batch,
    concurrency: batch * round,
    syntheticPayloadBytes: payloadBytes,
    schemaValidationIncluded: false,
    elapsedMs: performance.now() - started,
    latencyMs,
    pendingCommands: phase === "cleanup" || phase === "idle" ? 0 : sent.size,
    rejected,
    ...memory,
    child: childMemory,
    nativeAllocationBytes: null,
  }
  console.log(JSON.stringify(row))
  return row
}
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 5)
const first = await sample("warmup", 0)
const requests: Promise<unknown>[] = []
try {
  for (let round = 1; round <= rounds; round++) {
    const begin = performance.now()
    Array.from({ length: batch }, () => {
      requests.push(
        proxy.request({ type: "list", owner: { directory: "x".repeat(payloadBytes) } }).catch(() => {
          rejected++
        }),
      )
    })
    await Bun.sleep(20)
    await sample("stalled", round, performance.now() - begin)
  }
  const cleanup = performance.now()
  proxy.stop()
  await Promise.all(requests)
  await remote("clear")
  const cleanupMs = performance.now() - cleanup
  await sample("cleanup", rounds, cleanupMs)
  await Bun.sleep(150)
  const final = await sample("idle", rounds)
  console.log(
    JSON.stringify({
      utc: new Date().toISOString(),
      phase: "summary",
      head,
      candidate,
      bun: Bun.version,
      pid: process.pid,
      childPid: child.pid,
      rounds,
      batch,
      offeredRequests: rounds * batch,
      sentRequests: sent.size,
      rejected,
      pendingAfterCleanup: 0,
      cleanupMs,
      peakSampledRssBytes: peakRss,
      retainedRssBytes: final.rss,
      retainedHeapBytes: final.heapUsed,
      retainedExternalBytes: final.external,
      endpointRssSlopeBytesPerSecond: (final.rss - first.rss) / ((final.elapsedMs - first.elapsedMs) / 1000),
      elapsedMs: final.elapsedMs,
      child: final.child,
      nativeAllocationBytes: null,
    }),
  )
  if (candidate && sent.size !== 32) throw new Error("Admission bound failed")
} finally {
  proxy.stop()
  clearInterval(sampler)
  child.kill()
  await child.exited
}
