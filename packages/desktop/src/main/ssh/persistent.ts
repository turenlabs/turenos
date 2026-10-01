import type { SshServerConfig } from "../../preload/types"

/** Where a managed Linux persistent server publishes its attach record, readable by the operator group. */
export const ATTACH_RECORD_PATH = "/etc/turenos/attach.json"

export type AttachRecord = {
  version: 1
  serverID: string
  url: string
  username: string
  password: string
}

export type AttachProbe =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "malformed" }
  | { state: "readable"; record: AttachRecord }

export type AttachClassification =
  | { kind: "attach-existing"; record: AttachRecord }
  | { kind: "start-quick-connect" }
  | { kind: "conflict"; message: string }

/** Sent on stdin so nothing in it lands in argv. It sends no secrets. */
export const REMOTE_ATTACH_PROBE_SCRIPT = [
  `f="${ATTACH_RECORD_PATH}"`,
  // `-e` is false inside a directory this user cannot search, which must not read as "no server".
  'if [ -d "${f%/*}" ] && [ ! -x "${f%/*}" ]; then printf "FORGE_ATTACH unreadable\\n"',
  'elif [ ! -e "$f" ]; then printf "FORGE_ATTACH missing\\n"',
  'elif [ ! -r "$f" ]; then printf "FORGE_ATTACH unreadable\\n"',
  'else printf "FORGE_ATTACH readable %s\\n" "$(tr -d \'\\r\\n\' < "$f")"; fi',
  "",
].join("\n")

export function parseAttachProbe(output: string): AttachProbe {
  // Anchored per line, so a login banner cannot fake a probe result.
  const match = output
    .split(/\r?\n/g)
    .map((line) => /^FORGE_ATTACH (missing|unreadable|readable)(?: (.*))?$/.exec(line.trim()))
    .findLast((result) => result !== null)
  // A successful SSH command without our marker did not prove the record is absent.
  if (!match) return { state: "malformed" }
  if (match[1] !== "readable") return { state: match[1] as "missing" | "unreadable" }
  const record = parseAttachRecord(match[2] ?? "")
  return record ? { state: "readable", record } : { state: "malformed" }
}

export function parseAttachRecord(text: string): AttachRecord | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (
      value.version !== 1 ||
      typeof value.serverID !== "string" ||
      !value.serverID ||
      typeof value.url !== "string" ||
      typeof value.username !== "string" ||
      typeof value.password !== "string" ||
      !value.password
    )
      return
    const url = new URL(value.url)
    // The SSH tunnel forwards to remote 127.0.0.1, so only that exact listener can be attached.
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) === 0 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return
    return { version: 1, serverID: value.serverID, url: value.url, username: value.username, password: value.password }
  } catch {
    return
  }
}

/** Decides how to reach an SSH host before anything is written to it or started on it. */
export function classifyAttach(config: SshServerConfig, probe: AttachProbe): AttachClassification {
  if (probe.state === "readable") {
    if (config.persistent && config.persistent.serverID !== probe.record.serverID)
      return {
        kind: "conflict",
        message: `${config.host} now publishes server ${probe.record.serverID}, not the saved ${config.persistent.serverID}. Remove and re-add the server if the host was intentionally replaced.`,
      }
    return { kind: "attach-existing", record: probe.record }
  }
  if (probe.state === "unreadable")
    return {
      kind: "conflict",
      // The probe runs over a reused ssh master, whose login still has the groups it started with.
      message: `${config.host} runs a managed TurenOS server, but this SSH user cannot read its attach record. Ask the host operator for access (on Linux, membership in the turenos-operators group). New group membership applies only to a new SSH login, and TurenOS keeps its SSH connection open until it has been idle for 10 minutes, so reconnect after that.`,
    }
  if (probe.state === "malformed")
    return { kind: "conflict", message: `${config.host} has a malformed TurenOS attach record; refusing to connect.` }
  if (config.persistent)
    return {
      kind: "conflict",
      message: `${config.host} was a managed persistent server, but no attach record was found. Check the service on the host; TurenOS will not start a replacement server.`,
    }
  return { kind: "start-quick-connect" }
}

/**
 * Confirms the tunnelled server is the persistent server the attach record names, and returns the
 * service's version so the desktop can show it beside the target.
 */
export function verifyDescriptor(record: AttachRecord, descriptor: unknown) {
  const value = descriptor as { serverID?: unknown; mode?: unknown; version?: unknown } | null
  if (!value || typeof value !== "object" || typeof value.serverID !== "string")
    throw new Error("TurenOS server did not return a valid descriptor")
  if (value.serverID !== record.serverID)
    throw new Error(`TurenOS server reports ${value.serverID}, but its attach record names ${record.serverID}`)
  if (value.mode !== "persistent") throw new Error("TurenOS server behind the attach record is not persistent")
  return { version: typeof value.version === "string" && value.version ? value.version : null }
}
