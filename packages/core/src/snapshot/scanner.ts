export * as SnapshotScanner from "./scanner"

import { existsSync } from "node:fs"
import path from "node:path"

const requestLimit = 16 * 1024
const responseLimit = 1024 * 1024
const workerTimeout = 2_000
const restartDelay = 30_000
const idleTimeout = 30_000
const gitOverrides = [
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_ATTR_SOURCE",
  "GIT_ATTR_NOSYSTEM",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
]

type Paths = readonly [tracked: string[], untracked: string[]]
type Pending = {
  readonly timer: ReturnType<typeof setTimeout>
  readonly finish: (result: Buffer | undefined) => void
}

export function make(input: { resources?: string; env?: NodeJS.ProcessEnv; shadowRoot?: string } = {}) {
  const resources = input.resources ?? process.env.FORGE_RESOURCES_PATH
  const env = input.env ?? process.env
  if (!resources || !path.isAbsolute(resources) || typeof Bun === "undefined") return
  if (process.platform !== "darwin" && process.platform !== "linux") return
  if (gitOverrides.some((key) => env[key] !== undefined)) return
  const binary = path.join(resources, "snapshot-scan", "turen-snapshot")
  if (!existsSync(binary)) return

  let current: ReturnType<typeof start> | undefined
  let restartAt = 0

  const request = (fields: readonly string[], signal: AbortSignal) => {
    if (signal.aborted || Date.now() < restartAt || fields.some((field) => field.includes("\0")))
      return Promise.resolve(undefined)
    if (!current) {
      try {
        current = start(binary, env, input.shadowRoot, (failed) => {
          current = undefined
          if (failed) restartAt = Date.now() + restartDelay
        })
      } catch {
        restartAt = Date.now() + restartDelay
        return Promise.resolve(undefined)
      }
    }
    return current.request(fields, signal)
  }

  return {
    scan(input: { gitDirectory: string; worktree: string; scope: string }, signal: AbortSignal) {
      // Legacy scan messages start with an absolute path. Write messages start with an operation name.
      if (!path.isAbsolute(input.gitDirectory) || /[:*?[\\]/.test(input.scope)) return Promise.resolve(undefined)
      return request([input.gitDirectory, input.worktree, input.scope], signal).then((data) => data && paths(data))
    },
    writeTree(gitDirectory: string, signal: AbortSignal) {
      if (!input.shadowRoot || !path.isAbsolute(gitDirectory)) return Promise.resolve(undefined)
      const parts = path.relative(input.shadowRoot, gitDirectory).split(path.sep)
      if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part))) return Promise.resolve(undefined)
      return request(["write-tree", ...parts], signal).then((data) => {
        const tree = data?.toString("utf8")
        return tree && /^[0-9a-f]{40}$/.test(tree) ? tree : undefined
      })
    },
    close: () => current?.close(),
  }
}

function start(
  binary: string,
  env: NodeJS.ProcessEnv,
  shadowRoot: string | undefined,
  onClose: (failed: boolean) => void,
) {
  const child = Bun.spawn([binary, "--serve", ...(shadowRoot ? [shadowRoot] : [])], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const reader = child.stdout.getReader()
  const pending = new Map<number, Pending>()
  let nextID = 0
  let closed = false
  let buffer = Buffer.alloc(0)
  let writes = Promise.resolve()
  let idle: ReturnType<typeof setTimeout> | undefined

  function close(failed: boolean) {
    if (closed) return child.exited
    closed = true
    clearTimeout(idle)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.finish(undefined)
    }
    pending.clear()
    if (child.exitCode === null) child.kill("SIGKILL")
    onClose(failed)
    return child.exited
  }

  void child.exited.then(() => close(true))
  void (async () => {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return close(true)
      buffer = Buffer.concat([buffer, chunk.value])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE()
        if (length < 5 || length > responseLimit + 5) return close(true)
        if (buffer.length < length + 4) break
        const id = buffer.readUInt32BE(4)
        const status = buffer[8]
        const request = pending.get(id)
        if (!request || (status !== 0 && status !== 1)) return close(true)
        const data = buffer.subarray(9, length + 4)
        buffer = buffer.subarray(length + 4)
        pending.delete(id)
        clearTimeout(request.timer)
        request.finish(status === 0 ? data : undefined)
        if (!pending.size) idle = setTimeout(() => close(false), idleTimeout)
      }
    }
  })().catch(() => close(true))

  return {
    request(fields: readonly string[], signal: AbortSignal) {
      if (closed || pending.size >= 8) return Promise.resolve(undefined)
      const data = Buffer.from(fields.join("\0"))
      if (data.length > requestLimit - 4) return Promise.resolve(undefined)
      clearTimeout(idle)
      const id = nextID++ >>> 0
      const header = Buffer.alloc(8)
      header.writeUInt32BE(data.length + 4)
      header.writeUInt32BE(id, 4)
      return new Promise<Buffer | undefined>((resolve) => {
        const abort = () => resolve(undefined)
        signal.addEventListener("abort", abort, { once: true })
        // Keep the ID reserved after cancellation so its response can still be consumed.
        pending.set(id, {
          timer: setTimeout(() => close(true), workerTimeout),
          finish: (result) => {
            signal.removeEventListener("abort", abort)
            resolve(result)
          },
        })
        writes = writes
          .then(async () => {
            if (closed) return
            child.stdin.write(Buffer.concat([header, data]))
            await child.stdin.flush()
          })
          .catch(() => {
            void close(true)
          })
      })
    },
    close: () => close(false),
  }
}

function paths(data: Buffer): Paths | undefined {
  const text = data.toString("utf8")
  if (text.includes("\ufffd")) return
  const records = text.split("\0")
  if (records.pop() !== "") return
  const tracked: string[] = []
  const untracked: string[] = []
  for (const record of records) {
    const file = record.slice(1)
    if (record[0] !== "T" && record[0] !== "U") return
    if (
      file
        .replace(/\/$/, "")
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    )
      return
    const entries = record[0] === "T" ? tracked : untracked
    entries.push(file)
  }
  return [tracked, untracked]
}
