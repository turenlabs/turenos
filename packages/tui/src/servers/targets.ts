import { randomUUID } from "node:crypto"
import { isRecord } from "../response-validation"
import { validUsername } from "./text"
import type { SshTarget, Target } from "./types"

/** How the header names a connected server: local servers read as this computer. */
export function serverLabel(target: Target) {
  if (target.kind === "desktop")
    return target.name === "TurenOS" ? "This computer" : `This computer (${target.name.replace("TurenOS ", "")})`
  if (target.kind === "shim") return "This computer (quick-connect)"
  if (target.kind === "persistent") return "This computer (persistent server)"
  if (target.kind === "env") return "This computer (port 4096)"
  if (target.kind === "headless") return "This computer (private server)"
  return target.name
}

export function sshDestination(target: { host: string; user?: string }) {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/** `[user@]host[:port]`, rejecting anything that could smuggle ssh options through the destination. */
export function parseSshTarget(input: string) {
  const value = input.trim()
  if (!value || value.startsWith("-") || /[\s\u0000-\u001f]/.test(value)) return undefined
  const at = /^([^@]+)@(.+)$/.exec(value)
  const rest = at ? at[2]! : value
  if (!rest || rest.startsWith("-") || rest.includes("@")) return undefined
  const withPort = /^([^:[\]]+):(\d{1,5})$/.exec(rest)
  if (!withPort && rest.includes(":")) return undefined
  const port = withPort ? Number(withPort[2]) : undefined
  if (port !== undefined && (port < 1 || port > 65535)) return undefined
  return { user: at?.[1], host: withPort ? withPort[1]! : rest, port }
}

export function sshTarget(input: Omit<SshTarget, "kind">) {
  const clean = (value: string | undefined, pattern: RegExp) =>
    value === undefined || (pattern.test(value) && !value.startsWith("-"))
  if (
    !input.host ||
    input.host.length > 255 ||
    !clean(input.host, /^[^\s@\u0000-\u001f]+$/) ||
    !clean(input.user, /^[^\s@:/\u0000-\u001f]{1,64}$/) ||
    !clean(input.identityFile, /^[^\u0000-\u001f]{1,4096}$/) ||
    (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) ||
    !input.name.trim() ||
    input.name.length > 128
  )
    return undefined
  return { kind: "ssh" as const, ...input }
}

export function urlTarget(input: Omit<Extract<Target, { kind: "url" }>, "kind">) {
  const url = URL.parse(input.url)
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^https?:\/\/[^/\\\s@?#]+\/?$/i.test(input.url)
  )
    return undefined
  if (input.username !== undefined && !validUsername(input.username)) return undefined
  if (input.passwordEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.passwordEnv)) return undefined
  if (!input.name.trim() || input.name.length > 128) return undefined
  return { kind: "url" as const, ...input, url: url.origin }
}

export function savedTarget(value: unknown) {
  if (!isRecord(value) || typeof value.name !== "string") return undefined
  const id = typeof value.id === "string" && /^srv_[A-Za-z0-9]{1,64}$/.test(value.id) ? value.id : newID()
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined)
  if (typeof value.url === "string")
    return urlTarget({
      id,
      name: value.name,
      url: value.url,
      username: text("username"),
      passwordEnv: text("passwordEnv"),
      saved: true,
    })
  const parsed = typeof value.ssh === "string" ? parseSshTarget(value.ssh) : undefined
  if (!parsed) return undefined
  return sshTarget({ id, name: value.name, ...parsed, identityFile: text("identityFile"), saved: true, desktop: false })
}

export function parseAddress(input: { address: string; name?: string; username?: string }) {
  const address = input.address.trim()
  const name = input.name?.trim()
  if (/^https?:\/\//i.test(address)) {
    const target = urlTarget({
      id: newID(),
      name: name || new URL(address).host,
      url: address,
      username: input.username?.trim() || undefined,
      saved: true,
    })
    if (!target) throw new Error("Enter the server's origin, such as https://turen.example, without a path.")
    return target
  }
  const parsed = parseSshTarget(address.replace(/^ssh:\/\//i, ""))
  const target = parsed
    ? sshTarget({ id: newID(), name: name || parsed.host, ...parsed, saved: true, desktop: false })
    : undefined
  if (!target) throw new Error("Enter https://host for a server URL, or user@host[:port] for SSH.")
  return target
}

function newID() {
  return `srv_${randomUUID().replaceAll("-", "")}`
}
