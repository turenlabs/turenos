import { maxMessageLength } from "../requests/context"
import { mentionReport } from "../prompt-files"
import { errorText, refused } from "../server"
import { emit, quote, type Run } from "./context"
import { AgentError, usage } from "./errors"
import { report, settle, type Anchor } from "./wait"

export type Sent = {
  sessionID: string
  messageID: string
  delivery: "steer" | "queue"
  created: boolean
  timeout: number
  baseline?: string
}

export function newID(prefix: "ses_" | "msg_") {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`
}

/** The message text from the argument, or from stdin for `-` or no argument. */
export async function messageText(run: Run, given: string | undefined) {
  if (given !== undefined && given !== "-") return checkedText(given)
  if (run.io.stdin.tty) throw usage("Give the message as an argument, or pipe it on stdin (use - to read stdin).")
  return checkedText((await run.io.stdin.read()).replace(/\s+$/, ""))
}

function checkedText(text: string) {
  if (!text.trim() || text.length > maxMessageLength) throw usage("Enter a message between 1 and 32,000 characters.")
  return text
}

/** A mention that leaves the session directory needs a deliberate flag, as the dashboard needs a second send. */
export function checkOutside(run: Run, text: string, directory: string) {
  const outside = mentionReport(text, directory).outside
  if (!outside.length || run.values["allow-outside"]) return
  throw usage(
    `This attaches files outside ${directory}: ${outside.join(" ")}. Edit the mention, or add --allow-outside to attach them.`,
  )
}

/** Reports an admitted message, waiting for the reply when --wait was given. */
export async function finish(run: Run, sent: Sent) {
  if (!run.values.wait)
    return emit(
      run,
      {
        session: sent.sessionID,
        messageID: sent.messageID,
        state: "sent",
        delivery: sent.delivery,
        created: sent.created,
      },
      sent.created
        ? `started session ${sent.sessionID} with message ${sent.messageID}`
        : `sent message ${sent.messageID} to session ${sent.sessionID} (${sent.delivery})`,
    )
  const after: Anchor = { messageID: sent.messageID, baseline: sent.baseline, queued: sent.delivery === "queue" }
  const outcome = await settle(run.connection, sent.sessionID, { timeout: sent.timeout, after }).catch(
    (error: unknown) => {
      // The message is on the server; only the wait failed, so the caller must not send it again.
      throw new AgentError(
        `Message ${sent.messageID} was sent to session ${sent.sessionID}, but waiting for the reply failed: ${errorText(error).replace(/\.$/, "")}. Resume with: turen-tui wait ${sent.sessionID}${run.flags}`,
        1,
        undefined,
        { session: sent.sessionID, messageID: sent.messageID, state: "sent" },
      )
    },
  )
  return report(run, sent.sessionID, outcome, sent.timeout, { messageID: sent.messageID })
}

/** Turns a failed write into the report the spec asks for: refused means nothing was sent, anything else is unknown. */
export function writeFailure(error: unknown, ids: { sessionID: string; messageID: string }, retry: string) {
  const reason = errorText(error)
  if (refused(error))
    return new AgentError(`The server refused the message (${reason.replace(/\.$/, "")}). Nothing was sent.`)
  return new AgentError(
    `Outcome unknown: ${reason.replace(/\.$/, "")}. Retry with the same ID so it cannot be sent twice: ${retry}`,
    1,
    { id: ids.messageID, sessionID: ids.sessionID },
  )
}

export function retryCommand(run: Run, parts: string) {
  const options = [
    run.values.queue ? " --queue" : "",
    run.values.wait ? " --wait" : "",
    run.values.timeout ? ` --timeout ${quote(run.values.timeout)}` : "",
  ]
  return `turen-tui send${parts}${options.join("")}${run.flags} <same text and options>`
}
