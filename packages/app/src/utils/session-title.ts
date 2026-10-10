import { SessionTitle } from "@turenlabs/client/session-title"

export function sessionTitle(title?: string) {
  if (!title) return title
  const placeholder = SessionTitle.parsePlaceholder(title)
  if (!placeholder) return title
  return placeholder.kind === "new" ? "New session" : "Child session"
}
