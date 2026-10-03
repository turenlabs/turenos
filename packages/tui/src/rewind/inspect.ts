import type { MessagesListOutput } from "@turenlabs/client"
import { errorText } from "../server"
import { fresh, owned, type RewindFlow } from "./flow"
import { addConfirmation, previewText } from "./view"

type Message = MessagesListOutput["data"][number]

const real = (message: Message) => message.type === "user" && (!message.source || message.source === "user")

/** Read-only inspection: finds the prompt to undo/redo, then reveals the typed confirmation. */
export async function load(flow: RewindFlow) {
  if (flow.loading || flow.ready || flow.attempted) return
  flow.loading = true
  flow.target = undefined
  flow.previous = undefined
  try {
    await fresh(flow, true)
    if (flow.action === "redo" && !flow.session.revert) throw new Error("Nothing staged to redo.")
    await scanMessages(flow)
    if (flow.session.revert && !flow.previous)
      throw new Error("Staged boundary is outside the bounded 300-message window. Nothing changed.")
    if (flow.action === "undo" && !flow.target)
      throw new Error("No earlier user prompt in the bounded 300-message window. Nothing changed.")
    await fresh(flow, true)
    flow.preview.content = previewText(flow)
    addConfirmation(flow)
  } catch (error) {
    if (flow.state.closed || flow.state.modal !== flow.dialog) return
    flow.preview.content = `Cannot inspect rewind: ${errorText(error)}`
    flow.dialog.error.content = "Read-only; nothing changed. Ctrl+R retry / Esc close"
  } finally {
    flow.loading = false
  }
}

async function scanMessages(flow: RewindFlow) {
  const messages: Message[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  // The API's descending cursor traversal is sequence order, not UUID order.
  for (let page = 0; page < 10; page++) {
    const result = await flow.connection.client.messages.list({
      sessionID: flow.session.id,
      limit: 30,
      order: cursor ? undefined : "desc",
      cursor,
    })
    owned(flow)
    if (result.data.length > 30)
      throw new Error("Server exceeded the 30-message inspection page limit. Nothing changed.")
    for (const message of result.data) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      messages.push(message)
    }
    if (settle(flow, messages)) break
    const next = result.cursor.next
    if (!next || cursors.has(next)) break
    cursors.add(next)
    cursor = next
  }
}

/** Looks for the staged boundary and the prompt to act on in the messages gathered so far; true ends the scan. */
function settle(flow: RewindFlow, messages: Message[]) {
  const revert = flow.session.revert
  const position = revert ? messages.findIndex((item) => item.id === revert.messageID) : -1
  if (revert && position >= 0) {
    const at = messages[position]!
    if (!real(at) || at.type !== "user")
      throw new Error("Staged boundary is not a user prompt. Close and inspect this session.")
    flow.previous = { id: at.id, text: at.text }
    const choice =
      flow.action === "undo" ? messages.slice(position + 1).find(real) : messages.slice(0, position).findLast(real)
    if (choice?.type === "user") flow.target = { id: choice.id, text: choice.text }
    return !!flow.target || flow.action === "redo"
  }
  if (revert) return false
  const choice = messages.find(real)
  if (choice?.type === "user") flow.target = { id: choice.id, text: choice.text }
  return !!flow.target
}
