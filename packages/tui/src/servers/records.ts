import { accessSync, constants, statSync } from "node:fs"
import { open, readlink } from "node:fs/promises"
import { hostname } from "node:os"
import { isAbsolute, join } from "node:path"
import { isRecord } from "../response-validation"
import { writtenSinceStart } from "./freshness"
import { parseJSON, validUsername } from "./text"
import type { AttachRecord, Context } from "./types"

export const APPS = [
  ["com.turenlabs.forge", "TurenOS"],
  ["com.turenlabs.forge.beta", "TurenOS Beta"],
  ["com.turenlabs.forge.dev", "TurenOS Dev"],
] as const

/** A live attach record, or Chromium's single-instance lock (`host-pid`), which every desktop version holds. */
export async function desktopRunning(ctx: Context, appId: string) {
  const root = appData(ctx)
  if (!root) return false
  if (await desktopRecord(ctx, join(root, appId, "attach.json"))) return true
  const lock = await readlink(join(root, appId, "SingletonLock")).catch(() => "")
  const match = /^(.+)-(\d+)$/.exec(lock)
  return !!match && match[1] === hostname() && alive(Number(match[2]))
}

export async function desktopRecord(ctx: Context, file: string) {
  const text = await readPrivate(file, ctx.uid, "self").catch(() => undefined)
  const value = text === undefined ? undefined : parseJSON(text)
  const record = attachRecord(value)
  if (!record || !isRecord(value) || !alive(value.pid)) return undefined
  if (!(await writtenSinceStart(value.pid as number, [file]))) return undefined
  return record
}

export async function shimRecord(ctx: Context) {
  const directory = join(ctx.home, ".forge", "run")
  const [pid, port, password] = await Promise.all(
    ["server.pid", "server.port", "server.auth"].map((name) =>
      readPrivate(join(directory, name), ctx.uid, "self").catch(() => undefined),
    ),
  )
  if (!alive(Number(pid?.trim())) || !password?.trim()) return undefined
  const files = ["server.pid", "server.port", "server.auth"].map((name) => join(directory, name))
  if (!(await writtenSinceStart(Number(pid?.trim()), files))) return undefined
  return shimState([
    `FORGE_REMOTE ${JSON.stringify({ port: Number(port?.trim()), username: "forge", password: password.trim() })}`,
  ])
}

export async function persistentRecord(ctx: Context) {
  const text = await readPrivate(ctx.persistentPath, ctx.uid, "root")
  const record = text === undefined ? undefined : attachRecord(parseJSON(text))
  if (!record) throw new Error("The persistent server's attach record is missing or unreadable.")
  return record
}

/** The record, among those this client trusts, whose server is exactly `origin`. */
export async function trustedRecord(ctx: Context, origin: string) {
  const root = appData(ctx)
  const records = await Promise.all([
    ...APPS.map(([appId]) => (root ? desktopRecord(ctx, join(root, appId, "attach.json")) : undefined)),
    shimRecord(ctx),
    ctx.platform === "linux" ? persistentRecord(ctx).catch(() => undefined) : undefined,
  ])
  return records.find((record) => record?.url === origin)
}

export function forgeBinary(ctx: Context) {
  if (ctx.forge !== undefined) return ctx.forge ?? undefined
  // A pinned binary is never replaced by whatever PATH offers.
  const pinned = ctx.env.TURENOS_FORGE
  if (pinned) return isAbsolute(pinned) && executable(pinned) ? pinned : undefined
  return [
    Bun.which("forge", { PATH: ctx.env.PATH ?? "" }) ?? undefined,
    join(ctx.home, ".forge", "bin", "forge"),
    ctx.platform === "darwin" ? "/Applications/TurenOS.app/Contents/Resources/forge-cli" : undefined,
  ].find((path): path is string => !!path && executable(path))
}

export function appData(ctx: Context) {
  if (ctx.platform === "darwin") return join(ctx.home, "Library", "Application Support")
  if (ctx.platform === "win32") return ctx.env.APPDATA
  return ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config")
}

export function username(ctx: Context) {
  return ctx.username ?? ctx.env.FORGE_SERVER_USERNAME ?? "forge"
}

export function shimState(lines: string[]): AttachRecord | undefined {
  const line = lines.findLast((item) => item.startsWith("FORGE_REMOTE {"))
  const value = line ? parseJSON(line.slice("FORGE_REMOTE ".length)) : undefined
  if (!isRecord(value) || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)
    return undefined
  if (typeof value.password !== "string" || !value.password || value.password.length > 1024) return undefined
  return {
    url: `http://127.0.0.1:${value.port}`,
    username: typeof value.username === "string" && validUsername(value.username) ? value.username : "forge",
    password: value.password,
  }
}

export function attachRecord(value: unknown): AttachRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.url !== "string") return undefined
  const url = URL.parse(value.url)
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username
  )
    return undefined
  if (typeof value.password !== "string" || !value.password || value.password.length > 1024) return undefined
  if (typeof value.username !== "string" || !validUsername(value.username)) return undefined
  const serverID = typeof value.serverID === "string" && value.serverID ? value.serverID : undefined
  return { url: url.origin, username: value.username, password: value.password, ...(serverID && { serverID }) }
}

/** Opens a file only when its owner could not have been another user and nobody else can rewrite it. */
export async function readPrivate(path: string, uid: number | undefined, owner: "self" | "root") {
  const handle = await open(path, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024) return undefined
    if (uid !== undefined && (info.uid !== (owner === "root" ? 0 : uid) || info.mode & 0o022)) return undefined
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

function alive(pid: unknown) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // EPERM means another user's process reuses the pid; that is not our server.
    return false
  }
}

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
