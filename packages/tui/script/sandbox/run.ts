import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** What `start` records about one sandbox, read back by every other command. */
export type Record = {
  name: string
  url: string
  username: string
  project: string
  model: { pid: number; port: number }
  server: { pid: number }
  started: number
}

export const packageDir = resolve(import.meta.dir, "../..")
export const repoDir = resolve(packageDir, "../..")

/**
 * Sandboxes live outside the repository, under a short path: the tmux socket sits in the run
 * directory and Unix socket paths must stay under 104 bytes.
 */
export function root(env: NodeJS.ProcessEnv = process.env) {
  const base = env.TUREN_SANDBOX_ROOT ?? join(env.XDG_RUNTIME_DIR ?? tmpdir(), "turen-tui-sandbox")
  const dir = resolve(base)
  if (dir === repoDir || dir.startsWith(`${repoDir}/`))
    throw new Error("The sandbox root must be outside the repository.")
  return dir
}

export function checkName(name: string | undefined) {
  if (!name || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(name))
    throw new Error("A sandbox name is 1-24 lowercase letters, digits or hyphens, starting with a letter or digit.")
  return name
}

export function paths(name: string, base = root()) {
  const dir = join(base, checkName(name))
  return {
    dir,
    home: join(dir, "home"),
    config: join(dir, "config"),
    data: join(dir, "data"),
    state: join(dir, "state"),
    cache: join(dir, "cache"),
    tmp: join(dir, "tmp"),
    project: join(dir, "project"),
    password: join(dir, "password"),
    record: join(dir, "sandbox.json"),
    socket: join(dir, "tmux"),
    serverLog: join(dir, "server.log"),
    modelLog: join(dir, "model.log"),
    tuiLog: join(dir, "tui.log"),
  }
}

export type Paths = ReturnType<typeof paths>

export function createDirs(p: Paths) {
  if (p.socket.length >= 104)
    throw new Error(
      `The tmux socket path is too long (${p.socket.length} bytes); set TUREN_SANDBOX_ROOT to a shorter directory.`,
    )
  mkdirSync(p.dir, { recursive: true, mode: 0o700 })
  chmodSync(p.dir, 0o700)
  for (const dir of [p.home, p.config, p.data, p.state, p.cache, p.tmp, p.project]) mkdirSync(dir, { recursive: true })
}

export function writePassword(p: Paths) {
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")
  writeFileSync(p.password, password, { mode: 0o600 })
  return password
}

export function readPassword(p: Paths) {
  return readFileSync(p.password, "utf8")
}

export function saveRecord(p: Paths, record: Record) {
  writeFileSync(p.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

export function loadRecord(name: string): Record {
  const p = paths(name)
  if (!existsSync(p.record))
    throw new Error(`No running sandbox named ${name}. Start one with: bun run sandbox start ${name}`)
  return JSON.parse(readFileSync(p.record, "utf8"))
}

export function names() {
  const base = root()
  if (!existsSync(base)) return []
  return readdirSync(base).filter((name) => existsSync(join(base, name, "sandbox.json")))
}

export function remove(p: Paths) {
  rmSync(p.dir, { recursive: true, force: true })
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
