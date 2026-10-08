import { array, choice, object, string } from "../response-validation"

export type Entry = { name: string; path: string; type: "file" | "directory"; ignored: boolean }

export function entryList(value: unknown): Entry[] {
  return array(value, 20000).map((item) => {
    const entry = object(item)
    choice(entry.type, ["file", "directory"])
    // The server appends one separator to folders. Preserve POSIX backslashes that belong to a name.
    const raw = string(entry.path, 4096)
    const path = entry.type === "directory" ? raw.replace(/[\\/]$/, "") : raw
    // Paths go back to the server as relative queries; an absolute or escaping one is not a listing entry.
    if (!path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))
      throw new Error("Invalid server response (file path).")
    return {
      name: string(entry.name, 1024),
      path,
      type: entry.type as Entry["type"],
      ignored: entry.ignored === true,
    }
  })
}
