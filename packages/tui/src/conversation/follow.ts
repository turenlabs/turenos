import type { MessagesListOutput } from "@turenlabs/client"
import type { Conversation } from "./context"
import { atBottom } from "./position"

const NEW_OUTPUT_CUE = "↓ new output below"
// End moves the cursor in the reply editor, where Page Down scrolls the transcript instead.
const cue = (c: Conversation) => `${NEW_OUTPUT_CUE} · ${c.state.modal?.composer ? "PgDn" : "End"}`

/** The reader just sent a message: the newest one is this client's own send and the cached window has not seen it. */
export function sentByReader(c: Conversation, messages: MessagesListOutput["data"]) {
  const cached = c.live.get(c.state.selected)
  const last = messages.at(-1)
  return (
    !!cached?.messages.length &&
    last?.type === "user" &&
    c.state.sentMessages.has(last.id) &&
    !cached.messages.some((item) => item.id === last.id)
  )
}

/** Notes that content changed under a reader who scrolled up, and says so on the context line. */
export function markUnread(c: Conversation, content: string) {
  const changed = c.drawn !== "" && content !== c.drawn
  c.drawn = content
  if (c.position?.scroll === Number.MAX_SAFE_INTEGER || atBottom(c)) return clearUnread(c)
  if (changed) c.unread = true
  if (c.unread && !c.ui.context.plainText.includes(NEW_OUTPUT_CUE))
    c.ui.context.content = `${c.ui.context.plainText} · ${cue(c)}`
}

export function clearUnread(c: Conversation) {
  if (!c.unread) return
  c.unread = false
  c.ui.context.content = c.ui.context.plainText.replace(/ · ↓ new output below · (End|PgDn)/, "")
}
