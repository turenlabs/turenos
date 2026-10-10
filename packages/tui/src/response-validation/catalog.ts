import {
  array,
  checkDirectory,
  choice,
  clip,
  identifier,
  invalid,
  location,
  modelRef,
  name,
  numeric,
  object,
  optional,
  string,
  unique,
} from "./primitives"

export function terminals(address: URL, value: unknown) {
  const response = object(value)
  location(response.location)
  const requested = address.searchParams.get("location[directory]")
  if (requested !== null && object(response.location).directory !== requested) invalid("terminal location identity")
  unique(array(response.data, 1000), (value) => {
    const item = object(value)
    identifier(item.id, "pty_")
    string(item.title, 64000)
    string(item.command)
    array(item.args, 256).forEach((arg) => string(arg, 64000))
    checkDirectory(item.cwd)
    choice(item.status, ["running", "exited"])
    if (!Number.isSafeInteger(numeric(item.pid)) || Number(item.pid) < 0) invalid("process ID")
    optional(item.exitCode, numeric)
  })
}

export function agents(address: URL, value: unknown) {
  const response = object(value)
  location(response.location)
  const requested = address.searchParams.get("location[directory]")
  if (requested !== null && object(response.location).directory !== requested) invalid("agent location identity")
  unique(array(response.data, 256), (value) => {
    const item = object(value)
    name(item.id)
    choice(item.mode, ["primary", "subagent", "all"])
    if (typeof item.hidden !== "boolean") invalid("agent visibility")
    optional(item.description, string)
    optional(item.model, modelRef)
  })
}

/** Keeps every usable command; an invalid, duplicate or unaddressable (`/` or whitespace in the name) entry is skipped. */
export function commands(address: URL, value: unknown) {
  const response = object(value)
  location(response.location)
  const resolved = object(response.location)
  const directory = address.searchParams.get("location[directory]")
  const workspace = address.searchParams.get("location[workspace]")
  if (directory !== null && resolved.directory !== directory) invalid("command location identity")
  if (workspace !== null && resolved.workspaceID !== workspace) invalid("command workspace identity")
  if (!Array.isArray(response.data)) invalid("array expected")
  const names = new Set<string>()
  response.data = response.data.slice(0, 2048).filter((entry) => {
    const command = usableCommand(entry)
    if (command === undefined || names.has(command)) return false
    names.add(command)
    return true
  })
  return response
}

function usableCommand(value: unknown) {
  try {
    const item = object(value)
    const command = name(item.name)
    if (/[\s/\\]/.test(command)) return undefined
    clip(item, "template")
    if (item.description !== undefined) clip(item, "description", 64000)
    if (item.agent !== undefined) name(item.agent)
    if (item.model !== undefined) modelRef(item.model)
    if (item.subtask !== undefined && typeof item.subtask !== "boolean") return undefined
    return command
  } catch {
    return undefined
  }
}

export function files(value: unknown) {
  const response = object(value)
  location(response.location)
  for (const entry of array(response.data, 200)) {
    const item = object(entry)
    // Results become `file://` prompt attachments, so an absolute or escaping
    // path would address a file outside the requested location.
    const path = string(item.path, 4096)
    // oxlint-disable-next-line no-control-regex -- the control range is the point of this check
    if (!path || /[\u0000-\u001f\u007f-\u009f]/.test(path)) invalid("file path")
    if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) invalid("file path")
    if (path.split(/[\\/]/).includes("..")) invalid("file path")
    choice(item.type, ["file", "directory"])
  }
}
