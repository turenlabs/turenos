import { readFileSync } from "node:fs"
import type { Context } from "./types"

/** Port 4096 in the hex /proc/net/tcp prints. */
const PORT = "1000"

/** The local addresses a connection to 127.0.0.1 reaches: 127.0.0.1, 0.0.0.0, :: and ::ffff:127.0.0.1 (never ::1). */
const REACHABLE = new Set([
  "0100007F",
  "00000000",
  "00000000000000000000000000000000",
  "0000000000000000FFFF00000100007F",
])

export function readProc(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * The uid of every LISTEN socket on 127.0.0.1:4096, or undefined when /proc cannot be read. The kernel records
 * the socket's owner, which is stronger than the process ownership tui-auth.ts rejects as proof of the listener.
 */
export function listenerOwners(ctx: Context) {
  const files = ["/proc/net/tcp", "/proc/net/tcp6"].map(ctx.readProc)
  if (files.every((text) => text === undefined)) return undefined
  return files.flatMap((text) =>
    (text ?? "").split("\n").flatMap((line) => {
      const column = line.trim().split(/\s+/)
      const [address, port] = (column[1] ?? "").split(":")
      return column[3] === "0A" && port === PORT && REACHABLE.has(address ?? "") ? [Number(column[7])] : []
    }),
  )
}

/** What the port-4096 entry would reach, judged before FORGE_SERVER_PASSWORD is sent to it. */
export function envListener(ctx: Context) {
  if (ctx.platform !== "linux") return "unchecked" as const
  const owners = listenerOwners(ctx)
  if (!owners) return "unknown" as const
  if (!owners.length) return "none" as const
  return owners.every((uid) => uid === ctx.uid) ? ("own" as const) : ("foreign" as const)
}

/** Why the password must not be sent, or undefined when it may be. */
export function envRefusal(ctx: Context) {
  const state = envListener(ctx)
  if (state === "none") return "Nothing is listening on 127.0.0.1:4096."
  if (state === "foreign")
    return "The listener on 127.0.0.1:4096 belongs to another user, so FORGE_SERVER_PASSWORD was not sent."
  if (state === "unknown")
    return "Cannot tell who owns the listener on 127.0.0.1:4096, so FORGE_SERVER_PASSWORD was not sent."
  return undefined
}
