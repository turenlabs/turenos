import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Resolution order mirrors the other *-wasm assets: bundled dist next to the
// module or executable, then the workspace package, then the in-repo workbench
// build for development. FORGE_RIPGREP_WASM_ASSET overrides all of it.
export function resolveWasm(): string | undefined {
  const override = process.env.FORGE_RIPGREP_WASM_ASSET
  if (override) return fs.existsSync(override) ? override : undefined
  const current = path.dirname(fileURLToPath(import.meta.url))
  const roots = [
    // Packaged worker: it runs from <resources>/ripgrep-wasm/ with dist/
    // alongside it.
    path.join(current, "dist", "rgwasm.wasm"),
    // Bundled server: the module lives in dist/node/chunks/, the package dir
    // sits alongside it as dist/node/ripgrep-wasm/.
    path.join(current, "ripgrep-wasm", "dist", "rgwasm.wasm"),
    // CLI: package dir next to the executable.
    path.join(path.dirname(process.execPath), "ripgrep-wasm", "dist", "rgwasm.wasm"),
  ]
  for (const candidate of roots) if (fs.existsSync(candidate)) return candidate
  try {
    const pkg = fileURLToPath(import.meta.resolve("@turenlabs/ripgrep-wasm"))
    const found = path.join(path.dirname(pkg), "rgwasm.wasm")
    if (fs.existsSync(found)) return found
  } catch {}
  const workbench = path.join(
    current,
    "../../../../../workbench/ripgrep-wasm/crate/target/wasm32-unknown-unknown/release/rgwasm.wasm",
  )
  if (fs.existsSync(workbench)) return workbench
  return undefined
}

export interface DirentLike {
  kind: number // 1 file, 2 dir, 3 symlink, 4 other
  name: string
}

// The fs surface the wasm module needs. A real impl wraps node:fs; tests can
// inject a scripted fake to exercise paths a real filesystem can't produce
// (cycles, unbounded depth, hostile readdir/read_files returns).
export interface FsImpl {
  kind(p: string): number
  readdir(p: string): DirentLike[] | null
  readFile(p: string): Uint8Array | null
  // stat semantics (resolve symlinks); only called when FLAG_FOLLOW is set.
  statKind?(p: string): number
  // [dev, ino] for loop detection under --follow.
  devino?(p: string): [bigint, bigint] | null
  // Optional overrides for adversarial cases; defaults derive from readFile.
  readFiles?(paths: string[], view: Uint8Array, off: number, limit: number): bigint
  open?(p: string): number
  read?(fd: number, view: Uint8Array, off: number, cap: number): number
  close?(fd: number): void
}

const isWindows = process.platform === "win32"

// Windows junctions report as directories via Dirent/lstat but are reparse
// points — readlink succeeds on them. rg treats them as links (skips without
// -L); probe so traversal doesn't recurse through junction cycles.
const junctionKind = (p: string, fallback: number): number => {
  if (!isWindows || fallback !== 2) return fallback
  try {
    fs.readlinkSync(p)
    return 3
  } catch {
    return fallback
  }
}

export const nodeFs: FsImpl = {
  kind(p) {
    try {
      const st = fs.lstatSync(p)
      if (st.isFile()) return 1
      if (st.isDirectory()) return junctionKind(p, 2)
      if (st.isSymbolicLink()) return 3
      return 4
    } catch {
      return 0
    }
  },
  statKind(p) {
    try {
      const st = fs.statSync(p)
      if (st.isFile()) return 1
      if (st.isDirectory()) return 2
      return 4
    } catch {
      return 0
    }
  },
  devino(p) {
    try {
      const st = fs.statSync(p, { bigint: true })
      return [st.dev, st.ino]
    } catch {
      return null
    }
  },
  readdir(p) {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).map((e) => ({
        kind: e.isFile()
          ? 1
          : e.isDirectory()
            ? junctionKind(path.join(p, e.name), 2)
            : e.isSymbolicLink()
              ? 3
              : 4,
        name: e.name,
      }))
    } catch {
      return null
    }
  },
  readFile(p) {
    try {
      return fs.readFileSync(p)
    } catch {
      return null
    }
  },
}

export interface Match {
  path: string
  line: number
  offset: number
  text: string
  submatches: { start: number; end: number; text: string }[]
}

export interface Api {
  grep(pattern: string, root: string, globs: string[], flags: number, limit: number): Match[]
  grepMany(pattern: string, files: string[], flags: number, limit: number): Match[]
  collect(root: string, globs: string[], flags: number, limit: number): string[]
  collectShards(root: string, shards: string[], globs: string[], flags: number, limit: number): string[]
  filterPaths(root: string, files: string[], globs: string[], flags: number): string[]
  lineCount(files: string[], flags: number, limit: number): [string, number][]
  // Raw record bytes for grep_many — for transferable worker results.
  grepManyRaw(pattern: string, files: string[], flags: number, limit: number): Uint8Array
  parseMatches(buf: Uint8Array): Match[]
  // Return code of the last call: 0 ok, 1 missing root, 2 bad pattern, 3 cancelled.
  lastStatus(): number
  // bit0: some files/dirs unreadable (rg exit-2 partial equivalent).
  resultFlags(): number
  // Error text for status 2 (regex compile failure), "" otherwise.
  lastError(): string
  stats: Record<string, number>
}

export interface InstantiateOpts {
  // Polled by the wasm at batch/frame boundaries. For workers the coordinator
  // passes a callback reading a SharedArrayBuffer flag so aborts land
  // mid-search.
  cancelled?: () => boolean
  // Override the wasm asset — default resolves relative to this module.
  wasmPath?: string
  bytes?: Uint8Array | ArrayBuffer
}

// Wasm-internal paths are always '/'-separated. On Windows we normalize
// incoming native paths once at the boundary; node:fs accepts '/' everywhere.
const toWasmPath = (p: string) => (isWindows ? p.replaceAll("\\", "/") : p)

export async function instantiate(impl: FsImpl = nodeFs, opts?: InstantiateOpts): Promise<Api> {
  const wasmPath = opts?.wasmPath ?? resolveWasm()
  const bytes = opts?.bytes ?? fs.readFileSync(wasmPath ?? "")
  const stats = { kind: 0, readdir: 0, read_files: 0, read_file: 0, open: 0, read: 0, close: 0, hostMs: 0 }
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  let memory: WebAssembly.Memory

  const timed = <T>(fn: () => T): T => {
    const t0 = performance.now()
    try {
      return fn()
    } finally {
      stats.hostMs += performance.now() - t0
    }
  }
  const str = (ptr: number, len: number) => decoder.decode(new Uint8Array(memory.buffer, ptr, len))

  // fd fallback plumbing derived from impl.readFile unless overridden.
  const fds = new Map<number, { data: Uint8Array; pos: number }>()
  let nextFd = 1
  const openImpl = impl.open ?? ((p: string) => {
    const data = impl.readFile(p)
    if (data === null) return -1
    const id = nextFd++
    fds.set(id, { data, pos: 0 })
    return id
  })
  const readImpl = impl.read ?? ((fd: number, view: Uint8Array, off: number, cap: number) => {
    const f = fds.get(fd)
    if (!f) return -1
    const n = Math.min(cap, f.data.length - f.pos)
    if (n <= 0) return 0
    view.set(f.data.subarray(f.pos, f.pos + n), off)
    f.pos += n
    return n
  })
  const closeImpl = impl.close ?? ((fd: number) => void fds.delete(fd))

  const defaultReadFiles = (paths: string[], view: Uint8Array, off: number, limit: number): bigint => {
    const dv = new DataView(view.buffer)
    for (const p of paths) {
      if (off + 9 > limit) break
      const data = impl.readFile(p)
      if (data === null) {
        view[off] = 1
        dv.setBigUint64(off + 1, 0n, true)
        off += 9
        continue
      }
      if (off + 9 + data.length > limit) {
        if (off === 0) return BigInt(-(9 + data.length))
        break
      }
      view[off] = 0
      dv.setBigUint64(off + 1, BigInt(data.length), true)
      view.set(data, off + 9)
      off += 9 + data.length
    }
    return BigInt(off)
  }

  const statKindImpl = impl.statKind ?? impl.kind
  const devinoImpl = impl.devino ?? (() => null)

  const imports = {
    host: {
      fs_kind: (ptr: number, len: number): number => {
        stats.kind++
        return timed(() => impl.kind(str(ptr, len)))
      },
      fs_stat_kind: (ptr: number, len: number): number => {
        stats.kind++
        return timed(() => statKindImpl(str(ptr, len)))
      },
      fs_devino: (ptr: number, len: number, out: number): number =>
        timed(() => {
          const id = devinoImpl(str(ptr, len))
          if (id === null) return -1
          const dv = new DataView(memory.buffer)
          dv.setBigUint64(out, id[0], true)
          dv.setBigUint64(out + 8, id[1], true)
          return 0
        }),
      fs_cancelled: (): number => (opts?.cancelled?.() ? 1 : 0),
      fs_readdir: (ptr: number, len: number, buf: number, cap: number): bigint => {
        stats.readdir++
        return timed(() => {
          const entries = impl.readdir(str(ptr, len))
          if (entries === null) return -1n
          const kinds = new Uint8Array(entries.length)
          let total = 0
          for (let j = 0; j < entries.length; j++) {
            kinds[j] = entries[j].kind
            total += 5 + Buffer.byteLength(entries[j].name)
          }
          if (total > cap) return BigInt(-total)
          const view = new Uint8Array(memory.buffer)
          const dv = new DataView(memory.buffer)
          let o = buf
          for (let j = 0; j < entries.length; j++) {
            const enc = encoder.encodeInto(entries[j].name, view.subarray(o + 5))
            view[o] = kinds[j]
            dv.setUint32(o + 1, enc.written ?? 0, true)
            o += 5 + (enc.written ?? 0)
          }
          return BigInt(total)
        })
      },
      fs_read_files: (pp: number, pl: number, buf: number, cap: number): bigint => {
        stats.read_files++
        return timed(() => {
          const joined = str(pp, pl)
          const paths = joined.split("\x00")
          if (paths[paths.length - 1] === "") paths.pop()
          const view = new Uint8Array(memory.buffer)
          const fn = impl.readFiles ?? ((ps: string[], v: Uint8Array, off: number, lim: number) => defaultReadFiles(ps, v, off, lim))
          return fn(paths, view, buf, buf + cap)
        })
      },
      fs_read_file: (ptr: number, len: number, buf: number, cap: number): bigint => {
        stats.read_file++
        return timed(() => {
          const data = impl.readFile(str(ptr, len))
          if (data === null) return -1n
          if (data.length > cap) return BigInt(-data.length)
          new Uint8Array(memory.buffer, buf, cap).set(data)
          return BigInt(data.length)
        })
      },
      fs_open: (ptr: number, len: number): number => {
        stats.open++
        return timed(() => openImpl(str(ptr, len)))
      },
      fs_read: (fd: number, buf: number, cap: number): number => {
        stats.read++
        return timed(() => readImpl(fd, new Uint8Array(memory.buffer), buf, cap))
      },
      fs_close: (fd: number) => {
        stats.close++
        closeImpl(fd)
      },
    },
  }

  const { instance } = await WebAssembly.instantiate(bytes, imports)
  const ex = instance.exports as any
  memory = ex.memory

  // Alloc may grow memory — always resolve pointers against a fresh buffer.
  const withStr = (s: string, fn: (ptr: number, len: number) => void) => {
    const b = Buffer.from(s, "utf8")
    const ptr = ex.alloc(b.length || 1)
    new Uint8Array(memory.buffer, ptr, b.length).set(b)
    try {
      fn(ptr, b.length)
    } finally {
      ex.dealloc(ptr, b.length || 1)
    }
  }

  const resultBytes = () => new Uint8Array(memory.buffer, ex.result_ptr(), ex.result_len())
  let lastStatus = 0
  const lastError = () => decoder.decode(new Uint8Array(memory.buffer, ex.err_ptr(), ex.err_len()))
  const resultFlags = () => ex.result_flags()

  const parseMatchesFrom = (buf: Uint8Array): Match[] => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out: Match[] = []
    let i = 0
    while (i < buf.length) {
      const rec = buf[i++]
      if (rec !== 1) break
      const plen = dv.getUint32(i, true)
      i += 4
      const p = decoder.decode(buf.subarray(i, i + plen))
      i += plen
      const line = Number(dv.getBigUint64(i, true))
      const offset = Number(dv.getBigUint64(i + 8, true))
      i += 16
      const tlen = dv.getUint32(i, true)
      i += 4
      const text = decoder.decode(buf.subarray(i, i + tlen))
      i += tlen
      const nsub = dv.getUint32(i, true)
      i += 4
      const submatches: Match["submatches"] = []
      for (let s = 0; s < nsub; s++) {
        const start = Number(dv.getBigUint64(i, true))
        const end = Number(dv.getBigUint64(i + 8, true))
        const slen = dv.getUint32(i + 16, true)
        i += 20
        submatches.push({ start, end, text: decoder.decode(buf.subarray(i, i + slen)) })
        i += slen
      }
      out.push({ path: p, line, offset, text, submatches })
    }
    return out
  }

  return {
    stats,
    lastStatus: () => lastStatus,
    resultFlags,
    lastError,
    grep(pattern, root, globs, flags, limit) {
      withStr(pattern, (pp, pl) =>
        withStr(toWasmPath(path.resolve(root)), (rp, rl) =>
          withStr(globs.join("\n"), (gp, gl) => {
            lastStatus = ex.grep(pp, pl, rp, rl, gp, gl, flags, limit)
          }),
        ),
      )
      return parseMatchesFrom(resultBytes())
    },
    grepMany(pattern, files, flags, limit) {
      const paths = files.length === 0 ? "" : files.map(toWasmPath).join("\x00") + "\x00"
      withStr(pattern, (pp, pl) =>
        withStr(paths, (xp, xl) => {
          lastStatus = ex.grep_many(pp, pl, xp, xl, flags, limit)
        }),
      )
      return parseMatchesFrom(resultBytes())
    },
    collect(root, globs, flags, limit) {
      withStr(toWasmPath(path.resolve(root)), (rp, rl) =>
        withStr(globs.join("\n"), (gp, gl) => {
          lastStatus = ex.collect(rp, rl, gp, gl, flags, limit)
        }),
      )
      return decoder.decode(resultBytes()).split("\x00").filter(Boolean)
    },
    collectShards(root, shards, globs, flags, limit) {
      const dirs = shards.length === 0 ? "" : shards.map(toWasmPath).join("\x00") + "\x00"
      withStr(toWasmPath(path.resolve(root)), (rp, rl) =>
        withStr(dirs, (sp, sl) =>
          withStr(globs.join("\n"), (gp, gl) => {
            lastStatus = ex.collect_shards(rp, rl, sp, sl, gp, gl, flags, limit)
          }),
        ),
      )
      return decoder.decode(resultBytes()).split("\x00").filter(Boolean)
    },
    filterPaths(root, files, globs, flags) {
      const paths = files.length === 0 ? "" : files.map(toWasmPath).join("\x00") + "\x00"
      withStr(toWasmPath(path.resolve(root)), (rp, rl) =>
        withStr(paths, (pp, pl) =>
          withStr(globs.join("\n"), (gp, gl) => {
            lastStatus = ex.filter_paths(rp, rl, pp, pl, gp, gl, flags, 0)
          }),
        ),
      )
      return decoder.decode(resultBytes()).split("\x00").filter(Boolean)
    },
    grepManyRaw(pattern, files, flags, limit) {
      const paths = files.length === 0 ? "" : files.map(toWasmPath).join("\x00") + "\x00"
      withStr(pattern, (pp, pl) =>
        withStr(paths, (xp, xl) => {
          lastStatus = ex.grep_many(pp, pl, xp, xl, flags, limit)
        }),
      )
      return resultBytes().slice()
    },
    parseMatches: (buf: Uint8Array) => parseMatchesFrom(buf),
    lineCount(files, flags, limit) {
      const paths = files.length === 0 ? "" : files.map(toWasmPath).join("\x00") + "\x00"
      withStr(paths, (xp, xl) => {
        lastStatus = ex.line_count(xp, xl, flags, limit)
      })
      const buf = resultBytes()
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const out: [string, number][] = []
      let i = 0
      while (i + 4 <= buf.length) {
        const plen = dv.getUint32(i, true)
        i += 4
        const p = decoder.decode(buf.subarray(i, i + plen))
        i += plen
        out.push([p, Number(dv.getBigUint64(i, true))])
        i += 8
      }
      return out
    },
  }
}
