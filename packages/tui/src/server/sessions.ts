import { ClientError } from "@turenlabs/client"
import { array, choice, identifier, invalid, isRecord, name, object, string } from "../response-validation"
import type { Context, Session, Todo } from "./context"
import { inputDirectory } from "./transport"

export type SessionSearch = { search?: string; archived?: boolean; directory?: string; cursor?: string }
export type SessionChange = { title: string } | { archived: number | null }

export async function searchSessions(ctx: Context, input: SessionSearch, signal?: AbortSignal) {
  if (input.search !== undefined && (typeof input.search !== "string" || input.search.length > 256))
    throw new Error("Use a title search of at most 256 characters.")
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096))
    throw new Error("Use a session cursor of at most 4,096 characters.")
  if (input.archived !== undefined && typeof input.archived !== "boolean")
    throw new Error("Choose an archived or unarchived session filter.")
  if (input.directory !== undefined) inputDirectory(input.directory)
  // Cursors already encode the original filters and traversal order.
  return ctx.client.sessions.list(
    input.cursor
      ? { cursor: input.cursor, limit: 100 }
      : { search: input.search, archived: input.archived, directory: input.directory, order: "desc", limit: 100 },
    { signal },
  )
}

export async function updateSession(ctx: Context, session: Session, change: SessionChange) {
  identifier(session.id, "ses_")
  inputDirectory(session.location.directory)
  checkChange(change)
  const address = new URL(`/session/${encodeURIComponent(session.id)}`, ctx.url)
  address.searchParams.set("directory", session.location.directory)
  const requestHeaders = new Headers(ctx.headers)
  requestHeaders.set("Content-Type", "application/json")
  const response = await ctx
    .transport(address, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify("title" in change ? { title: change.title } : { time: { archived: change.archived } }),
    })
    .catch((cause: unknown) => {
      throw new ClientError("Transport", { cause })
    })
  if (response.status === 200 && !response.body) invalid("session acknowledgement")
  await response.body?.cancel().catch(() => {})
  if (response.status === 401 || response.status === 403)
    throw new Error("Authentication required. Check the server credentials.")
  if (response.status !== 200) throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  // The validated bare legacy acknowledgement is not a current Session.
  const updated = await ctx.client.sessions.get({ sessionID: session.id })
  if (updated.location.directory !== session.location.directory) invalid("session directory identity")
  return updated
}

function checkChange(change: SessionChange) {
  if (!isRecord(change) || Object.keys(change).length !== 1) throw new Error("Choose one session change.")
  if ("title" in change) {
    if (typeof change.title !== "string" || !change.title.trim() || change.title.length > 200)
      throw new Error("Enter a title between 1 and 200 characters, without control characters.")
    try {
      name(change.title)
    } catch {
      throw new Error("Enter a title between 1 and 200 characters, without control characters.")
    }
  } else if (!("archived" in change) || (change.archived !== null && !Number.isFinite(change.archived))) {
    throw new Error("Use a finite archive timestamp, or null to restore the session.")
  }
}

export async function detail(ctx: Context, sessionID: string, cursor?: string) {
  identifier(sessionID, "ses_")
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 4096))
    throw new Error("Use a message cursor of at most 4,096 characters.")
  const [messages, tasks, permissions, questions, pending, todos] = await Promise.all([
    ctx.client.messages.list({ sessionID, limit: 30, order: cursor ? undefined : "desc", cursor: cursor || undefined }),
    ctx.client.sessions.taskList({ sessionID, limit: 50 }),
    ctx.client.permissions.list({ sessionID }),
    ctx.client.questions.list({ sessionID }),
    ctx.client.sessions.pendingInputs({ sessionID }),
    // The agent's to-do list is optional: an older server or a malformed list shows none.
    ctx
      .api(`/session/${encodeURIComponent(sessionID)}/todo`)
      .then(todoList)
      .catch(() => [] as Todo[]),
  ])
  return {
    sessionID,
    messages: messages.data.toReversed(),
    cursor: messages.cursor,
    tasks,
    permissions,
    questions,
    pending,
    todos,
  }
}

/** Deletes a session and its subagent sessions; the server interrupts their work first. */
export async function deleteSession(ctx: Context, session: Session) {
  identifier(session.id, "ses_")
  const result = await ctx.api(`/session/${encodeURIComponent(session.id)}`, {
    method: "DELETE",
    directory: session.location.directory,
    timeout: 30000,
  })
  if (result !== true) invalid("session deletion acknowledgement")
}

function todoList(value: unknown): Todo[] {
  return array(value, 500).map((item) => {
    const todo = object(item)
    choice(todo.status, ["pending", "in_progress", "completed", "cancelled"])
    return {
      content: string(todo.content, 4000),
      status: todo.status as Todo["status"],
      priority: string(todo.priority, 32),
    }
  })
}
