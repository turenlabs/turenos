import { UNSAFE_TEXT } from "../unsafe-text"
import { pathKey } from "../path-key"

export const scope = "desktop/store/working-folders"
export const key = "open"
export const limit = 1024 * 1024
export const maxFolders = 256

export type State = { revision: number; directories: string[] }

export function invalid(): never {
  throw new Error("Invalid working folders returned by the server.")
}

export function directories(value: unknown): string[] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.directories) ||
    value.directories.length > maxFolders
  )
    invalid()
  for (const directory of value.directories) checkDirectory(directory)
  if (new Set(value.directories).size !== value.directories.length) invalid()
  // Older TUI versions compared strings literally; equivalent drive spellings
  // remain readable and converge to one entry on the next membership change.
  return [...new Map((value.directories as string[]).map((directory) => [pathKey(directory), directory])).values()]
}

export function state(value: unknown): State {
  if (!isRecord(value) || value.scope !== scope || value.key !== key || typeof value.value !== "string") invalid()
  for (const field of [value.revision, value.timeCreated, value.timeUpdated]) {
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) invalid()
  }
  if (new TextEncoder().encode(value.value).byteLength > limit) invalid()
  return { revision: value.revision as number, directories: directories(JSON.parse(value.value)) }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    value.length <= 4096 &&
    !UNSAFE_TEXT.test(value) &&
    (value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value))
  )
}

export function checkDirectory(value: unknown): asserts value is string {
  if (!isDirectory(value)) invalid()
}
