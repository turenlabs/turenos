import path from "path"
import { getHeapStatistics, writeHeapSnapshot } from "node:v8"
import { Flag } from "@turenlabs/core/flag/flag"
import { Global } from "@turenlabs/core/global"
const MINUTE = 60_000
// Fire only when the heap is actually about to exhaust its configured limit.
// The previous absolute RSS budget tripped on busy-but-healthy sidecars — the
// desktop grants an 8GB heap, so ~2GB RSS is normal load — and
// writeHeapSnapshot serializes the whole heap on the event loop, so the
// diagnostic itself became the freeze it was meant to explain.
const NEAR_LIMIT = 0.9

let timer: Timer | undefined
let lock = false
let armed = true

export function nearLimit(stat: { used_heap_size: number; heap_size_limit: number }) {
  return stat.heap_size_limit > 0 && stat.used_heap_size >= stat.heap_size_limit * NEAR_LIMIT
}

export function start() {
  if (!Flag.FORGE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  const run = async () => {
    if (lock) return

    if (!nearLimit(getHeapStatistics())) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    process.stderr.write(`heap watchdog: heap near its configured limit, writing ${file}\n`)
    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .catch(() => {})

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
