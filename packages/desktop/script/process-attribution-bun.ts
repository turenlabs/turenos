const held: Buffer[] = [Buffer.alloc(4 * 1024 * 1024, 7)]
const sample = (phase: string) =>
  console.log(
    JSON.stringify({
      utc: new Date().toISOString(),
      role: "bun-fixture",
      pid: process.pid,
      parentPid: process.ppid,
      runtime: Bun.version,
      phase,
      ...process.memoryUsage(),
      nativeAllocationBytes: null,
    }),
  )
sample("allocated")
const timer = setInterval(() => sample("idle"), 500)
setTimeout(() => process.exit(1), 80000).unref()
for await (const chunk of Bun.stdin.stream()) {
  if (new TextDecoder().decode(chunk).includes("stop")) {
    held.length = 0
    clearInterval(timer)
    sample("released")
    process.exit(0)
  }
}
