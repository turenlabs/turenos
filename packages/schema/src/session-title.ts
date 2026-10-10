export * as SessionTitle from "./session-title"

// The stand-in name a session gets until someone names it. Clients read it to show the session's
// creation time instead of the raw ISO string. No imports: `@turenlabs/client/session-title`
// re-exports this for clients that do not load `effect`.

const PREFIX = { new: "New session - ", child: "Child session - " }
const PLACEHOLDER = /^(New|Child) session - (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/

/** The stand-in name for a session created at `at` (epoch milliseconds). */
export const placeholder = (kind: "new" | "child", at: number) => `${PREFIX[kind]}${new Date(at).toISOString()}`

/**
 * The kind and creation time a placeholder name records, or undefined for any other title. `at` is
 * NaN when the timestamp has the placeholder's shape but names no real time.
 */
export function parsePlaceholder(title: string) {
  const match = PLACEHOLDER.exec(title)
  if (!match) return undefined
  return { kind: match[1] === "Child" ? ("child" as const) : ("new" as const), at: Date.parse(match[2]!) }
}
