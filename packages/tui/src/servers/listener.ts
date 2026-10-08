import { readFileSync } from "node:fs"
import type { Context } from "./types"

/** The local addresses a connection to 127.0.0.1 reaches: 127.0.0.1, 0.0.0.0, :: and ::ffff:127.0.0.1 (never ::1). */
const V4 = new Set(["0100007F", "00000000", "00000000000000000000000000000000", "0000000000000000FFFF00000100007F"])

/** The ones a connection to [::1] reaches: ::1 and :: (an IPv4 listener never answers it). */
const V6 = new Set(["00000000000000000000000001000000", "00000000000000000000000000000000"])

const OPTIONAL_TABLE = "/proc/net/tcp6"

/**
 * A /proc file as text, or undefined when it exists but cannot be read. A kernel without IPv6 has no
 * tcp6 table, which reads as empty; any other missing or unreadable table leaves the owner unknown.
 */
export function readProc(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    const absent = error instanceof Error && "code" in error && error.code === "ENOENT"
    return absent && path === OPTIONAL_TABLE ? "" : undefined
  }
}

/**
 * The uid of every LISTEN socket on `host`:`port`, or undefined unless both socket tables were read: a table
 * that is missing from the answer could hold another user's listener. The kernel records the socket's owner,
 * which is stronger than the process ownership tui-auth.ts rejects as proof of the listener.
 */
export function listenerOwners(ctx: Pick<Context, "readProc">, port: number, host: Host = "127.0.0.1") {
  const files = ["/proc/net/tcp", OPTIONAL_TABLE].map(ctx.readProc)
  if (files.some((text) => text === undefined)) return undefined
  const hex = port.toString(16).toUpperCase().padStart(4, "0")
  const reachable = host === "[::1]" ? V6 : V4
  return files.flatMap((text) =>
    (text ?? "").split("\n").flatMap((line) => {
      const column = line.trim().split(/\s+/)
      const [address, listening] = (column[1] ?? "").split(":")
      return column[3] === "0A" && listening === hex && reachable.has(address ?? "") ? [Number(column[7])] : []
    }),
  )
}

type Host = "127.0.0.1" | "[::1]"
type Local = Pick<Context, "platform" | "uid" | "readProc">

/** What a loopback origin would reach, judged before a password from the environment or discovery is sent to it. */
export function loopbackListener(ctx: Local, port: number, host: Host = "127.0.0.1") {
  if (ctx.platform !== "linux") return "unchecked" as const
  const owners = listenerOwners(ctx, port, host)
  if (!owners) return "unknown" as const
  if (!owners.length) return "none" as const
  return owners.every((uid) => uid === ctx.uid) ? ("own" as const) : ("foreign" as const)
}

/** Why the password must not be sent to `host`:`port`, or undefined when it may be. `sent` names the password. */
export function loopbackRefusal(
  ctx: Local,
  port: number,
  host: Host = "127.0.0.1",
  sent = "FORGE_SERVER_PASSWORD",
) {
  const state = loopbackListener(ctx, port, host)
  if (state === "none") return `Nothing is listening on ${host}:${port}.`
  if (state === "foreign") return `The listener on ${host}:${port} belongs to another user, so ${sent} was not sent.`
  if (state === "unknown") return `Cannot tell who owns the listener on ${host}:${port}, so ${sent} was not sent.`
  return undefined
}

/** What the port-4096 entry would reach, judged before FORGE_SERVER_PASSWORD is sent to it. */
export const envListener = (ctx: Local) => loopbackListener(ctx, 4096)

/** Why the password must not be sent to the port-4096 entry, or undefined when it may be. */
export const envRefusal = (ctx: Local) => loopbackRefusal(ctx, 4096)
