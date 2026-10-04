import type { Run } from "./context"
import { usage } from "./errors"
import { checkOutside, finish, messageText, retryCommand, writeFailure } from "./delivery"
import { takes } from "./options"
import { refused } from "../server"
import { idArgument } from "./state"
import { validDirectory } from "./sessions"

/** `send --new`: starts a session and sends its first message under frozen IDs, so a retry cannot duplicate it. */
export async function startSession(run: Run, timeout: number) {
  const values = run.values
  if (values.queue) throw usage("--queue applies to a session that already exists; it cannot be used with --new.")
  const text = await messageText(run, takes("send --new", run.positionals, [], ["text"])[0])
  const ids = {
    sessionID:
      values["session-id"] !== undefined ? idArgument(values["session-id"], "ses_", "--session-id") : undefined,
    messageID: values.id !== undefined ? idArgument(values.id, "msg_", "--id") : undefined,
  }
  const directory = values.dir ?? (await run.connection.client.location.get({})).directory
  validDirectory(directory)
  // A slash command's arguments are not file mentions.
  if (!text.startsWith("/")) checkOutside(run, text, directory)
  const launcher = run.connection.launch(ids)
  const session = await launcher({
    directory,
    agent: values.agent,
    model: values.model,
    variant: values.variant,
    prompt: text,
  }).catch((error: unknown) => {
    // Once the launch froze its fields, bytes may have gone out; before that nothing was sent.
    if (!refused(error) && !launcher.input()) throw error
    throw writeFailure(
      error,
      launcher,
      retryCommand(run, ` --new --session-id ${launcher.sessionID} --id ${launcher.messageID}`),
    )
  })
  return finish(run, {
    sessionID: session.id,
    messageID: launcher.messageID,
    delivery: "steer",
    created: true,
    timeout,
  })
}
