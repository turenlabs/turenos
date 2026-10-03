import { TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { errorText, type Session } from "../server"
import { label } from "../state"
import { color } from "../theme"
import { apply, done, still, title, type Action } from "./actions"
import type { HarnessContext } from "./context"
import { proposalText } from "./text"

export function confirm(ctx: HarnessContext, session: Session, action: Action, back: () => void) {
  const dialog = ctx.dialogs.open(`${title(action).split(":")[0]}?`, false, 34)
  if (!dialog) return
  dialog.recipient = session
  dialog.frame.add(
    new TextRenderable(ctx.renderer, {
      content:
        action.kind === "reject"
          ? "Confirm rejects this proposal; the active harness is unchanged."
          : action.kind === "reload" || action.kind === "rollback"
            ? "Confirm replaces the harness this session's agent runs with on its next turn."
            : "Confirm changes the tools and guidance this session's agent runs with on its next turn.",
      fg: action.kind === "reject" ? color.warning : color.error,
      height: 1,
      flexShrink: 0,
    }),
    0,
  )
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `For: ${label(session.title || session.id, 100)}\n\n${"proposal" in action ? proposalText(action.proposal) : action.kind === "rollback" ? `Restore snapshot v${action.version - 1} over v${action.version}.` : `Reload snapshot v${action.version} from its declared sources.`}`,
      fg: color.text,
    }),
  )
  dialog.error.content = "Ctrl+S confirms · Esc back; nothing changed yet."
  dialog.back = back
  dialog.key = (key) => matchesKey(key, "enter")
  // After an uncertain result, retries only read state: a repeated write could apply twice.
  let attempted = false
  dialog.submit = async () => {
    if (ctx.blocked(session.id)) throw new Error("Task-owned session: use its owning session. Nothing changed.")
    const harness = await ctx.connection.client.sessions.state({ sessionID: session.id })
    if (ctx.state.modal !== dialog) return
    if (done(action, harness)) {
      ctx.say(attempted ? "Harness change observed." : "Already done; nothing changed.")
      return
    }
    if (attempted) throw new Error("Outcome unconfirmed. Retry only rechecks; Esc to review the harness.")
    if (!still(action, harness)) throw new Error("The harness changed. Esc to review it again; nothing was sent.")
    attempted = true
    try {
      await apply(ctx.connection, session.id, action, harness)
    } catch (error) {
      throw new Error(`Outcome unconfirmed: ${errorText(error)}. Retry rechecks without resending.`)
    }
    ctx.say(completed(action))
  }
}

function completed(action: Action) {
  return action.kind === "reject"
    ? "Proposal rejected."
    : action.kind === "rollback"
      ? `Harness rolled back to v${action.version - 1}.`
      : action.kind === "reload"
        ? "Harness reloaded."
        : "Proposal applied. The agent uses it from its next turn."
}
