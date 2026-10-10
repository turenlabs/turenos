import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { getHeapStatistics } from "node:v8"
import { Heap } from "../../src/cli/heap"
import { tmpdir } from "../fixture/fixture"

const GB = 1024 ** 3
const DAY = 24 * 60 * 60 * 1000
// Electron's pointer-compressed V8 reports 4096 MB for the desktop sidecar whatever flags it is forked with.
const limit = 4096 * 1024 ** 2

function sample(used: number) {
  return { used_heap_size: used, heap_size_limit: limit }
}

// Regression: the watchdog was snapshot-only, tuned to an 8 GB ceiling the sidecar never had, and logged nothing
// while the heap climbed to the real 4 GB limit.
describe("cli.heap", () => {
  test("level reports the highest crossed fraction of the real limit", () => {
    expect(Heap.level(sample(2.3 * GB))).toBeUndefined()
    expect(Heap.level(sample(2.6 * GB))).toBe(60)
    expect(Heap.level(sample(3.1 * GB))).toBe(75)
    expect(Heap.level(sample(3.7 * GB))).toBe(90)
  })

  test("runtimes reporting no or a small heap limit never trigger", () => {
    expect(Heap.level({ used_heap_size: 64 * GB, heap_size_limit: 0 })).toBeUndefined()
    expect(Heap.level({ used_heap_size: 0.95 * GB, heap_size_limit: 1 * GB - 1 })).toBeUndefined()
    expect(Heap.nearLimit({ used_heap_size: 64 * GB, heap_size_limit: 0 })).toBe(false)
  })

  test("nearLimit follows the 90% level", () => {
    expect(Heap.nearLimit(sample(3.5 * GB))).toBe(false)
    expect(Heap.nearLimit(sample(3.7 * GB))).toBe(true)
  })

  test("the live process is comfortably below the ceiling", () => {
    expect(Heap.nearLimit(getHeapStatistics())).toBe(false)
  })

  test("a level is reported once while usage hovers above it and again after it re-arms", () => {
    const reports = [2.5, 2.6, 2.5, 2.4, 2.5, 2.1, 2.5, 2.6].reduce(
      (acc, gb) => {
        const next = Heap.advance(acc.fired, sample(gb * GB))
        return { fired: next.fired, levels: [...acc.levels, next.level] }
      },
      { fired: [] as number[], levels: [] as (number | undefined)[] },
    )
    // 2.4 GB is still within 5 points of 60%, so only the drop to 2.1 GB re-arms it.
    expect(reports.levels).toEqual([60, undefined, undefined, undefined, undefined, undefined, 60, undefined])
  })

  test("jumping several levels reports only the highest", () => {
    const first = Heap.advance([], sample(3.7 * GB))
    expect(first.level).toBe(90)
    expect(Heap.advance(first.fired, sample(3.1 * GB)).level).toBeUndefined()
  })

  test("prune keeps only the newest recent snapshot and leaves other files alone", async () => {
    await using tmp = await tmpdir()
    const now = Date.now()
    const files = [
      ["heap-1-a.heapsnapshot", now - 2 * DAY],
      ["Heap.2-b.heapsnapshot", now - 1 * DAY],
      ["heap-3-c.heapsnapshot", now - 8 * DAY],
      ["heap-4-d.heapsnapshot", now - 60_000],
      ["server.log", now - 30 * DAY],
    ] as const
    await Promise.all(
      files.map(async ([name, time]) => {
        await Bun.write(path.join(tmp.path, name), name)
        await fs.utimes(path.join(tmp.path, name), time / 1000, time / 1000)
      }),
    )

    await Heap.prune(tmp.path, now)

    // The 60 s old file is guarded and is also the newest; the older ones go.
    expect((await fs.readdir(tmp.path)).toSorted()).toEqual(["heap-4-d.heapsnapshot", "server.log"])
  })

  test("prune removes a single snapshot older than a week", async () => {
    await using tmp = await tmpdir()
    const now = Date.now()
    await Bun.write(path.join(tmp.path, "heap-1-a.heapsnapshot"), "x")
    await fs.utimes(path.join(tmp.path, "heap-1-a.heapsnapshot"), (now - 8 * DAY) / 1000, (now - 8 * DAY) / 1000)

    await Heap.prune(tmp.path, now)

    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("prune stays silent for a missing directory", async () => {
    await using tmp = await tmpdir()
    const write = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await Heap.prune(path.join(tmp.path, "missing"))
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  test("prune reports a failure other than a missing path and does not throw", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "not-a-directory")
    await Bun.write(file, "x")
    const write = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await Heap.prune(file)
      expect(write).toHaveBeenCalledTimes(1)
      expect(String(write.mock.calls[0]?.[0])).toContain("heap watchdog: listing failed")
    } finally {
      write.mockRestore()
    }
  })

  test.skipIf(process.platform === "win32")("a failed snapshot write leaves no file behind", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "missing", "heap-1-a.heapsnapshot")
    expect(() => Heap.writeSnapshot(file)).toThrow()
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test.skipIf(process.platform === "win32")("snapshots are written with mode 0600", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "heap-1-a.heapsnapshot")

    Heap.writeSnapshot(file)

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(file)).size).toBeGreaterThan(0)
  })

  test("start() is idempotent", () => {
    expect(() => {
      Heap.start()
      Heap.start()
    }).not.toThrow()
  })
})
