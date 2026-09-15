import { parentPort } from "node:worker_threads"
import { instantiate, nodeFs } from "./host"

// Pool worker: each job message carries an Int32Array over a SharedArrayBuffer;
// the wasm polls fs_cancelled at frame/batch boundaries so aborts land
// mid-search without terminating the worker.
let cancelFlag: Int32Array | null = null
const ready = instantiate(nodeFs, { cancelled: () => cancelFlag !== null && cancelFlag[0] !== 0 })

if (!parentPort) throw new Error("ripgrep wasm worker requires a parent port")

// Serialize jobs: concurrent callers share this worker's cancel flag, so
// overlapping jobs would clobber each other's abort state.
let queue: Promise<void> = Promise.resolve()

parentPort.on("message", (m: any) => {
  queue = queue.then(() => handle(m))
})

const handle = async (m: any) => {
  const api = await ready
  cancelFlag = m.cancel ? new Int32Array(m.cancel) : null
  try {
    if (m.kind === "collect") {
      parentPort!.postMessage({
        id: m.id,
        paths: api.collectShards(m.root, m.dirs, m.globs, m.flags, 0),
        status: api.lastStatus(),
        rflags: api.resultFlags(),
      })
      return
    }
    if (m.kind === "linecount") {
      parentPort!.postMessage({
        id: m.id,
        counts: api.lineCount(m.files, m.flags, 0),
        status: api.lastStatus(),
        rflags: api.resultFlags(),
      })
      return
    }
    const bytes = api.grepManyRaw(m.pattern, m.files, m.flags, m.limit)
    parentPort!.postMessage(
      {
        id: m.id,
        bytes,
        status: api.lastStatus(),
        rflags: api.resultFlags(),
        err: api.lastStatus() === 2 ? api.lastError() : undefined,
      },
      [bytes.buffer as ArrayBuffer],
    )
  } finally {
    cancelFlag = null
  }
}
