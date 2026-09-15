import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { instantiate, nodeFs } from "./host"
import type { Match, Api } from "./host"

// Two-stage parallel engine over node:worker_threads:
//  1. coordinator stats root's children; dir shards go to workers'
//     collectShards (root ignore context rebuilt per call, identical to the
//     serial walk); root-level files filtered via the coordinator instance.
//  2. candidates re-shard to workers for grep_many / line_count; results come
//     back as raw record bytes (transferable, no structured clone).
//
// Every job carries an Int32Array over a SharedArrayBuffer — setting cancel[0]
// unwinds in-flight wasm calls at the next poll boundary.

export interface Pool {
  grep(
    pattern: string,
    root: string,
    globs: string[],
    flags: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ matches: Match[]; partial: boolean; cancelled: boolean; invalidPattern?: string }>
  collect(
    root: string,
    globs: string[],
    flags: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ paths: string[]; partial: boolean; cancelled: boolean }>
  lineCount(
    files: string[],
    signal?: AbortSignal,
  ): Promise<{ counts: [string, number][]; partial: boolean; cancelled: boolean }>
  warm(globs: string[], flags: number): Promise<void>
  stop(): Promise<void>
}

const FLAG_HIDDEN = 1
const FLAG_FOLLOW = 2
export const WASM_FLAGS = { hidden: FLAG_HIDDEN, follow: FLAG_FOLLOW }

function workerURL() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources ? path.join(resources, "ripgrep-wasm", "ripgrep-wasm-worker.js") : undefined
  if (packaged && fs.existsSync(packaged)) return pathToFileURL(packaged)
  const executable = path.join(path.dirname(process.execPath), "ripgrep-wasm-worker.js")
  if (fs.existsSync(executable)) return pathToFileURL(executable)
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return new URL(`./ripgrep-wasm-worker.${extension}`, import.meta.url)
}

// A dead worker is infrastructure failure, not an unreadable file — losing a
// whole shard's results silently is worse than erroring the request.
const workerFailed = <T extends { status: number; err?: string }>(results: T[]) =>
  results.find((r) => r.status === -1)

export function startPool(
  size = Math.max(2, Math.min(10, os.cpus().length || 8)),
  ready: Promise<Api> | Api = instantiate(nodeFs),
): Pool {
  // Workers stay unref'd while idle so an unused pool never keeps a short-lived
  // CLI process alive; post() refs a worker for the duration of each job —
  // pending promises alone don't hold the event loop open.
  const workers = Array.from({ length: size }, () => {
    const w = new Worker(workerURL())
    w.unref?.()
    return w
  })
  let nextId = 0
  // One map per worker: an error/exit drains only that worker's jobs — a dead
  // worker must not poison in-flight requests running on healthy siblings.
  const inflight = new Map<Worker, Map<number, (out: any) => void>>()
  for (const w of workers) {
    const jobs = new Map<number, (out: any) => void>()
    inflight.set(w, jobs)
    w.on("message", (e: any) => {
      jobs.get(e.id)?.(e)
      jobs.delete(e.id)
    })
    const drain = (err: string) => {
      for (const [id, resolve] of jobs) {
        jobs.delete(id)
        resolve({ id, status: -1, err, bytes: new Uint8Array(0), paths: [], counts: [], rflags: 1 })
      }
    }
    w.on("error", (err) => drain(String(err)))
    w.on("exit", (code) => {
      if (code !== 0) drain(`worker exited with code ${code}`)
    })
  }
  let stopped = false
  const post = <T>(w: Worker, msg: object): Promise<T> =>
    new Promise((resolve) => {
      const id = nextId++
      inflight.get(w)!.set(id, (out: any) => {
        w.unref?.()
        resolve(out)
      })
      w.ref?.()
      w.postMessage({ id, ...msg })
    })

  const apiReady = Promise.resolve(ready)
  let warmed = false

  const runCollect = async (
    root: string,
    globs: string[],
    flags: number,
    signal: AbortSignal | undefined,
    cancel: Int32Array,
  ) => {
    const api = await apiReady
    // rg on a missing root exits 2 (partial, no results); on a file root it
    // emits the file itself. Mirror both here — the wasm walk only handles
    // directory roots.
    const stat = fs.statSync(root, { throwIfNoEntry: false })
    if (stat === undefined) return { paths: [] as string[], partial: true, cancelled: false }
    if (stat.isFile()) {
      const allowed = api.filterPaths(path.dirname(root), [root], globs, flags)
      return { paths: allowed, partial: false, cancelled: false }
    }
    const dirs: string[] = []
    const files: string[] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return { paths: [] as string[], partial: true, cancelled: false }
    }
    for (const e of entries) {
      const isLink = e.isSymbolicLink()
      if (isLink && !(flags & FLAG_FOLLOW)) continue
      const p = path.join(root, e.name)
      if (e.isDirectory() || isLink) dirs.push(p)
      else if (e.isFile()) files.push(p)
    }
    const allowed = api.filterPaths(root, files, globs, flags)
    if (cancel[0] !== 0 || signal?.aborted) return { paths: allowed, partial: true, cancelled: true }
    const dirShards: string[][] = workers.map(() => [])
    dirs.forEach((d, i) => dirShards[i % workers.length].push(d))
    const collected = await Promise.all(
      dirShards
        .filter((s) => s.length > 0)
        .map((ds, j) =>
          post<{ paths: string[]; rflags: number; status: number; err?: string }>(workers[j], {
            kind: "collect",
            root,
            dirs: ds,
            globs,
            flags,
            cancel: cancel.buffer,
          }),
        ),
    )
    const failed = workerFailed(collected)
    if (failed) throw new Error(`ripgrep wasm worker failed: ${failed.err ?? "unknown"}`)
    const cancelled = cancel[0] !== 0 || collected.some((r) => r.status === 3)
    return {
      paths: allowed.concat(collected.flatMap((c) => c.paths)),
      partial: collected.some((r) => (r.rflags & 1) !== 0 || r.status !== 0),
      cancelled,
    }
  }

  const shard = <T>(items: T[]): T[][] => {
    const out: T[][] = workers.map(() => [])
    items.forEach((f, i) => out[i % workers.length].push(f))
    return out
  }

  return {
    async grep(pattern, root, globs, flags, limit, signal) {
      const api = await apiReady
      // Compile-check the pattern on the coordinator before fanning out —
      // workers would all fail identically with status 2.
      api.grepMany(pattern, [], flags, 0)
      if (api.lastStatus() === 2) {
        return { matches: [], partial: false, cancelled: false, invalidPattern: api.lastError() }
      }
      const cancel = new Int32Array(new SharedArrayBuffer(4))
      const onAbort = () => {
        cancel[0] = 1
      }
      if (signal?.aborted) cancel[0] = 1
      else signal?.addEventListener("abort", onAbort)
      try {
        // A file root skips traversal entirely — candidates are pre-filtered,
        // so searching it directly is equivalent to `rg <pattern> <file>`.
        const fileRoot = fs.statSync(root, { throwIfNoEntry: false })?.isFile() ? [root] : undefined
        const stage1 = fileRoot
          ? { paths: fileRoot, partial: false }
          : await runCollect(root, globs, flags, signal, cancel)
        if (cancel[0] !== 0) return { matches: [], partial: true, cancelled: true }
        const fileShards = shard(stage1.paths)
        const results = await Promise.all(
          fileShards
            .filter((s) => s.length > 0)
            .map((fs_, j) =>
              post<{ bytes: Uint8Array; rflags: number; status: number; err?: string }>(workers[j], {
                kind: "grep",
                files: fs_,
                pattern,
                flags,
                limit,
                cancel: cancel.buffer,
              }),
            ),
        )
        const failed = workerFailed(results)
        if (failed) throw new Error(`ripgrep wasm worker failed: ${failed.err ?? "unknown"}`)
        const partial =
          stage1.partial || results.some((r) => (r.rflags & 1) !== 0 || r.status === 3)
        const matches = results.flatMap((r) => api.parseMatches(r.bytes))
        const capped = limit > 0 ? matches.slice(0, limit) : matches
        return { matches: capped, partial, cancelled: cancel[0] !== 0 }
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    },

    async collect(root, globs, flags, limit, signal) {
      const cancel = new Int32Array(new SharedArrayBuffer(4))
      const onAbort = () => {
        cancel[0] = 1
      }
      if (signal?.aborted) cancel[0] = 1
      else signal?.addEventListener("abort", onAbort)
      try {
        const r = await runCollect(root, globs, flags, signal, cancel)
        return { paths: limit > 0 ? r.paths.slice(0, limit) : r.paths, partial: r.partial, cancelled: r.cancelled }
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    },

    async lineCount(files, signal) {
      const cancel = new Int32Array(new SharedArrayBuffer(4))
      const onAbort = () => {
        cancel[0] = 1
      }
      if (signal?.aborted) cancel[0] = 1
      else signal?.addEventListener("abort", onAbort)
      try {
        const fileShards = shard(files)
        const results = await Promise.all(
          fileShards
            .filter((s) => s.length > 0)
            .map((fs_, j) =>
              post<{ counts: [string, number][]; rflags: number; status: number; err?: string }>(workers[j], {
                kind: "linecount",
                files: fs_,
                flags: 0,
                cancel: cancel.buffer,
              }),
            ),
        )
        const failed = workerFailed(results)
        if (failed) throw new Error(`ripgrep wasm worker failed: ${failed.err ?? "unknown"}`)
        return {
          counts: results.flatMap((r) => r.counts),
          partial: results.some((r) => (r.rflags & 1) !== 0 || (r.status !== 0 && r.status !== 3)),
          cancelled: cancel[0] !== 0 || results.some((r) => r.status === 3),
        }
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    },

    async warm(globs, flags) {
      if (warmed) return
      warmed = true
      // JSCore tiers wasm up from the interpreter; a fresh instance is ~10x
      // slower until compiled. Run real collect+grep rounds at startup over a
      // small generated tree — warming on the process cwd would pay whatever
      // readdir cost the launch directory happens to have.
      const cancel = new Int32Array(new SharedArrayBuffer(4))
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "rgwasm-warm-"))
      try {
        for (let d = 0; d < 8; d++) {
          fs.mkdirSync(path.join(fixture, `d${d}`))
          for (let f = 0; f < 40; f++) {
            fs.writeFileSync(path.join(fixture, `d${d}`, `f${f}.ts`), `class C${d}${f} {}\n`.repeat(50))
          }
        }
      } catch {
        return
      }
      const dirs = fs
        .readdirSync(fixture, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(fixture, e.name))
      const dirShards = shard(dirs)
      try {
        for (let round = 0; round < 20; round++) {
          await Promise.all(
            workers.map((w, j) =>
              dirShards[j].length === 0
                ? Promise.resolve()
                : post(w, {
                    kind: "collect",
                    root: fixture,
                    dirs: dirShards[j],
                    globs,
                    flags,
                    cancel: cancel.buffer,
                  }),
            ),
          )
        }
        const sample = (await Promise.all(
          workers.map((w, j) =>
            dirShards[j].length === 0
              ? Promise.resolve({ paths: [] })
              : post<{ paths: string[] }>(w, {
                  kind: "collect",
                  root: fixture,
                  dirs: dirShards[j].slice(0, 2),
                  globs,
                  flags,
                  cancel: cancel.buffer,
                }),
          ),
        ))
          .flatMap((r) => r.paths)
          .slice(0, workers.length * 60)
        const fileShards = shard(sample)
        for (let round = 0; round < 15; round++) {
          await Promise.all(
            workers.map((w, j) =>
              fileShards[j].length === 0
                ? Promise.resolve()
                : post(w, {
                    kind: "grep",
                    files: fileShards[j],
                    pattern: "\\bclass\\b",
                    flags,
                    limit: 0,
                    cancel: cancel.buffer,
                  }),
            ),
          )
        }
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true })
      }
    },

    async stop() {
      if (stopped) return
      stopped = true
      await Promise.all(workers.map((w) => w.terminate()))
    },
  }
}
