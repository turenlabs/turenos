import { array, choice, numeric, object, optional, string } from "../response-validation"
import type { Detail } from "../server"

export type Mode = "git" | "branch" | "turn"
export type FileDiff = { file: string; patch?: string; additions: number; deletions: number; status?: string }

/** Files the agent changed since the newest prompt the user typed. */
export function turnFiles(messages: Detail["messages"]) {
  const start = messages.findLastIndex(
    (message) => message.type === "user" && (!message.source || message.source === "user"),
  )
  return [
    ...new Set(
      messages
        .slice(start + 1)
        .flatMap((message) => (message.type === "assistant" ? (message.snapshot?.files ?? []) : [])),
    ),
  ]
}

export function diffList(value: unknown): FileDiff[] {
  return array(value, 5000).flatMap((item) => {
    const entry = object(item)
    if (entry.file === undefined) return []
    optional(entry.status, (status) => choice(status, ["added", "deleted", "modified"]))
    const file = string(entry.file, 4096)
    // Paths go into the reply as `@path` and back to the server as relative queries; anything else is dropped.
    // oxlint-disable-next-line no-control-regex -- control characters are the point of this check
    if (
      !file ||
      file.startsWith("/") ||
      file.split(/[\\/]/).includes("..") ||
      /[\u0000-\u001f\u007f-\u009f]/.test(file)
    )
      return []
    return [
      {
        file,
        patch: entry.patch === undefined ? undefined : string(entry.patch),
        additions: numeric(entry.additions),
        deletions: numeric(entry.deletions),
        status: entry.status as string | undefined,
      },
    ]
  })
}
