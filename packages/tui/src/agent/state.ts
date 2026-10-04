import type { MessagesListOutput, PermissionsListOutput, QuestionsListOutput } from "@turenlabs/client"
import { identifier } from "../response-validation"
import { httpStatus, type Connection } from "../server"
import { AgentError, usage } from "./errors"

export type State = "running" | "needs-input" | "idle"
export type Pending = { permissions: PermissionsListOutput; questions: QuestionsListOutput }
export type Message = MessagesListOutput["data"][number]

export function needsInput(pending: Pending) {
  return pending.permissions.length + pending.questions.length > 0
}

export function stateOf(running: boolean, pending: Pending): State {
  if (needsInput(pending)) return "needs-input"
  return running ? "running" : "idle"
}

/** A session ID or message ID argument; the value is never echoed back. */
export function idArgument(value: string | undefined, prefix: string, label: string) {
  try {
    return identifier(value, prefix)
  } catch {
    throw usage(`${label} must be an ID starting with ${prefix}.`)
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
export async function inBatches<Item, Result>(items: Item[], size: number, task: (item: Item) => Promise<Result>) {
  const results: Result[] = []
  for (let offset = 0; offset < items.length; offset += size)
    results.push(...(await Promise.all(items.slice(offset, offset + size).map(task))))
  return results
}

export async function getSession(connection: Connection, sessionID: string) {
  return connection.client.sessions.get({ sessionID }).catch((error: unknown) => {
    if (httpStatus(error) === 404) throw new AgentError(`No session ${sessionID} on this server.`)
    throw error
  })
}

/** The newest `limit` messages, oldest first. */
export async function latestMessages(connection: Connection, sessionID: string, limit = 30) {
  const page = await connection.client.messages.list({ sessionID, limit, order: "desc" })
  return page.data.toReversed()
}
