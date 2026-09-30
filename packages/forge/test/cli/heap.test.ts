import { describe, expect, test } from "bun:test"
import { getHeapStatistics } from "node:v8"
import { Heap } from "../../src/cli/heap"

// Regression: the watchdog used to fire a synchronous writeHeapSnapshot at an
// absolute `rss > 2GB` threshold. The desktop sidecar runs with an 8GB heap
// ceiling, so heavy sessions sat at 2-4GB RSS while perfectly healthy — the
// snapshot then serialized the whole heap on the event loop for minutes and
// froze the app (packaged builds auto-arm FORGE_AUTO_HEAP_SNAPSHOT=1).
describe("cli.heap", () => {
  const limit = 8.6 * 1024 ** 3 // ~8GB old space + young/code ranges

  test("a busy process far below the heap ceiling is not near the limit", () => {
    expect(Heap.nearLimit({ used_heap_size: 2.1 * 1024 ** 3, heap_size_limit: limit })).toBe(false)
    expect(Heap.nearLimit({ used_heap_size: 3.9 * 1024 ** 3, heap_size_limit: limit })).toBe(false)
  })

  test("the limit is relative to the configured ceiling, not a fixed size", () => {
    expect(Heap.nearLimit({ used_heap_size: 1.5 * 1024 ** 3, heap_size_limit: 2 * 1024 ** 3 })).toBe(
      false,
    )
    expect(Heap.nearLimit({ used_heap_size: 1.9 * 1024 ** 3, heap_size_limit: 2 * 1024 ** 3 })).toBe(
      true,
    )
  })

  test("runtimes reporting no heap limit never trigger", () => {
    expect(Heap.nearLimit({ used_heap_size: 64 * 1024 ** 3, heap_size_limit: 0 })).toBe(false)
  })

  test("the live process is comfortably below the ceiling", () => {
    expect(Heap.nearLimit(getHeapStatistics())).toBe(false)
  })

  test("start() is a no-op when the flag is off", () => {
    expect(() => Heap.start()).not.toThrow()
  })
})
