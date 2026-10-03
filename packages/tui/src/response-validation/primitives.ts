// Control characters and bidirectional overrides never belong in a name, path, or credential.
// oxlint-disable-next-line no-control-regex -- the control range is the point of this check
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/

export function invalid(field = "data"): never {
  throw new Error(`Invalid server response (${field}).`)
}

export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid("object expected")
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function array(value: unknown, maximum: number) {
  if (!Array.isArray(value)) invalid("array expected")
  if (value.length > maximum) invalid(`collection exceeds ${maximum} items`)
  return value as unknown[]
}

export function string(value: unknown, maximum = 1024 * 1024) {
  if (typeof value !== "string" || value.length > maximum) invalid("text")
  return value
}

export function name(value: unknown) {
  const result = string(value, 512)
  if (!result || UNSAFE_TEXT.test(result)) invalid("name")
  return result
}

export function identifier(value: unknown, prefix = "") {
  const result = string(value, 256)
  if (
    !result.startsWith(prefix) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result) ||
    result === "constructor" ||
    result === "prototype" ||
    result === "__proto__"
  )
    invalid("identifier")
  return result
}

export function numeric(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid("number")
  return value
}

export const sources = ["user", "subagent_board", "subagent_settle", "subagent_advisory", "shell_job", "swarm_room"]

export function choice(value: unknown, allowed: readonly string[]) {
  if (!allowed.includes(string(value, 64))) invalid("status")
}

export function optional(value: unknown, check: (value: unknown) => unknown) {
  if (value !== undefined && value !== null) check(value)
}

export function checkDirectory(value: unknown) {
  const path = string(value, 4096)
  if (
    !path ||
    UNSAFE_TEXT.test(path) ||
    !(path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path))
  )
    invalid("absolute directory")
}

export function location(value: unknown) {
  const item = object(value)
  checkDirectory(item.directory)
  optional(item.workspaceID, identifier)
}

export function modelRef(value: unknown) {
  const model = object(value)
  name(model.id)
  name(model.providerID)
  optional(model.variant, (value) => (value === "" ? "" : name(value)))
}

/** Checks every item, then rejects a repeated `id` within the collection. */
export function unique(items: unknown[], check: (value: unknown) => void) {
  const ids = new Set<string>()
  for (const item of items) {
    check(item)
    const id = name(object(item).id)
    if (ids.has(id)) invalid("duplicate identifier")
    ids.add(id)
  }
}

export function owner(value: unknown, sessionID: string) {
  if (identifier(value, "ses_") !== sessionID) invalid("session identity")
}
