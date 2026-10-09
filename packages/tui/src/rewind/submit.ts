import { clause } from "../messages"
import { errorText, refused } from "../server"
import { fresh, owned, type RewindFlow } from "./flow"
import { boundary, hasFiles } from "./session"

type Intent = NonNullable<RewindFlow["intent"]>

export async function submit(flow: RewindFlow) {
  owned(flow)
  const intent = prepareIntent(flow)
  if (!flow.attempted) await writeOnce(flow, intent)
  const updated = await fresh(flow, false)
  if (intent.messageID && intent.files && !flow.hasAcknowledgement)
    throw new Error(
      "File restoration is unconfirmed after the lost response. No write will be repeated; close and inspect the session and files.",
    )
  const matches = intent.messageID
    ? updated.revert?.messageID === intent.messageID && (!intent.files ? !hasFiles(updated.revert) : true)
    : !updated.revert
  if (
    !matches ||
    (flow.hasAcknowledgement && intent.messageID && boundary(updated.revert) !== boundary(flow.acknowledged))
  )
    throw new Error(
      "Outcome is not confirmed. Retry only checks GET; no write will be repeated. Close and inspect this session.",
    )
  flow.hooks.changed(updated)
  if (flow.action === "undo" && flow.target) {
    const restored = flow.hooks.restoreDraft(updated, flow.target.id, flow.target.text)
    flow.say(
      `Undo confirmed. ${restored ? "Prompt restored as a draft; nothing sent." : "Existing draft kept; nothing sent."}`,
    )
    return
  }
  if (flow.previous) flow.hooks.clearRestoredDraft(flow.session.id, flow.previous.id, flow.previous.text)
  flow.say("Redo confirmed. Ordinary reply drafts are unchanged; nothing sent.")
}

/** Validates the typed confirmation and freezes the file mode and target on the first submit. */
function prepareIntent(flow: RewindFlow): Intent {
  if (!flow.ready || !flow.confirmation) throw new Error("Wait for read-only inspection to finish successfully.")
  if (flow.intent && flow.action === "undo" && (flow.files?.getSelectedIndex() === 1) !== flow.intent.files)
    throw new Error("Retry keeps the original file mode. Close and reopen this control to change it.")
  if (!flow.intent) {
    const withFiles = flow.action === "undo" ? flow.files?.getSelectedIndex() === 1 : hasFiles(flow.session.revert)
    if (!withFiles && hasFiles(flow.session.revert))
      throw new Error("An existing file undo would restore files. Redo first or select Conversation + files.")
    flow.intent = { messageID: flow.target?.id, files: withFiles }
  }
  if (!flow.attempted && flow.action === "undo" && (flow.files?.getSelectedIndex() === 1) !== flow.intent.files)
    throw new Error("Retry with the original file mode, or close and inspect this session.")
  return flow.intent
}

/** The single write attempt: after it starts, retries are GET-only even if the response is lost. */
async function writeOnce(flow: RewindFlow, intent: Intent) {
  const sessionID = flow.session.id
  const sessions = flow.connection.client.sessions
  await fresh(flow, true)
  await sessions.interrupt({ sessionID })
  owned(flow)
  await fresh(flow, true)
  // From this point onward, retries are GET-only, even if the response is lost.
  flow.attempted = true
  try {
    if (intent.messageID) {
      flow.acknowledged = await sessions.stage({ sessionID, messageID: intent.messageID, files: intent.files })
    } else {
      await sessions.clear({ sessionID })
    }
    flow.hasAcknowledgement = true
  } catch (error) {
    // A definite 4xx admitted nothing, so the file mode and target unfreeze.
    if (refused(error)) {
      flow.attempted = false
      flow.intent = undefined
      throw new Error(`Rejected by the server: ${clause(errorText(error))}. Nothing changed; retry to try again.`)
    }
    throw new Error(
      `Outcome unknown: ${errorText(error)} Retry checks GET only; no write will be repeated. Close and inspect this session if unconfirmed.`,
    )
  }
}
