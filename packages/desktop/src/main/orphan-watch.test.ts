import { describe, expect, test } from "bun:test"

import { watchOrphaned } from "./orphan-watch"

describe("watchOrphaned", () => {
  test("resolves once the parent pid changes to init", async () => {
    let ppid = 4242
    const watch = watchOrphaned({ ppid: () => ppid, intervalMs: 5, platform: "darwin" })
    ppid = 1
    await expect(watch.orphaned).resolves.toBe("parent 4242 exited")
    watch.stop()
  })

  test("never fires while the parent is still ours", async () => {
    const watch = watchOrphaned({ ppid: () => 4242, intervalMs: 5, platform: "darwin" })
    const result = await Promise.race([watch.orphaned, delay(60).then(() => "pending")])
    expect(result).toBe("pending")
    watch.stop()
  })

  test("does not mistake a process legitimately started by init for an orphan", async () => {
    const watch = watchOrphaned({ ppid: () => 1, intervalMs: 5, platform: "darwin" })
    const result = await Promise.race([watch.orphaned, delay(60).then(() => "pending")])
    expect(result).toBe("pending")
    watch.stop()
  })

  test("stays quiet on windows, where orphans are not reparented", async () => {
    let ppid = 4242
    const watch = watchOrphaned({ ppid: () => ppid, intervalMs: 5, platform: "win32" })
    ppid = 1
    const result = await Promise.race([watch.orphaned, delay(60).then(() => "pending")])
    expect(result).toBe("pending")
    watch.stop()
  })

  test("stop() halts the poll", async () => {
    let reads = 0
    let ppid = 4242
    const watch = watchOrphaned({
      ppid: () => {
        reads += 1
        return ppid
      },
      intervalMs: 5,
      platform: "darwin",
    })
    await delay(30)
    watch.stop()
    const seen = reads
    ppid = 1
    await delay(30)
    expect(reads).toBe(seen)
  })
})

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
