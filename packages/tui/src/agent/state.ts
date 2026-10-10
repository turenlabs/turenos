import type { MessagesListOutput, PermissionsListOutput, QuestionsListOutput } from "@turenlabs/client"
import { identifier } from "../response-validation"
import { httpStatus, type Connection } from "../server"
import { AgentError, usage } from "./errors"
import { turnFailure } from "./failure"

export type State = "running" | "needs-input" | "idle" | "failed" | "interrupted"
export type Pending = { permissions: PermissionsListOutput; questions: QuestionsListOutput }
export type Message = MessagesListOutput["data"][number]

/** A task that is still working, so its child session may be waiting for input or worth cancelling. */
export const activeTaskStatuses: readonly string[] = ["queued", "starting", "running"]

export function needsInput(pending: Pending) {
  return pending.permissions.length + pending.questions.length > 0
}

export function stateOf(running: boolean, pending: Pending, ended?: State): State {
  if (needsInput(pending)) return "needs-input"
  if (running) return "running"
  return ended ?? "idle"
}

/**
 * `failed` or `interrupted` when a session that is not running ended its latest turn in error, as `wait` reports it, else `idle`.
 * A few messages reach back past the system and switch messages that can follow the turn's assistant message.
 */
export async function endedState(connection: Connection, sessionID: string): Promise<State> {
  const messages = await latestMessages(connection, sessionID, 8).catch((error: unknown) => {
    if (httpStatus(error) === 404) return []
    throw error
  })
  return turnFailure(messages)?.state ?? "idle"
}

/** What each ID prefix names, so an ID passed where another kind belongs points at the right place. */
const kinds = [
  ["ses_", "a session ID"],
  ["msg_", "a message ID"],
  ["per_", "a permission ID; use turen-tui approve"],
  ["que_", "a question ID; use turen-tui answer"],
  ["trm_", "a room ID; use turen-tui team show"],
] as const

/** A session ID or message ID argument; only a known prefix of the value is echoed back. */
export function idArgument(value: string | undefined, prefix: string, label: string) {
  try {
    return identifier(value, prefix)
  } catch {
    const other = kinds.find(([known]) => known !== prefix && value?.startsWith(known))
    throw usage(`${label} must be an ID starting with ${prefix}${other ? ` (${other[0]} is ${other[1]})` : ""}.`)
  }
}

/** The running sessions' IDs. */
export async function activeIDs(connection: Connection) {
  return new Set(Object.keys(await connection.client.sessions.active()))
}

/** Pending permissions and questions for one session; a session deleted meanwhile has none. */
export async function pendingFor(connection: Connection, sessionID: string): Promise<Pending> {
  const [permissions, questions] = await Promise.all([
    connection.client.permissions.list({ sessionID }),
    connection.client.questions.list({ sessionID }),
  ]).catch((error: unknown) => {
    if (httpStatus(error) === 404) return [[], []] as const
    throw error
  })
  return { permissions, questions }
}

/** Runs `task` over `items`, at most `size` at a time, keeping order. */
export async function inBatches<Item, Result>(
  items: readonly Item[],
  size: number,
  task: (item: Item) => Promise<Result>,
) {
  const results: Result[] = []
  for (let offset = 0; offset < items.length; offset += size)
    results.push(...(await Promise.all(items.slice(offset, offset + size).map(task))))
  return results
}

/** A catch handler that turns the server's 404 for a session into the message every command shares. */
export function sessionGone(sessionID: string) {
  return (error: unknown): never => {
    if (httpStatus(error) === 404) throw new AgentError(`No session ${sessionID} on this server.`)
    throw error
  }
}

export async function getSession(connection: Connection, sessionID: string) {
  return connection.client.sessions.get({ sessionID }).catch(sessionGone(sessionID))
}

/** The newest `limit` messages, oldest first. */
export async function latestMessages(connection: Connection, sessionID: string, limit = 30) {
  const page = await connection.client.messages.list({ sessionID, limit, order: "desc" })
  return page.data.toReversed()
}
