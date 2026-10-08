import { ClientError } from "@turenlabs/client"
import type { Connection } from "../server"
import { httpStatus, transcript } from "../server"
import { emit, indented, type Run } from "./context"
import { AgentError, usage } from "./errors"
import { whole } from "./options"
import { turnFailure } from "./failure"
import { requestsText } from "./requests"
import {
  activeIDs,
  activeTaskStatuses,
  getSession,
  idArgument,
  inBatches,
  latestMessages,
  needsInput,
  pendingFor,
  type Message,
  type Pending,
} from "./state"

/** Where "after the sent message" starts: the sent message itself, or the newest message from before it was sent. */
export type Anchor = { messageID: string; baseline?: string; queued?: boolean }

export type Outcome =
  | { state: "idle"; messages: Message[] }
  | { state: "needs-input"; pending: Pending }
  | { state: "timeout" }

export const defaultTimeout = 600

export async function wait(run: Run) {
  if (run.positionals.length !== 1) throw usage("Usage: turen-tui wait <session> [--timeout S]")
  const sessionID = idArgument(run.positionals[0], "ses_", "The session")
  const timeout = whole("timeout", run.values.timeout, defaultTimeout, 0, 31_536_000)
  await patiently(timeout, () => getSession(run.connection, sessionID))
  return report(run, sessionID, await settle(run.connection, sessionID, { timeout }), timeout)
}

/**
 * Prints how a wait ended and returns its exit code: 0 idle, 3 needs input, 4 timeout, 5 idle after a failed or interrupted turn. With no
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
  const failure = turnFailure(outcome.messages)
  const state = failure?.state ?? outcome.state
  const error = failure ? { error: failure.text } : {}
  return emit(
    run,
    sent
      ? { session: sessionID, ...id, state, ...error, messages: outcome.messages }
      : { session: sessionID, state, ...error, message: last ?? null },
    [
      `session ${sessionID} · ${state}`,
      ...(failure ? [failure.text] : []),
      ...(shown.length ? ["", indented(transcript(shown))] : []),
    ].join("\n"),
    failure ? 5 : 0,
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
  const failed = { passes: 0 }
  try {
    while (true) {
      const started = Date.now()
      const seen = await observe(connection, sessionID, input.after).then(
        (outcome) => {
          failed.passes = 0
          return outcome
        },
        (error: unknown) => {
          if (httpStatus(error) === 404) throw new AgentError(`Session ${sessionID} was deleted while waiting.`)
          if (!transient(error)) throw error
          failed.passes++
          return undefined
        },
      )
      if (seen) return seen
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { state: "timeout" }
      // After a failed pass the next waits longer, up to five seconds, so a restarting server is not hammered.
      await wake(Math.min(failed.passes ? retryDelay(failed.passes) : 1000, remaining))
      // Chatty event streams must not turn the loop into a busy poll.
      await Bun.sleep(Math.max(0, 250 - (Date.now() - started)))
    }
  } finally {
    controller.abort()
  }
}

/** The wait after the `passes`-th consecutive failure: 2, 4, then 5 seconds, so a restarting server is not hammered. */
function retryDelay(passes: number) {
  return Math.min(1000 * 2 ** passes, 5000)
}

/**
 * Runs `request`, trying again on the same schedule as the wait loop while the server is unreachable or
 * failing, until the timeout (0 never gives up). A definite answer, such as a refused login or an unknown
 * session, and the last failure at the deadline, are thrown as they are.
 */
async function patiently<Value>(timeout: number, request: () => Promise<Value>) {
  const deadline = timeout ? Date.now() + timeout * 1000 : Number.POSITIVE_INFINITY
  for (let passes = 1; ; passes++) {
    const result = await request().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    if ("value" in result) return result.value
    const remaining = deadline - Date.now()
    if (!transient(result.error) || remaining <= 0) throw result.error
    await Bun.sleep(Math.min(retryDelay(passes), remaining))
  }
}

/** A failure the next pass may not see: a transport error or timeout, a 5xx, or a 408 or 409. */
function transient(error: unknown) {
  const status = httpStatus(error)
  if (status !== undefined) return status >= 500 || status === 408 || status === 409
  return error instanceof ClientError && error.reason === "Transport"
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
  // A session cannot finish while a subagent it started waits for input, so that input is what to report.
  if (running) return subagentInput(connection, sessionID)
  // A queued message the agent has not read yet is still waiting, although the session reads idle between turns.
  if (after?.queued && (await stillQueued(connection, sessionID, after.messageID))) return undefined
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

/** Pending requests of the session's active subagents; their commands name the child session. */
async function subagentInput(connection: Connection, sessionID: string): Promise<Outcome | undefined> {
  // A server without the task route has no subagents to ask about.
  const tasks = await connection.client.sessions.taskList({ sessionID, limit: 50 }).catch(() => undefined)
  if (!tasks) return undefined
  const children = [...tasks.data, ...tasks.active]
    .filter((task) => activeTaskStatuses.includes(task.status))
    .map((task) => task.childSessionID)
  const found = await inBatches([...new Set(children)], 8, (child) => pendingFor(connection, child))
  const pending = {
    permissions: found.flatMap((item) => item.permissions),
    questions: found.flatMap((item) => item.questions),
  }
  return needsInput(pending) ? { state: "needs-input", pending } : undefined
}

async function stillQueued(connection: Connection, sessionID: string, messageID: string) {
  const inputs = await connection.client.sessions.pendingInputs({ sessionID }).catch((error: unknown) => {
    // An older server without the route cannot say; the reply check still applies.
    if (httpStatus(error) === 404) return []
    throw error
  })
  return inputs.some((input) => input.id === messageID)
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
