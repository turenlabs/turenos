import { checkDirectory, isRecord } from "../response-validation"

export const scope = "desktop/store/working-folders"
export const key = "open"
export const limit = 1024 * 1024

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
    value.directories.length > 256
  )
    invalid()
  for (const directory of value.directories) checkDirectory(directory)
  if (new Set(value.directories).size !== value.directories.length) invalid()
  return [...value.directories] as string[]
}

export function state(value: unknown): State {
  if (!isRecord(value) || value.scope !== scope || value.key !== key || typeof value.value !== "string") invalid()
  for (const field of [value.revision, value.timeCreated, value.timeUpdated]) {
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) invalid()
  }
  if (Buffer.byteLength(value.value, "utf8") > limit) invalid()
  return { revision: value.revision as number, directories: directories(JSON.parse(value.value)) }
}
