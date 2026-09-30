import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@turenlabs/core/flag/flag"
import { Global } from "@turenlabs/core/global"
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024

let timer: Timer | undefined
let lock = false
let armed = true

export function start() {
  if (!Flag.FORGE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const stamp = new Date().toISOString().replace(/[:.]/g, "")
    // The report is a small JSON (JS stack + heap stats) written synchronously;
    // the heapsnapshot that follows is the expensive one and can still be lost
    // if the process wedges or dies first, so write the report up front.
    const report = path.join(Global.Path.log, `heap-report-${process.pid}-${stamp}.json`)
    try {
      process.report?.writeReport(report)
    } catch {}
    const file = path.join(Global.Path.log, `heap-${process.pid}-${stamp}.heapsnapshot`)
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
