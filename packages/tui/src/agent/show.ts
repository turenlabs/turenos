import { interruptedLine } from "./failure"
import { transcript } from "../server"
import { clean, emit, indented, resumeLine, type Run } from "./context"
import { usage } from "./errors"
import { whole } from "./options"
import { requestsText } from "./requests"
import { activeIDs, endedState, getSession, idArgument, needsInput, pendingFor, stateOf, type Message } from "./state"

const maxMessages = 2000

export async function show(run: Run) {
  if (run.positionals.length !== 1) throw usage("Usage: turen-tui show <session> [--limit N] [--all] [--raw]")
  const sessionID = idArgument(run.positionals[0], "ses_", "The session")
  const limit = whole("limit", run.values.limit, 30, 1, 30)
  const session = await getSession(run.connection, sessionID)
  const [history, running, waiting] = await Promise.all([
    run.values.all ? everything(run, sessionID) : latest(run, sessionID, limit),
    activeIDs(run.connection),
    pendingFor(run.connection, sessionID),
  ])
  const state = stateOf(
    running.has(sessionID),
    waiting,
    running.has(sessionID) || needsInput(waiting) ? undefined : await endedState(run.connection, sessionID),
  )
  const note = history.truncated
    ? run.values.all
      ? `[showing the newest ${maxMessages} messages; older ones are omitted]`
      : "[earlier messages are not shown; use --all]"
    : ""
  const body = history.messages.length
    ? indented(
        [transcript(history.messages, run.values.raw), state === "interrupted" ? interruptedLine(history.messages) : ""]
          .filter(Boolean)
          .join("\n\n"),
      )
    : "(no messages)"
  const requests = requestsText(waiting, run.flags)
  return emit(
    run,
    {
      session: sessionID,
      sessionID,
      title: session.title,
      directory: session.location.directory,
      parentID: session.parentID ?? null,
      state,
      messages: history.messages,
      pending: waiting,
      truncated: history.truncated,
    },
    [
      `session ${sessionID} · ${state} · ${clean(session.title, 200)} · ${clean(session.location.directory, 1000)}`,
      "",
      ...(note ? [note] : []),
      body,
      ...(requests ? ["", requests] : []),
      ...(state === "failed" || state === "interrupted" ? ["", resumeLine(run, sessionID)] : []),
    ].join("\n"),
  )
}

async function latest(run: Run, sessionID: string, limit: number) {
  const page = await run.connection.client.messages.list({ sessionID, limit, order: "desc" })
  // The server hands out a next cursor even when nothing older exists, so one message past it confirms.
  const next = page.cursor.next
  const older = next ? await run.connection.client.messages.list({ sessionID, limit: 1, cursor: next }) : undefined
  return { messages: page.data.toReversed(), truncated: !!older?.data.length }
}

/** Follows the history cursor to the first message, oldest first, up to the cap. */
async function everything(run: Run, sessionID: string) {
  const pages: Message[][] = []
  const first = await run.connection.client.messages.list({ sessionID, limit: 30, order: "desc" })
  pages.push([...first.data])
  const more = await older(run, sessionID, first.cursor.next ?? undefined, pages, first.data.length)
  const newest = pages.flat()
  return { messages: newest.slice(0, maxMessages).toReversed(), truncated: more || newest.length > maxMessages }
}

/** Reads older pages into `pages`; true when history remains that was not read. */
async function older(
  run: Run,
  sessionID: string,
  cursor: string | undefined,
  pages: Message[][],
  count: number,
): Promise<boolean> {
  if (!cursor) return false
  if (count >= maxMessages) return true
  const page = await run.connection.client.messages.list({ sessionID, limit: 30, cursor })
  if (!page.data.length) return false
  pages.push([...page.data])
  // A cursor that repeats would loop forever; the dashboard stops on it too.
  return older(
    run,
    sessionID,
    page.cursor.next !== cursor ? (page.cursor.next ?? undefined) : undefined,
    pages,
    count + page.data.length,
  )
}
