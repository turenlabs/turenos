import type { Connection } from "../server"
import { transcript } from "../server"
import { emit, type Run } from "./context"
import { usage } from "./errors"
import { whole } from "./options"
import { requestsText } from "./requests"
import {
  activeIDs,
  getSession,
  idArgument,
  latestMessages,
  needsInput,
  pendingFor,
  type Message,
  type Pending,
} from "./state"

/** Where "after the sent message" starts: the sent message itself, or the newest message from before it was sent. */
export type Anchor = { messageID: string; baseline?: string }

export type Outcome =
  | { state: "idle"; messages: Message[] }
  | { state: "needs-input"; pending: Pending }
  | { state: "timeout" }

export const defaultTimeout = 600

export async function wait(run: Run) {
  if (run.positionals.length !== 1) throw usage("Usage: turen-tui wait <session> [--timeout S]")
  const sessionID = idArgument(run.positionals[0], "ses_", "The session")
  const timeout = whole("timeout", run.values.timeout, defaultTimeout, 0, 31_536_000)
  await getSession(run.connection, sessionID)
  return report(run, sessionID, await settle(run.connection, sessionID, { timeout }), timeout)
}

/**
 * Prints how a wait ended and returns its exit code: 0 idle, 3 needs input, 4 timeout. With no
 * anchor an idle result is the session's last assistant message.
 */
export function report(run: Run, sessionID: string, outcome: Outcome, timeout: number, sent?: { messageID: string }) {
  const id = sent ? { messageID: sent.messageID } : {}
  if (outcome.state === "needs-input")
    return emit(
      run,
      { session: sessionID, ...id, state: outcome.state, pending: outcome.pending },
      `session ${sessionID} · needs-input\n${requestsText(outcome.pending, run.flags)}`,
      3,
    )
  if (outcome.state === "timeout")
    return emit(
      run,
      { session: sessionID, ...id, state: outcome.state },
      `session ${sessionID} · timeout (still running after ${timeout}s; run turen-tui wait ${sessionID}${run.flags} to keep waiting)`,
      4,
    )
  const last = outcome.messages.findLast((message) => message.type === "assistant")
  const shown = sent ? outcome.messages : last ? [last] : []
  return emit(
    run,
    sent
      ? { session: sessionID, ...id, state: outcome.state, messages: outcome.messages }
      : { session: sessionID, state: outcome.state, message: last ?? null },
    [`session ${sessionID} · idle`, ...(shown.length ? ["", transcript(shown)] : [])].join("\n"),
  )
}

/**
 * Blocks until the session needs input, or is idle and (when anchored) has replied after the anchor.
 * The live event stream only wakes the loop early; the server bounds that stream and may drop events,
 * so every pass re-reads the session's state and the loop never sleeps longer than one second.
 */
export async function settle(
  connection: Connection,
  sessionID: string,
  input: { timeout: number; after?: Anchor },
): Promise<Outcome> {
  const controller = new AbortController()
  const wake = wakeups(connection, controller.signal)
  const deadline = input.timeout ? Date.now() + input.timeout * 1000 : Number.POSITIVE_INFINITY
  try {
    while (true) {
      const started = Date.now()
      const seen = await observe(connection, sessionID, input.after)
      if (seen) return seen
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { state: "timeout" }
      await wake(Math.min(1000, remaining))
      // Chatty event streams must not turn the loop into a busy poll.
      await Bun.sleep(Math.max(0, 250 - (Date.now() - started)))
    }
  } finally {
    controller.abort()
  }
}

async function observe(
  connection: Connection,
  sessionID: string,
  after: Anchor | undefined,
): Promise<Outcome | undefined> {
  // Read busy first: a session that finishes between the reads then shows as idle with a reply, never as idle too early.
  const running = (await activeIDs(connection)).has(sessionID)
  const pending = await pendingFor(connection, sessionID)
  if (needsInput(pending)) return { state: "needs-input", pending }
  if (running) return undefined
  const messages = await latestMessages(connection, sessionID)
  if (!after) return { state: "idle", messages }
  const reply = messagesAfter(messages, after)
  // Idle with no reply yet: the server may not have started the turn, or a queued message waits behind other work.
  return reply.some((message) => message.type === "assistant" || message.type === "shell")
    ? { state: "idle", messages: reply }
    : undefined
}

/** The messages after the anchor, by position: message IDs are random, so they do not sort. */
export function messagesAfter(messages: Message[], anchor: Anchor) {
  const sent = messages.findIndex((message) => message.id === anchor.messageID)
  // A shell command's own message is its result.
  if (sent >= 0) return messages.slice(messages[sent]!.type === "shell" ? sent : sent + 1)
  const base = anchor.baseline ? messages.findIndex((message) => message.id === anchor.baseline) : -1
  return messages.slice(base + 1)
}

/** A function that resolves after `ms`, or sooner when the server's event stream shows activity. */
function wakeups(connection: Connection, signal: AbortSignal) {
  const state: { woken: boolean; resolve?: () => void } = { woken: false }
  const poke = () => {
    state.woken = true
    state.resolve?.()
  }
  void listen(connection, signal, poke)
  return (ms: number) =>
    new Promise<void>((resolve) => {
      if (state.woken) {
        state.woken = false
        return resolve()
      }
      const done = () => {
        clearTimeout(timer)
        state.resolve = undefined
        state.woken = false
        resolve()
      }
      const timer = setTimeout(done, ms)
      state.resolve = done
    })
}

/** Pokes on every event. A stream that never delivers one, such as an older server's, ends the listener. */
async function listen(connection: Connection, signal: AbortSignal, poke: () => void): Promise<void> {
  const delivered = { any: false }
  try {
    for await (const _event of connection.events(signal)) {
      delivered.any = true
      poke()
    }
  } catch {
    // Polling carries the wait; a dropped stream only costs promptness.
  }
  if (!delivered.any || signal.aborted) return
  await Bun.sleep(1000)
  if (signal.aborted) return
  return listen(connection, signal, poke)
}
